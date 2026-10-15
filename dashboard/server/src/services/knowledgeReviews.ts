import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import type {
  KnowledgeBriefAudience,
  KnowledgeDecisionAnswer,
  KnowledgeFindingPriority,
  KnowledgeFindingPriorityCounts,
  KnowledgeOpenFinding,
  KnowledgeOpenFindingsResponse,
  KnowledgeRecheckBrief,
  KnowledgeReviewFinding,
  KnowledgeReviewDetail,
  KnowledgeReviewsResponse,
  KnowledgeReviewSummary,
  KnowledgeHumanDecision,
} from '@shared/types';
import { HumanDecisionStore, attachDecisions, latestDecisions, validateDecision } from './knowledgeDecisions';

export const KNOWLEDGE_REVIEW_ID_PATTERN = /^KLR-[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]*$/;

const execFileAsync = promisify(execFile);
const VALIDATION_CONCURRENCY = 4;

type CanonicalValidatorResponse =
  | { valid: true; review: KnowledgeReviewDetail }
  | { valid: false; errors: string[] };

class InvalidKnowledgeReviewError extends Error {}

type LoadedReview = { file: string; review: KnowledgeReviewDetail };
type InvalidReview = { file: string; errors: string[] };
type LoadAllResult = { reviews: KnowledgeReviewDetail[]; invalidFiles: string[]; invalid: InvalidReview[] };
type CachedReview = {
  fileSignature: string;
  policySignature: string | null;
  review: KnowledgeReviewDetail;
};
type CachedInvalid = { fileSignature: string; errors: string[] };

/**
 * Validation results survive a server restart (each file costs a Ruby run, ~6s for
 * 327 audits). Keyed like the in-memory cache: the file's size+mtime, the policy file
 * for auto-write audits, and the validator + schema signature for the whole file.
 * Lives in a subfolder: the loader reads every *.yaml directly under knowledge-reviews/.
 */
export const VALIDATION_CACHE_VERSION = 1;
type DiskCache = {
  version: number;
  contractSignature: string;
  reviews: Record<string, CachedReview>;
  invalid: Record<string, CachedInvalid>;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseValidatorResponse(source: string): CanonicalValidatorResponse {
  const result: unknown = JSON.parse(source);
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { valid?: unknown }).valid !== 'boolean') {
    throw new Error('canonical knowledge review validator returned an invalid response');
  }
  return result as CanonicalValidatorResponse;
}

async function loadCanonicalReview(
  filePath: string,
  validatorPath: string,
  workspaceRoot?: string,
): Promise<KnowledgeReviewDetail> {
  const env = workspaceRoot
    ? { ...process.env, AI_OFFICE_REPO_ROOT: workspaceRoot }
    : process.env;

  try {
    const { stdout } = await execFileAsync('ruby', [validatorPath, '--json', filePath], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    const response = parseValidatorResponse(stdout);
    if (!response.valid || !response.review || typeof response.review !== 'object') {
      throw new Error('canonical knowledge review validator omitted the normalized review');
    }
    return response.review;
  } catch (error) {
    const processError = error as { code?: unknown; stdout?: unknown };
    if (processError.code === 1 && typeof processError.stdout === 'string' && processError.stdout) {
      const response = parseValidatorResponse(processError.stdout);
      if (!response.valid && Array.isArray(response.errors)) {
        throw new InvalidKnowledgeReviewError(response.errors.join('; '));
      }
    }
    throw error;
  }
}

function countPriorities(findings: KnowledgeReviewDetail['findings']): KnowledgeFindingPriorityCounts {
  const counts: KnowledgeFindingPriorityCounts = {};
  for (const finding of findings) {
    counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
  }
  return counts;
}

function toSummary(review: KnowledgeReviewDetail): KnowledgeReviewSummary {
  const { authorization: _authorization, notesReviewed: _notesReviewed, findings, changes: _changes, ...summary } = review;
  return { ...summary, priorityCounts: countPriorities(findings) };
}

const PRIORITY_RANK: Record<KnowledgeFindingPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// A closure criterion that names a human actor doing the closing act. Kept as a
// fixed vocabulary (seen in the audits) rather than a general text guess.
const HUMAN_ACTOR_ACT = /\b(?:human|operator|credential owner|product owner|owning coordinator|separately scoped owner)\s+(?:applies|rejects|declines|decides|evaluates|assigns|selects|confirms|corrects|records|revokes|determines|completes|accepts|updates)\b/i;

/**
 * Only a human can close it (knowledge-base/AGENTS.md: product or architecture
 * choices stay open). The rule is explicit and uses contracted fields only:
 * - append_review_queue with a human-decision fingerprint or an "A human…" /
 *   "human-approved" closure criterion (D4, 2026-10-15);
 * - no_change whose closure criterion names a human actor and act, e.g.
 *   "Human applies or rejects…", "The credential owner revokes…"
 *   (D4 widened 2026-10-15 after the first run re-selected such findings).
 */
export function needsHumanDecision(finding: Pick<KnowledgeReviewFinding, 'recommendedAction' | 'fingerprint' | 'closureCriteria'>): boolean {
  const closure = finding.closureCriteria.trim();
  if (finding.recommendedAction === 'append_review_queue') {
    return /human-decision/.test(finding.fingerprint)
      || /^A human\b/i.test(closure)
      || /human-approved/i.test(closure);
  }
  if (finding.recommendedAction === 'no_change') return HUMAN_ACTOR_ACT.test(closure);
  return false;
}

/** The vault is addressed both as `Knowledge Base/…` and `knowledge-base/Knowledge Base/…`. */
export function normalizeNotePath(notePath: string): string {
  return notePath.replace(/^knowledge-base\/(?=Knowledge Base\/)/, '');
}

/** Up to two directory levels under `Knowledge Base/` (or under the repo for other paths). */
export function noteFolder(notePath: string): string {
  const dirs = normalizeNotePath(notePath).split('/').slice(0, -1);
  if (dirs[0] === 'Knowledge Base') return dirs.length > 1 ? dirs.slice(1, 3).join('/') : 'Knowledge Base';
  return dirs.length ? dirs.slice(0, 2).join('/') : '(no folder)';
}

/**
 * Open findings across audits: each fingerprint takes the status of the latest
 * audit that reported it (contracted fields only: fingerprint, status, priority).
 */
export function buildOpenFindings(reviews: KnowledgeReviewDetail[]): KnowledgeOpenFindingsResponse {
  const byFingerprint = new Map<string, { latest: KnowledgeOpenFinding; count: number; first: string }>();
  const chronological = [...reviews].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.reviewId.localeCompare(b.reviewId));
  for (const review of chronological) {
    for (const finding of review.findings) {
      const prior = byFingerprint.get(finding.fingerprint);
      byFingerprint.set(finding.fingerprint, {
        count: (prior?.count ?? 0) + 1,
        first: prior?.first ?? review.generatedAt,
        latest: {
          fingerprint: finding.fingerprint,
          notePath: normalizeNotePath(finding.notePath),
          folder: noteFolder(finding.notePath),
          question: finding.question,
          priority: finding.priority,
          status: finding.status,
          evidenceState: finding.evidenceState,
          recommendedAction: finding.recommendedAction,
          needsHumanDecision: needsHumanDecision(finding),
          timesReported: 0,
          firstReportedAt: '',
          lastReportedAt: review.generatedAt,
          reviewId: review.reviewId,
          closureCriteria: finding.closureCriteria,
        },
      });
    }
  }
  const all = [...byFingerprint.values()].map(({ latest, count, first }) => ({ ...latest, timesReported: count, firstReportedAt: first }));
  const count = (status: KnowledgeOpenFinding['status']) => all.filter((f) => f.status === status).length;
  const items = all
    .filter((f) => f.status === 'new' || f.status === 'recurring')
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || b.lastReportedAt.localeCompare(a.lastReportedAt) || a.fingerprint.localeCompare(b.fingerprint));
  return {
    generatedAt: new Date().toISOString(),
    totals: { fingerprints: all.length, open: items.length, resolved: count('resolved'), suppressed: count('suppressed') },
    items,
  };
}

const DAY_MS = 86_400_000;
export const BRIEF_LIMITS = { maxNotes: 5, maxFindings: 15, maxAnswers: 15 } as const;

/** What the Librarian does with each operator answer (workflows/knowledge-librarian.md, "Operator answers"). */
export const ANSWER_INSTRUCTION: Record<KnowledgeDecisionAnswer, string> = {
  existing_proposal_enough: 'resolve it: the operator says the existing proposal covers this; cite the answer as closure evidence and do not raise a duplicate',
  still_true: 'resolve it: the operator confirmed the note is still accurate; cite the answer as closure evidence',
  no_longer_true: 'the operator says the note is stale (see their note): correct it under the write policy (apply in scope with confirmed evidence, else propose) and resolve once the correction is recorded',
  check_it: 'the operator delegated the check: verify the current state from sources yourself and record resolved or recurring with that evidence',
  approve: 'record the operator\'s approval as the answer; make only the vault change it approves (in scope, else propose); anything outside the vault stays open as a TASK for the operator',
  reject: 'resolve it with the operator\'s rejection as the answer; do not propose the rejected change again',
  answer: 'record the operator\'s answer as the finding answer and resolve it; if it implies a vault or ADR change, apply in scope or propose',
  defer: 'leave it open; do not ask again this run',
};

export interface BriefOptions {
  audience: KnowledgeBriefAudience;
  /** Human briefs: restrict to these fingerprints (the dashboard's current filter). */
  fingerprints?: string[];
  /** Task briefs: note paths must match one of these (from the auto-write policy). */
  scopePatterns?: RegExp[];
  now?: Date;
  maxNotes?: number;
  maxFindings?: number;
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : 0;
}

/**
 * The one re-check selection rule, shared by the dashboard button and the
 * weekly task: worst priority first, then longest since an audit looked, capped
 * at maxNotes and maxFindings so a hub note cannot take the whole run. Task
 * briefs also drop human-decision findings, keep only the auto-write scope and
 * put confirmed evidence first (only confirmed may be auto-applied).
 */
export function buildRecheckBrief(open: KnowledgeOpenFinding[], totalOpen: number, options: BriefOptions): KnowledgeRecheckBrief {
  const now = options.now ?? new Date();
  const maxNotes = options.maxNotes ?? BRIEF_LIMITS.maxNotes;
  const maxFindings = options.maxFindings ?? BRIEF_LIMITS.maxFindings;
  const evidenceRank = (f: KnowledgeOpenFinding) => (f.evidenceState === 'confirmed' ? 0 : 1);
  const urgency = (a: KnowledgeOpenFinding, b: KnowledgeOpenFinding) =>
    (options.audience === 'task' ? evidenceRank(a) - evidenceRank(b) : 0)
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.lastReportedAt.localeCompare(b.lastReportedAt);

  let items = open;
  if (options.fingerprints) { const keep = new Set(options.fingerprints); items = items.filter((f) => keep.has(f.fingerprint)); }
  // Operator answers waiting for a run: listed separately, outside the note caps and the
  // auto-write scope (recording a status needs no write scope; vault edits still do).
  const answers = options.audience === 'task'
    ? open.filter((f) => f.needsHumanDecision && f.decisionPending && f.humanDecision)
      .sort((a, b) => a.humanDecision!.decidedAt.localeCompare(b.humanDecision!.decidedAt))
      .slice(0, BRIEF_LIMITS.maxAnswers)
      .map((f) => ({
        decisionId: f.humanDecision!.id, fingerprint: f.fingerprint, notePath: f.notePath, question: f.question,
        answer: f.humanDecision!.answer, ...(f.humanDecision!.note ? { note: f.humanDecision!.note } : {}),
        actor: f.humanDecision!.actor, decidedAt: f.humanDecision!.decidedAt,
      }))
    : [];
  // Neither audience re-checks a human decision: a Librarian cannot close it, so it would only
  // take slots in the cap. They are answered in Knowledge › Decisions (human briefs say so).
  const humanDecisionsExcluded = items.filter((f) => f.needsHumanDecision).length;
  items = items.filter((f) => !f.needsHumanDecision);
  if (options.audience === 'task') {
    if (options.scopePatterns) items = items.filter((f) => options.scopePatterns!.some((re) => re.test(f.notePath)));
  }

  const byNote = new Map<string, KnowledgeOpenFinding[]>();
  for (const f of items) byNote.set(f.notePath, [...(byNote.get(f.notePath) ?? []), f]);
  const notes = [...byNote].map(([notePath, fs]) => ({ notePath, fs: [...fs].sort(urgency) }))
    .sort((a, b) => urgency(a.fs[0], b.fs[0]) || a.notePath.localeCompare(b.notePath));

  const picked: KnowledgeRecheckBrief['notes'] = [];
  let budget = maxFindings;
  for (const { notePath, fs } of notes) {
    if (picked.length >= maxNotes || budget <= 0) break;
    const take = fs.slice(0, budget);
    budget -= take.length;
    picked.push({
      notePath,
      remaining: fs.length - take.length,
      findings: take.map((f) => ({ fingerprint: f.fingerprint, priority: f.priority, evidenceState: f.evidenceState, lastReportedAt: f.lastReportedAt, reviewId: f.reviewId, question: f.question })),
    });
  }
  const count = picked.reduce((n, note) => n + note.findings.length, 0);
  const date = now.toISOString().slice(0, 10);
  const lines = [
    `Knowledge re-check ${options.audience === 'task' ? 'run' : 'sweep'} — ${date}`,
    '',
    'Re-check these open Librarian findings (ai-dev-office/workflows/knowledge-librarian.md, "Weekly Re-check Run").',
    'For each fingerprint, record resolved (answer, closure evidence, closed_at), suppressed, or recurring',
    'with current evidence. Product or architecture choices stay open for a human.',
    ...(options.audience === 'task'
      ? ['Apply a proposed patch only when its evidence is still confirmed and the note is inside the approved auto-write scope.']
      : []),
    `Scope: ${picked.length} note${picked.length === 1 ? '' : 's'} · ${count} findings (of ${items.length} considered, ${totalOpen} open; ${notes.length - picked.length} more notes wait for the next run).`,
    ...(humanDecisionsExcluded > 0
      ? [`Left out: ${humanDecisionsExcluded} finding${humanDecisionsExcluded === 1 ? '' : 's'} only a human can close (answered in the dashboard's Knowledge › Decisions).`]
      : []),
  ];
  picked.forEach((note, i) => {
    lines.push('', `${i + 1}. ${note.notePath}`);
    for (const f of note.findings) {
      lines.push(`   - [${f.priority}] ${f.fingerprint} — evidence ${f.evidenceState}; last audited ${f.lastReportedAt.slice(0, 10)} (${daysSince(f.lastReportedAt, now)}d) in ${f.reviewId}`);
      lines.push(`     ${f.question}`);
    }
    if (note.remaining > 0) lines.push(`   (+${note.remaining} more open on this note for a later run)`);
  });
  if (answers.length > 0) {
    lines.push('', `Operator answers to record (${answers.length}; from the dashboard decision queue, knowledge-reviews/decisions/human-decisions.yaml).`,
      'Keep each fingerprint; cite "operator answer <id> by <actor> on <date>" as the closure evidence.');
    answers.forEach((a, i) => {
      lines.push('', `A${i + 1}. ${a.notePath}`,
        `   - ${a.fingerprint} — ${a.decisionId} by ${a.actor} on ${a.decidedAt.slice(0, 10)}: ${a.answer}${a.note ? ` — "${a.note.replace(/\s+/g, ' ')}"` : ''}`,
        `     Question: ${a.question}`,
        `     Do: ${ANSWER_INSTRUCTION[a.answer]}.`);
    });
  }
  return {
    generatedAt: now.toISOString(), audience: options.audience, text: lines.join('\n'), notes: picked,
    considered: items.length, totalOpen, remainingNotes: notes.length - picked.length, limits: { maxNotes, maxFindings },
    humanDecisionsExcluded,
    answers,
  };
}

/** Ruby anchors in knowledge-librarian-policy.yaml path_pattern → JS. */
export function policyPathPatterns(policy: unknown, scope = 'games_labs'): RegExp[] {
  const targets = (policy as { scopes?: Record<string, { write_targets?: { path_pattern?: string }[] }> })?.scopes?.[scope]?.write_targets ?? [];
  return targets
    .map((t) => t.path_pattern)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => new RegExp(p.replace(/^\\A/, '^').replace(/\\z$/, '$')));
}

export class KnowledgeReviewService {
  private readonly validatorPath: string;
  private readonly schemaPath: string;
  private readonly cache = new Map<string, CachedReview>();
  private readonly invalidCache = new Map<string, CachedInvalid>();
  private diskCacheLoaded = false;
  private readonly decisions: HumanDecisionStore;
  private contractSignature: string | null = null;
  private pendingLoad: Promise<LoadAllResult> | null = null;

  constructor(
    private readonly reviewsDir: string,
    private readonly workspaceRoot?: string,
    validatorPath?: string,
  ) {
    this.validatorPath = validatorPath ?? path.join(path.dirname(reviewsDir), 'scripts', 'validate-knowledge-librarian.rb');
    this.schemaPath = path.join(path.dirname(reviewsDir), 'schemas', 'knowledge-librarian-output.schema.json');
    this.decisions = new HumanDecisionStore(reviewsDir);
  }

  private async signature(filePath: string): Promise<string> {
    try {
      const stats = await fs.stat(filePath);
      return `${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async currentContractSignature(): Promise<string> {
    const [validator, schema] = await Promise.all([
      this.signature(this.validatorPath),
      this.signature(this.schemaPath),
    ]);
    return `${validator}|${schema}`;
  }

  private async policySignature(review: KnowledgeReviewDetail): Promise<string | null> {
    const source = review.authorization?.policySource;
    if (!source) return null;
    const root = this.workspaceRoot ?? path.resolve(path.dirname(this.validatorPath), '../..');
    return this.signature(path.resolve(root, source));
  }

  get validationCachePath(): string {
    return path.join(this.reviewsDir, '.cache', 'validated-reviews.json');
  }

  /** Once per process: adopt the on-disk results when the validator and schema are unchanged. */
  private async loadDiskCache(contractSignature: string): Promise<void> {
    if (this.diskCacheLoaded) return;
    this.diskCacheLoaded = true;
    try {
      const disk = JSON.parse(await fs.readFile(this.validationCachePath, 'utf8')) as DiskCache;
      if (disk.version !== VALIDATION_CACHE_VERSION || disk.contractSignature !== contractSignature) return;
      for (const [file, entry] of Object.entries(disk.reviews ?? {})) this.cache.set(file, entry);
      for (const [file, entry] of Object.entries(disk.invalid ?? {})) this.invalidCache.set(file, entry);
    } catch {
      // Missing or unreadable cache: validate everything, as before.
    }
  }

  private async saveDiskCache(contractSignature: string): Promise<void> {
    const doc: DiskCache = {
      version: VALIDATION_CACHE_VERSION, contractSignature,
      reviews: Object.fromEntries(this.cache), invalid: Object.fromEntries(this.invalidCache),
    };
    try {
      await fs.mkdir(path.dirname(this.validationCachePath), { recursive: true });
      const tmp = `${this.validationCachePath}.tmp.${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(doc));
      await fs.rename(tmp, this.validationCachePath);
    } catch (error) {
      console.warn('Knowledge validation cache not saved:', error instanceof Error ? error.message : error);
    }
  }

  private async loadAllUncached(): Promise<LoadAllResult> {
    let entries;
    try {
      entries = await fs.readdir(this.reviewsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [], invalidFiles: [], invalid: [] };
      }
      throw error;
    }

    // The repo root changes what the validator checks, so it is part of the contract key.
    const contractSignature = `${await this.currentContractSignature()}|${this.workspaceRoot ?? ''}`;
    await this.loadDiskCache(contractSignature);
    if (this.contractSignature !== null && this.contractSignature !== contractSignature) {
      this.cache.clear();
      this.invalidCache.clear();
    }
    this.contractSignature = contractSignature;

    const candidates = (await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(this.reviewsDir, entry.name);
          const fileSignature = await this.signature(filePath);
          return fileSignature === 'missing'
            ? null
            : { file: entry.name, filePath, fileSignature };
        }),
    )).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    const liveFiles = new Set(candidates.map(({ file }) => file));
    let changed = false;
    for (const file of [...this.cache.keys(), ...this.invalidCache.keys()]) {
      if (!liveFiles.has(file)) { this.cache.delete(file); this.invalidCache.delete(file); changed = true; }
    }

    const loaded: LoadedReview[] = [];
    const invalid: InvalidReview[] = [];
    const misses = [];
    for (const candidate of candidates) {
      const knownBad = this.invalidCache.get(candidate.file);
      if (knownBad && knownBad.fileSignature === candidate.fileSignature) {
        invalid.push({ file: candidate.file, errors: knownBad.errors });
        continue;
      }
      const cached = this.cache.get(candidate.file);
      if (cached && cached.fileSignature === candidate.fileSignature) {
        const currentPolicySignature = await this.policySignature(cached.review);
        if (currentPolicySignature === cached.policySignature) {
          loaded.push({ file: candidate.file, review: cached.review });
          continue;
        }
      }
      misses.push(candidate);
    }

    const validated = await mapWithConcurrency(misses, VALIDATION_CONCURRENCY, async (candidate) => {
      try {
        const review = await loadCanonicalReview(candidate.filePath, this.validatorPath, this.workspaceRoot);
        const policySignature = await this.policySignature(review);
        this.cache.set(candidate.file, {
          fileSignature: candidate.fileSignature,
          policySignature,
          review,
        });
        this.invalidCache.delete(candidate.file);
        return { file: candidate.file, review, errors: [] as string[] };
      } catch (error) {
        if (!(error instanceof InvalidKnowledgeReviewError)) throw error;
        this.cache.delete(candidate.file);
        const errors = error.message.split('; ').filter(Boolean);
        this.invalidCache.set(candidate.file, { fileSignature: candidate.fileSignature, errors });
        return { file: candidate.file, review: null, errors };
      }
    });
    for (const result of validated) {
      if (result.review) loaded.push({ file: result.file, review: result.review });
      else invalid.push({ file: result.file, errors: result.errors });
    }
    if (misses.length > 0 || changed) await this.saveDiskCache(contractSignature);

    const filesById = new Map<string, string[]>();
    loaded.forEach(({ file, review }) => filesById.set(review.reviewId, [...(filesById.get(review.reviewId) ?? []), file]));
    const reviews = loaded
      .filter(({ file, review }) => {
        const files = filesById.get(review.reviewId) ?? [];
        if (files.length === 1) return true;
        invalid.push({ file, errors: [`duplicate review_id ${review.reviewId} (also in ${files.filter((f) => f !== file).join(', ')})`] });
        return false;
      })
      .map(({ review }) => review);

    reviews.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    invalid.sort((a, b) => a.file.localeCompare(b.file));
    return { reviews, invalidFiles: invalid.map((i) => i.file), invalid };
  }

  private async loadAll(): Promise<LoadAllResult> {
    if (this.pendingLoad) return this.pendingLoad;
    this.pendingLoad = this.loadAllUncached();
    try {
      return await this.pendingLoad;
    } finally {
      this.pendingLoad = null;
    }
  }

  async list(): Promise<KnowledgeReviewsResponse> {
    const { reviews, invalidFiles, invalid } = await this.loadAll();
    return {
      generatedAt: new Date().toISOString(),
      total: reviews.length,
      invalidCount: invalidFiles.length,
      invalidFiles,
      invalid,
      reviews: reviews.map(toSummary),
    };
  }

  async openFindings(): Promise<KnowledgeOpenFindingsResponse> {
    const { reviews } = await this.loadAll();
    const open = buildOpenFindings(reviews);
    return { ...open, items: attachDecisions(open.items, latestDecisions(await this.decisions.read())) };
  }

  /** Records an operator answer for an open human-decision finding (input ledger only). */
  async recordDecision(body: unknown): Promise<{ ok: true; decision: KnowledgeHumanDecision } | { ok: false; status: number; error: string }> {
    const valid = validateDecision(body);
    if (!valid.ok) return { ok: false, status: 400, error: valid.error };
    const finding = (await this.openFindings()).items.find((f) => f.fingerprint === valid.value.fingerprint);
    if (!finding) return { ok: false, status: 404, error: 'No open finding has that fingerprint' };
    if (!finding.needsHumanDecision) return { ok: false, status: 409, error: 'That finding does not need a human decision; the re-check run handles it' };
    const decision = await this.decisions.append({ ...valid.value, question: finding.question, notePath: finding.notePath });
    return { ok: true, decision };
  }

  /** knowledge-base/knowledge-librarian-policy.yaml next to this office checkout. */
  private policyPath(): string {
    const root = this.workspaceRoot ?? path.resolve(path.dirname(this.validatorPath), '../..');
    return path.join(root, 'knowledge-base', 'knowledge-librarian-policy.yaml');
  }

  async recheckBrief(audience: KnowledgeBriefAudience, fingerprints?: string[]): Promise<KnowledgeRecheckBrief> {
    const { items, totals } = await this.openFindings();
    let scopePatterns: RegExp[] | undefined;
    if (audience === 'task') {
      // No policy → no auto-write scope → no task brief, by design.
      const policy = yaml.load(await fs.readFile(this.policyPath(), 'utf8'));
      scopePatterns = policyPathPatterns(policy);
      if (scopePatterns.length === 0) throw new Error('knowledge-librarian-policy.yaml has no games_labs write targets');
    }
    return buildRecheckBrief(items, totals.open, { audience, fingerprints, scopePatterns });
  }

  async getById(reviewId: string): Promise<KnowledgeReviewDetail | null> {
    if (!KNOWLEDGE_REVIEW_ID_PATTERN.test(reviewId)) return null;
    const { reviews } = await this.loadAll();
    return reviews.find((review) => review.reviewId === reviewId) ?? null;
  }
}
