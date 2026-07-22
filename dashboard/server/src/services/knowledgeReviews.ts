import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import type {
  KnowledgeEvidenceState,
  KnowledgeFindingPriority,
  KnowledgeFindingStatus,
  KnowledgeReviewChange,
  KnowledgeReviewDetail,
  KnowledgeReviewFinding,
  KnowledgeReviewMode,
  KnowledgeReviewsResponse,
  KnowledgeReviewSummary,
  KnowledgeReviewWriteMode,
} from '@shared/types';

export const KNOWLEDGE_REVIEW_ID_PATTERN = /^KLR-[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]*$/;

type UnknownRecord = Record<string, unknown>;

const ISSUE_TYPES = [
  'stale_claim', 'source_gap', 'source_drift', 'broken_link', 'ambiguous_link', 'duplicate', 'orphan',
  'publication_risk', 'large_feature_capture', 'resolved_debug_capture', 'promotion_candidate', 'other',
] as const;
const VERIFICATION_SCOPES = ['source', 'test', 'ci', 'staging', 'production', 'mixed', 'unverified'] as const;
const RECOMMENDED_ACTIONS = ['update_note', 'create_note', 'append_review_queue', 'merge', 'archive', 'propose_adr', 'propose_shared_knowledge', 'no_change'] as const;
const TARGET_CLASSES = ['project_note', 'flow', 'review_queue', 'proposed_adr', 'shared_knowledge'] as const;
const CHANGE_ACTIONS = ['create', 'update', 'append', 'remove'] as const;
const execFileAsync = promisify(execFile);
let rubyAvailability: Promise<void> | null = null;

function ensureRubyAvailable(): Promise<void> {
  if (!rubyAvailability) {
    rubyAvailability = execFileAsync('ruby', ['--version'], { timeout: 1_000 }).then(() => undefined);
  }
  return rubyAvailability;
}

function asRecord(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function asPlainString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string, options: { minItems?: number; unique?: boolean } = {}): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (value.length < (options.minItems ?? 0)) {
    throw new Error(`${field} must contain at least ${options.minItems} item(s)`);
  }
  if (options.unique && new Set(value).size !== value.length) {
    throw new Error(`${field} must contain unique values`);
  }
  return value as string[];
}

function asBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertExactKeys(value: UnknownRecord, field: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${field} contains unsupported field(s): ${unexpected.join(', ')}`);
  }
}

function asDateTime(value: unknown, field: string): string {
  const result = asString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(result);
  if (!match || Number.isNaN(Date.parse(result))) {
    throw new Error(`${field} must be an ISO date-time`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const invalidCalendar = month < 1 || month > 12 || day < 1 || day > (monthLengths[month - 1] ?? 0);
  const invalidTime = Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59;
  const invalidOffset = offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59);
  if (invalidCalendar || invalidTime || invalidOffset) {
    throw new Error(`${field} must be an ISO date-time`);
  }
  return result;
}

function asNullableDateTime(value: unknown, field: string): string | null {
  return value === null ? null : asDateTime(value, field);
}

function asDate(value: unknown, field: string): string {
  const result = asString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw new Error(`${field} must be an ISO date`);
  }
  return result;
}

function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} has an unsupported value`);
  }
  return value as T;
}

function parseAuthorization(value: unknown): KnowledgeReviewDetail['authorization'] {
  if (value === null) return null;
  const authorization = asRecord(value, 'authorization');
  assertExactKeys(authorization, 'authorization', ['approved_scope', 'policy_source', 'approved_by', 'approved_at']);
  return {
    approvedScope: asString(authorization.approved_scope, 'authorization.approved_scope'),
    policySource: asString(authorization.policy_source, 'authorization.policy_source'),
    approvedBy: asString(authorization.approved_by, 'authorization.approved_by'),
    approvedAt: asDate(authorization.approved_at, 'authorization.approved_at'),
  };
}

function parseFinding(value: unknown): KnowledgeReviewFinding {
  const finding = asRecord(value, 'finding');
  assertExactKeys(finding, 'finding', [
    'fingerprint', 'note_path', 'question', 'issue_type', 'status', 'priority', 'evidence_state',
    'verification_scope', 'sources', 'recommended_action', 'closure_criteria', 'answer', 'opened_at',
    'closed_at', 'confidence', 'proposed_patch',
  ]);
  const fingerprint = asString(finding.fingerprint, 'finding.fingerprint');
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(fingerprint)) {
    throw new Error('finding.fingerprint has an unsupported format');
  }
  const status = asEnum<KnowledgeFindingStatus>(finding.status, 'finding.status', ['new', 'recurring', 'resolved', 'suppressed']);
  const evidenceState = asEnum<KnowledgeEvidenceState>(finding.evidence_state, 'finding.evidence_state', ['confirmed', 'partial', 'missing', 'conflicted']);
  const answer = asPlainString(finding.answer, 'finding.answer');
  asString(finding.closure_criteria, 'finding.closure_criteria');
  asNullableDateTime(finding.opened_at, 'finding.opened_at');
  const closedAt = asNullableDateTime(finding.closed_at, 'finding.closed_at');
  asPlainString(finding.proposed_patch, 'finding.proposed_patch');
  if (status === 'resolved' && (answer.trim() === '' || closedAt === null || evidenceState !== 'confirmed')) {
    throw new Error('resolved findings require an answer, closed_at, and confirmed evidence');
  }
  return {
    fingerprint,
    notePath: asString(finding.note_path, 'finding.note_path'),
    question: asString(finding.question, 'finding.question'),
    issueType: asEnum(finding.issue_type, 'finding.issue_type', ISSUE_TYPES),
    status,
    priority: asEnum<KnowledgeFindingPriority>(finding.priority, 'finding.priority', ['critical', 'high', 'medium', 'low']),
    evidenceState,
    verificationScope: asEnum(finding.verification_scope, 'finding.verification_scope', VERIFICATION_SCOPES),
    sources: asStringArray(finding.sources, 'finding.sources', { minItems: 1 }),
    recommendedAction: asEnum(finding.recommended_action, 'finding.recommended_action', RECOMMENDED_ACTIONS),
    answer,
    confidence: asEnum(finding.confidence, 'finding.confidence', ['high', 'medium', 'low']),
  };
}

function parseChange(value: unknown): KnowledgeReviewChange {
  const change = asRecord(value, 'change');
  assertExactKeys(change, 'change', ['note_path', 'target_class', 'action', 'disposition', 'finding_fingerprint', 'resulting_status', 'summary']);
  const resultingStatus = change.resulting_status;
  if (resultingStatus !== null && typeof resultingStatus !== 'string') {
    throw new Error('change.resulting_status must be a string or null');
  }
  return {
    notePath: asString(change.note_path, 'change.note_path'),
    targetClass: asEnum(change.target_class, 'change.target_class', TARGET_CLASSES),
    action: asEnum(change.action, 'change.action', CHANGE_ACTIONS),
    disposition: asEnum(change.disposition, 'change.disposition', ['proposed', 'applied']),
    findingFingerprint: asString(change.finding_fingerprint, 'change.finding_fingerprint'),
    resultingStatus,
    summary: asString(change.summary, 'change.summary'),
  };
}

export function parseKnowledgeReview(source: string): KnowledgeReviewDetail {
  const review = asRecord(yaml.load(source), 'review');
  assertExactKeys(review, 'review', [
    'artifact_type', 'schema_version', 'review_id', 'generated_at', 'scope', 'write_mode', 'review_mode',
    'authorization', 'requires_human_review', 'notes_reviewed', 'findings', 'changes', 'summary',
  ]);
  if (review.artifact_type !== 'knowledge_librarian_review' || review.schema_version !== 1) {
    throw new Error('unsupported knowledge review artifact');
  }

  const reviewId = asString(review.review_id, 'review_id');
  if (!KNOWLEDGE_REVIEW_ID_PATTERN.test(reviewId)) {
    throw new Error('review_id has an unsupported format');
  }

  const generatedAt = asDateTime(review.generated_at, 'generated_at');

  const scope = asRecord(review.scope, 'scope');
  assertExactKeys(scope, 'scope', ['product', 'paths', 'max_notes', 'timebox_minutes']);
  const writeMode = asEnum<KnowledgeReviewWriteMode>(review.write_mode, 'write_mode', ['proposal_only', 'approved_scope_auto_write']);
  const reviewMode = asEnum<KnowledgeReviewMode>(review.review_mode, 'review_mode', ['pre_write', 'post_write']);
  if (review.requires_human_review !== true) {
    throw new Error('requires_human_review must be true');
  }

  if (!Array.isArray(review.findings) || !Array.isArray(review.changes)) {
    throw new Error('findings and changes must be arrays');
  }

  const findings = review.findings.map(parseFinding);
  const changes = review.changes.map(parseChange);
  const notesReviewed = asStringArray(review.notes_reviewed, 'notes_reviewed', { unique: true });
  const authorization = parseAuthorization(review.authorization);
  if (writeMode === 'proposal_only' && (reviewMode !== 'pre_write' || authorization !== null || changes.some((change) => change.disposition === 'applied'))) {
    throw new Error('proposal_only reviews require pre_write mode, null authorization, and proposed changes');
  }
  if (writeMode === 'approved_scope_auto_write') {
    if (reviewMode !== 'post_write' || authorization === null || !changes.some((change) => change.disposition === 'applied')) {
      throw new Error('approved_scope_auto_write reviews require post_write mode, authorization, and an applied change');
    }
    if (scope.product !== authorization.approvedScope) {
      throw new Error('scope.product must match authorization.approved_scope');
    }
  }
  const findingFingerprints = new Set(findings.map((finding) => finding.fingerprint));
  if (changes.some((change) => !findingFingerprints.has(change.findingFingerprint))) {
    throw new Error('change references an unknown finding fingerprint');
  }

  return {
    reviewId,
    generatedAt,
    scope: {
      product: asString(scope.product, 'scope.product'),
      paths: asStringArray(scope.paths, 'scope.paths', { minItems: 1 }),
      maxNotes: asBoundedInteger(scope.max_notes, 'scope.max_notes', 1, 5),
      timeboxMinutes: asBoundedInteger(scope.timebox_minutes, 'scope.timebox_minutes', 1, 20),
    },
    writeMode,
    reviewMode,
    authorization,
    requiresHumanReview: true,
    notesReviewed,
    notesReviewedCount: notesReviewed.length,
    findings,
    findingsCount: findings.length,
    changes,
    changesCount: changes.length,
    appliedChangesCount: changes.filter((change) => change.disposition === 'applied').length,
    summary: asString(review.summary, 'summary'),
  };
}

function toSummary(review: KnowledgeReviewDetail): KnowledgeReviewSummary {
  const { authorization: _authorization, notesReviewed: _notesReviewed, findings: _findings, changes: _changes, ...summary } = review;
  return summary;
}

async function validateAuthorizationPolicy(review: KnowledgeReviewDetail, workspaceRoot: string): Promise<void> {
  if (review.writeMode !== 'approved_scope_auto_write' || !review.authorization) return;

  const policyPath = path.resolve(workspaceRoot, review.authorization.policySource);
  const relativePolicyPath = path.relative(workspaceRoot, policyPath);
  if (relativePolicyPath.startsWith('..') || path.isAbsolute(relativePolicyPath)) {
    throw new Error('authorization policy must stay inside the workspace root');
  }

  const policy = asRecord(yaml.load(await fs.readFile(policyPath, 'utf8')), 'authorization policy');
  if (policy.version !== 1) throw new Error('authorization policy must use version 1');
  const scopes = asRecord(policy.scopes, 'authorization policy scopes');
  const scopePolicy = asRecord(scopes[review.authorization.approvedScope], 'authorization scope');
  if (scopePolicy.approved_by !== review.authorization.approvedBy || scopePolicy.approved_at !== review.authorization.approvedAt) {
    throw new Error('authorization approver or date does not match policy');
  }
  if (scopePolicy.review_mode !== review.reviewMode) {
    throw new Error('authorization review mode does not match policy');
  }
  if (!Array.isArray(scopePolicy.write_targets) || scopePolicy.write_targets.length === 0) {
    throw new Error('authorization scope must define write targets');
  }

  for (const change of review.changes.filter((entry) => entry.disposition === 'applied')) {
    let authorized = false;
    for (const value of scopePolicy.write_targets) {
      try {
        const rule = asRecord(value, 'authorization write target');
        const actions = asStringArray(rule.actions, 'authorization write target actions', { minItems: 1 });
        if (rule.target_class !== change.targetClass || !actions.includes(change.action)) continue;
        if (Object.prototype.hasOwnProperty.call(rule, 'resulting_status') && rule.resulting_status !== change.resultingStatus) continue;
        const pattern = asString(rule.path_pattern, 'authorization write target path_pattern');
        await execFileAsync('ruby', [
          '-e',
          'begin; exit(Regexp.new(ARGV[0]).match?(ARGV[1]) ? 0 : 1); rescue RegexpError; exit 2; end',
          pattern,
          change.notePath,
        ], { timeout: 1_000 });
        authorized = true;
        break;
      } catch {
        continue;
      }
    }
    if (!authorized) throw new Error(`applied change is outside the approved scope: ${change.notePath}`);
  }
}

export class KnowledgeReviewService {
  constructor(private readonly reviewsDir: string, private readonly workspaceRoot?: string) {}

  private async loadAll(): Promise<{ reviews: KnowledgeReviewDetail[]; invalidFiles: string[] }> {
    if (this.workspaceRoot) await ensureRubyAvailable();
    let entries;
    try {
      entries = await fs.readdir(this.reviewsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [], invalidFiles: [] };
      }
      throw error;
    }

    const loaded: Array<{ file: string; review: KnowledgeReviewDetail }> = [];
    const invalidFiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      try {
        const review = parseKnowledgeReview(await fs.readFile(path.join(this.reviewsDir, entry.name), 'utf8'));
        if (this.workspaceRoot) await validateAuthorizationPolicy(review, this.workspaceRoot);
        loaded.push({
          file: entry.name,
          review,
        });
      } catch {
        invalidFiles.push(entry.name);
      }
    }

    const reviewIdCounts = new Map<string, number>();
    loaded.forEach(({ review }) => reviewIdCounts.set(review.reviewId, (reviewIdCounts.get(review.reviewId) ?? 0) + 1));
    const reviews = loaded
      .filter(({ file, review }) => {
        if ((reviewIdCounts.get(review.reviewId) ?? 0) === 1) return true;
        invalidFiles.push(file);
        return false;
      })
      .map(({ review }) => review);

    reviews.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    invalidFiles.sort();
    return { reviews, invalidFiles };
  }

  async list(): Promise<KnowledgeReviewsResponse> {
    const { reviews, invalidFiles } = await this.loadAll();
    return {
      generatedAt: new Date().toISOString(),
      total: reviews.length,
      invalidCount: invalidFiles.length,
      invalidFiles,
      reviews: reviews.map(toSummary),
    };
  }

  async getById(reviewId: string): Promise<KnowledgeReviewDetail | null> {
    if (!KNOWLEDGE_REVIEW_ID_PATTERN.test(reviewId)) return null;
    const { reviews } = await this.loadAll();
    return reviews.find((review) => review.reviewId === reviewId) ?? null;
  }
}
