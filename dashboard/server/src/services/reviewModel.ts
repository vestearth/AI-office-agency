import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { config } from '../config';
import { asObject, classifyActor, parseCarries, parseWaitsOn, readRunTitle } from './runScanner';
// Runtime value: relative import (the @shared alias is type-only under ts-node).
import type {
  ActionKind, ReviewSummary, RunPhase, ReviewVerdict, ConfidenceLevel, RiskLevel, IssueCounts, DecisionRecord, GateView,
} from '@shared/types';
import { DecisionStore } from './decisionStore';
import { GateViewService, globalGateViews, hasCompletionGates } from './gateView';
import { officeMs } from './officeTime';
import { TASK_ID_PATTERN } from '../pathSecurity';

// Exact enum membership — these mirror the producer schemas. We match by exact
// equality (never substring), so the read model reflects the contract, not a guess.
const RUN_PHASES: readonly RunPhase[] = [
  'pending', 'blocked', 'assigned', 'assigned_parallel', 'review', 'in_review',
  'debugging', 'debugging_complete', 'devops_needed', 'devops_complete',
  'escalated', 'free_roam_complete', 'validation_failed', 'done', 'aborted',
];

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  'approved', 'changes_requested', 'escalate', 'infra_failure',
];

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];
const ISSUE_SEVERITIES = ['error', 'warning', 'suggestion'] as const;

const IN_REVIEW_PHASES: readonly RunPhase[] = ['review', 'in_review'];
const ATTENTION_VERDICTS: readonly ReviewVerdict[] = [
  'changes_requested', 'escalate', 'infra_failure',
];
const TERMINAL_PHASES: readonly RunPhase[] = ['done', 'aborted'];
const EXCEPTION_PHASES: readonly RunPhase[] = [
  'blocked', 'escalated', 'validation_failed', 'devops_needed',
];

interface ActionClassification {
  kind: ActionKind;
  reason: string;
  recommendedAction: string;
}

function normalizePhase(value: unknown): RunPhase | null {
  return typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value)
    ? (value as RunPhase)
    : null;
}

function normalizeVerdict(value: unknown): ReviewVerdict | null {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value)
    ? (value as ReviewVerdict)
    : null;
}

function normalizeConfidence(value: unknown): ConfidenceLevel | null {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
    ? (value as ConfidenceLevel)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Issue #28 Phase 2F: the gate kinds, judged from CompletionGuard.gate_view
// (scripts/gate-view-json.rb), never re-derived here. null = no completion_gates.
function classifyGateAction(
  taskId: string,
  phase: RunPhase | null,
  verdict: ReviewVerdict | null,
  gateView: GateView | null,
): ActionClassification | null {
  if (gateView === null) return null;
  // The writer refuses every gate edit on a finished task, so nothing there is
  // actionable; the Monitor card still shows its gate state (spec: not flagged).
  if (phase !== null && TERMINAL_PHASES.includes(phase)) return null;

  if (!gateView.readable || gateView.ledgerReadable === false) {
    const problem = gateView.readable ? 'the authorization ledger cannot be read' : (gateView.problem ?? 'unknown problem');
    return {
      kind: 'gates_unreadable',
      reason: `Gate state cannot be read: ${problem}.`,
      recommendedAction: `Run ./run-agent.sh status ${taskId} and repair status.yaml / authorization.yaml through their writers.`,
    };
  }

  // The writer refuses every edit on a finished task, so nothing there needs a grant.
  const awaitingGrant = gateView.finishedPhase !== null ? [] : gateView.gates.filter(
    (gate) => gate.status === 'pending' && gate.requiresAuthorization !== null
      && gate.grant === 'missing' && gate.waitsOn.length === 0,
  );
  if (awaitingGrant.length > 0) {
    return {
      kind: 'authorization_required',
      reason: `${awaitingGrant.map((gate) => `Gate ${gate.name} waits for a ${gate.requiresAuthorization} grant`).join('; ')}.`,
      recommendedAction: `ruby scripts/record-authorization.rb ${taskId} grant --action ${awaitingGrant[0].requiresAuthorization} --scope <scope> --actor <you> --via <channel> --reason "<why>"`,
    };
  }

  const inReview = phase === 'review' || phase === 'in_review';
  if (inReview && verdict === 'approved' && gateView.summary.resolved < gateView.summary.total) {
    const open = gateView.gates
      .filter((gate) => !gate.resolved)
      .map((gate) => (gate.detail ? `${gate.name}: ${gate.detail}` : gate.name));
    return {
      kind: 'completion_held',
      reason: `Review approved; the done guard holds the task until its gates resolve: ${open.join('; ')}.`,
      recommendedAction: `Dispatch the role that owns the open gates; ./run-agent.sh status ${taskId} shows which can pass now.`,
    };
  }

  return null;
}

function classifyAction(
  taskId: string,
  phase: RunPhase | null,
  rawPhase: unknown,
  verdict: ReviewVerdict | null,
  decisionPending: boolean,
  gateView: GateView | null,
  statusProblem: string | null,
  waits: { blockedOn: string[]; waitingFor: string[] } = { blockedOn: [], waitingFor: [] },
): ActionClassification | null {
  if (statusProblem) {
    return {
      kind: 'workflow_exception',
      reason: `${statusProblem}; the task's real state cannot be read.`,
      recommendedAction: 'Repair status.yaml, then run ruby validate-yaml.rb on the task.',
    };
  }

  if (decisionPending) {
    return {
      kind: 'decision_pending',
      reason: 'A human decision is recorded but has not been reconciled into status.yaml.',
      recommendedAction: 'Run the task driver to reconcile the latest decision.',
    };
  }

  const gateAction = classifyGateAction(taskId, phase, verdict, gateView);
  if (gateAction) return gateAction;

  if (phase === 'review' || phase === 'in_review') {
    return {
      kind: 'awaiting_review',
      reason: `status.yaml phase = ${phase}; a reviewer decision is required.`,
      recommendedAction: 'Review the evidence and record a decision.',
    };
  }

  // An aborted task's last verdict no longer matters: abandoning work under review is a
  // normal end, not drift (2026-10-16, TASK-EAR-404). A done task with an adverse verdict is.
  if (phase === 'aborted') return null;

  const verdictNeedsAttention = verdict !== null && ATTENTION_VERDICTS.includes(verdict);
  if (phase !== null && TERMINAL_PHASES.includes(phase) && verdictNeedsAttention) {
    return {
      kind: 'artifact_drift',
      reason: `Task is ${phase}, but reviewer verdict is still ${verdict}.`,
      recommendedAction: 'Verify current evidence and align the stale reviewer artifact.',
    };
  }

  if (phase !== null && EXCEPTION_PHASES.includes(phase)) {
    const nextByPhase: Partial<Record<RunPhase, string>> = {
      blocked: 'Resolve the recorded blocker before dispatching another role.',
      escalated: 'Open the run in Monitor and resolve the escalation.',
      validation_failed: 'Inspect validation evidence and route the required fix.',
      devops_needed: 'Review the infrastructure failure and route it to DevOps.',
    };
    return {
      kind: 'workflow_exception',
      reason: waitingReason(phase, waits.blockedOn, waits.waitingFor)
        ?? `status.yaml phase = ${phase}; operator intervention is required.`,
      recommendedAction: nextByPhase[phase] ?? 'Open the run in Monitor and inspect the workflow state.',
    };
  }

  if (verdictNeedsAttention) {
    return {
      kind: 'artifact_drift',
      reason: `Reviewer verdict ${verdict} does not match the current workflow phase ${phase ?? 'unknown'}.`,
      recommendedAction: 'Verify current evidence and align the workflow artifacts.',
    };
  }

  const phaseText = text(rawPhase);
  if (phaseText && phase === null) {
    return {
      kind: 'workflow_exception',
      reason: `status.yaml contains an unrecognized phase: ${phaseText}.`,
      recommendedAction: 'Inspect and correct the off-contract task phase.',
    };
  }

  return null;
}

/**
 * Counts issues by contracted severity across reviewer-output artifacts.
 * Only exact enum severities are counted — unknown values are ignored, never guessed.
 */
function countIssues(reviewerData: Record<string, any> | null): IssueCounts {
  const counts: IssueCounts = { error: 0, warning: 0, suggestion: 0 };
  if (!reviewerData || !Array.isArray(reviewerData.artifacts)) return counts;

  for (const artifact of reviewerData.artifacts) {
    const issues = artifact && Array.isArray(artifact.issues) ? artifact.issues : [];
    for (const issue of issues) {
      const severity = issue && issue.severity;
      if ((ISSUE_SEVERITIES as readonly string[]).includes(severity)) {
        counts[severity as keyof IssueCounts] += 1;
      }
    }
  }
  return counts;
}

// Producer risk (issue #12): reviewer-output.yaml `risk_level`, from the
// deterministic path rules in office.config.yaml. Absent on every run written
// before that contract, hence the null.
const PRODUCER_RISK_LEVELS: readonly RiskLevel[] = ['high', 'medium', 'low'];
const RISK_RANK: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1, none: 0 };

function normalizeRiskLevel(value: unknown): RiskLevel | null {
  return typeof value === 'string' && (PRODUCER_RISK_LEVELS as readonly string[]).includes(value)
    ? (value as RiskLevel)
    : null;
}

/**
 * Server-owned risk rule. Two contracted inputs, never prose: the reviewer's
 * emitted `risk_level` (change risk) and the issue severities it found (finding
 * risk). The higher of the two wins, so a clean review of an auth change stays
 * `high` and an error on a docs change is never hidden. `none` = not yet
 * review-assessed.
 *
 * A reviewer-output with no `risk_level` (every run predating issue #12) falls
 * back to finding risk alone, so a clean pre-#12 review of a high-risk change
 * reads `low`. That is deliberate: re-deriving change risk here would mean a
 * second copy of the path rules in TypeScript, and a drifting copy of a safety
 * rule is worse than a conservative signal. New reviews always emit the field.
 */
function deriveRiskLevel(reviewerData: Record<string, any> | null, counts: IssueCounts): RiskLevel {
  if (!reviewerData) return 'none';
  const fromIssues: RiskLevel = counts.error > 0 ? 'high' : counts.warning > 0 ? 'medium' : 'low';
  const fromProducer = normalizeRiskLevel(reviewerData.risk_level);
  if (fromProducer === null) return fromIssues;
  return RISK_RANK[fromProducer] >= RISK_RANK[fromIssues] ? fromProducer : fromIssues;
}

/** status.yaml waits_on as validated (one parser, shared with the run detail). */
const waitsOn = parseWaitsOn;

type Transition = NonNullable<ReviewSummary['lastTransition']>;
interface HistoryTransition { time: number; index: number; from: string; to: string; value: Transition }

/** `history[]` phase transitions (`a -> b`), in file order; gate updates (`gate <name>: a -> b`) are not hand-offs. */
function transitions(history: unknown): HistoryTransition[] {
  if (!Array.isArray(history)) return [];
  const out: HistoryTransition[] = [];
  history.forEach((raw, index) => {
    const entry = asObject(raw);
    const phase = text(entry.phase);
    if (!phase || !phase.includes('->') || phase.startsWith('gate ')) return;
    const arrow = phase.indexOf('->');
    const at = entry.at instanceof Date ? entry.at.toISOString() : text(entry.at);
    const t = at ? Date.parse(at) : NaN;
    out.push({
      time: Number.isFinite(t) ? t : -Infinity,
      index,
      from: phase.slice(0, arrow).trim(),
      to: phase.slice(arrow + 2).trim(),
      value: { agent: classifyActor(text(entry.agent) ?? undefined).name, phase, reason: text(entry.reason), at },
    });
  });
  return out;
}

/**
 * The latest by time, not by file position: some history[] blocks were written out of
 * order (TASK-EAR-402 has 10/14, 10/12 08:18, 10/12 07:15 at the top). Equal or
 * unparseable times fall back to the later row in the file.
 */
function latest(rows: HistoryTransition[]): Transition | null {
  let best: HistoryTransition | null = null;
  for (const row of rows) {
    if (!best || row.time > best.time || (row.time === best.time && row.index > best.index)) best = row;
  }
  return best ? best.value : null;
}

/**
 * Entries into Debug Lab: transitions into `debugging` from another phase, read from the
 * `phase` field only (never the reason). `debugging -> debugging` rows are bookkeeping
 * during a stay (branch updates), so they neither count nor replace the entry row.
 */
function debugEntries(rows: HistoryTransition[]): HistoryTransition[] {
  return rows.filter((row) => row.to === 'debugging' && row.from !== 'debugging');
}

/**
 * Pure projection from contracted producer fields to a ReviewSummary.
 * `reviewerData`/`debuggerData` are null when the respective output is absent.
 */
export function buildReviewSummary(
  taskId: string,
  statusData: Record<string, any>,
  reviewerData: Record<string, any> | null,
  debuggerData: Record<string, any> | null = null,
  latestDecision: DecisionRecord | null = null,
  gateView: GateView | null = null,
  statusProblem: string | null = null,
): ReviewSummary {
  const phase = normalizePhase(statusData.phase);
  const verdict = reviewerData ? normalizeVerdict(reviewerData.review_verdict) : null;

  const inReviewQueue = phase !== null && IN_REVIEW_PHASES.includes(phase);
  const verdictNeedsAttention = verdict !== null && ATTENTION_VERDICTS.includes(verdict);
  const statusDecisionAppliedAt = text(statusData.decision_applied_at);
  const decisionPending = latestDecision !== null
    && latestDecision.decidedAt !== statusDecisionAppliedAt;
  const action = classifyAction(taskId, phase, statusData.phase, verdict, decisionPending, gateView, statusProblem, {
    blockedOn: textList(statusData.blocked_on),
    waitingFor: waitingList(statusData.waiting_for),
  });

  const confidence = debuggerData
    ? normalizeConfidence(debuggerData?.diagnosis?.confidence)
    : null;
  const issueCounts = countIssues(reviewerData);
  const riskLevel = deriveRiskLevel(reviewerData, issueCounts);
  const history = transitions(statusData.history);
  const entries = debugEntries(history);

  return {
    taskId,
    title: text(statusData.task_label) ?? taskId,
    phase,
    verdict,
    inReviewQueue,
    verdictNeedsAttention,
    needsReview: action?.kind === 'awaiting_review',
    requiresAction: action !== null,
    actionKind: action?.kind ?? null,
    actionReason: action?.reason ?? null,
    recommendedAction: action?.recommendedAction ?? null,
    decisionPending,
    statusUpdatedAt: text(statusData.updated_at),
    lastReviewedAt: reviewerData
      ? (typeof statusData.updated_at === 'string' ? statusData.updated_at : null)
      : null,
    confidence,
    issueCounts,
    riskLevel,
    latestDecision,
    idle: null,
    lastTransition: latest(history),
    debugRounds: entries.length,
    debugEntry: latest(entries),
    waitsOn: waitsOn(statusData.waits_on),
    isReleaseTrain: parseCarries(statusData.carries).length > 0,
    ...(gateView ? {
      gates: {
        readable: gateView.readable,
        total: gateView.summary.total,
        resolved: gateView.summary.resolved,
        passable: gateView.summary.passable,
        items: gateView.gates.map((gate) => ({ name: gate.name, status: gate.status, resolved: gate.resolved })),
      },
    } : {}),
  };
}

// Unlike the optional outputs, a missing or unparseable status.yaml is itself a
// finding: the task would otherwise vanish from Attention without a trace.
const DAY_MS = 86_400_000;

/** Days without a status.yaml change after which a phase counts as stale. */
const IDLE_THRESHOLD_DAYS: Partial<Record<RunPhase, number>> = {
  review: 7,
  in_review: 7,
  pending: 14,
  assigned: 14,
  assigned_parallel: 14,
  debugging: 14,
  devops_needed: 14,
};

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
}

/** waiting_for entries are often whole sentences; drop their final period so they join cleanly. */
function waitingList(value: unknown): string[] {
  return textList(value).map((item) => item.replace(/\.+$/, ''));
}

/** "Blocked on TASK-A, TASK-B; waiting for: X; Y." from what status.yaml records; null when it records nothing. */
function waitingReason(phase: RunPhase, blockedOn: string[], waitingFor: string[]): string | null {
  if (blockedOn.length === 0 && waitingFor.length === 0) return null;
  const label = phase.charAt(0).toUpperCase() + phase.slice(1).replace(/_/g, ' ');
  const head = blockedOn.length > 0 ? `${label} on ${blockedOn.join(', ')}` : label;
  return waitingFor.length > 0 ? `${head}; waiting for: ${waitingFor.join('; ')}.` : `${head}.`;
}

/** A date-only updated_at is midnight in the office's time zone, as Flow's oldest wait reads it. */
function updatedAtMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? officeMs(value) : NaN;
}

/**
 * Stale work the phase alone does not show: a block whose blocked_on tasks have
 * all finished, and a task whose status.yaml has not changed past the threshold
 * for its phase. A task already in the Action Center keeps its kind and only
 * gains `idle`; one with no other action becomes `stale_work`.
 */
export function assessStaleness(
  summary: ReviewSummary,
  statusData: Record<string, any>,
  phaseByTask: ReadonlyMap<string, RunPhase | null>,
  now: Date,
): ReviewSummary {
  let next = summary;

  if (summary.phase === 'blocked' && summary.actionKind === 'workflow_exception') {
    const blockers = textList(statusData.blocked_on);
    const finished = blockers
      .map((id) => ({ id, phase: phaseByTask.get(id) ?? null }))
      .filter((blocker) => blocker.phase !== null && TERMINAL_PHASES.includes(blocker.phase));
    if (blockers.length > 0 && finished.length === blockers.length) {
      const waiting = waitingList(statusData.waiting_for);
      next = {
        ...next,
        actionKind: 'stale_work',
        requiresAction: true,
        actionReason: `Blocked, but all ${blockers.length} blocked_on tasks are finished `
          + `(${finished.map((blocker) => `${blocker.id} ${blocker.phase}`).join(', ')})`
          + `${waiting.length ? `; still waiting_for: ${waiting.join('; ')}` : ''}.`,
        recommendedAction: 'Confirm what is still outstanding, then move the task out of blocked or close it.',
      };
    }
  }

  const threshold = summary.phase ? IDLE_THRESHOLD_DAYS[summary.phase] : undefined;
  const updated = updatedAtMs(statusData.updated_at);
  if (threshold !== undefined && Number.isFinite(updated)) {
    const days = Math.floor((now.getTime() - updated) / DAY_MS);
    if (days > threshold) {
      next = { ...next, idle: { days, thresholdDays: threshold } };
      if (next.actionKind === null) {
        next = {
          ...next,
          actionKind: 'stale_work',
          requiresAction: true,
          actionReason: `status.yaml phase = ${summary.phase}; no status change for ${days} days (stale after ${threshold}).`,
          recommendedAction: 'Confirm the task is still live: resume it, re-route it, or close it.',
        };
      }
    }
  }

  return next;
}

/**
 * status.yaml check_after (scripts/update-check-after.rb) whose `at` has passed on an open task.
 * It replaces stale work, which it explains; any other kind stays and gains the check in its reason.
 * An unreadable value raises nothing here: validate-yaml.rb reports it.
 */
export function assessCheckDue(summary: ReviewSummary, statusData: Record<string, any>, now: Date): ReviewSummary {
  if (summary.phase === null || TERMINAL_PHASES.includes(summary.phase)) return summary;
  const check = asObject(statusData.check_after);
  const at = text(check.at);
  const what = text(check.what);
  if (!at || !what) return summary;
  const due = officeMs(at);
  if (!Number.isFinite(due) || now.getTime() < due) return summary;

  const detail = `due since ${at}: ${what.replace(/\.+$/, '')}.`;
  if (summary.actionKind !== null && summary.actionKind !== 'stale_work') {
    return { ...summary, checkDue: { at, what }, actionReason: `${summary.actionReason ?? ''} Also: check ${detail}`.trim() };
  }
  return {
    ...summary,
    checkDue: { at, what },
    actionKind: 'check_due',
    requiresAction: true,
    actionReason: `Check ${detail}`,
    recommendedAction: `Run the check, record what it showed, then: ruby scripts/update-check-after.rb ${summary.taskId} clear --actor <role> --reason "<result>".`,
  };
}

// "Supersedes TASK-A" / "Supersedes: TASK-A, TASK-B and TASK-C", any case, markdown emphasis allowed.
// Only ids "supersedes" names directly: "supersedes the prior dependency on all of TASK-EAR-284"
// (TASK-EAR-285) is not a supersession. The real phrasings are from runs/*/task.md, 2026-10-17.
const SUPERSEDES = /\bsupersedes\b[*_`]*\s*:?\s*([*_`]*TASK-[A-Za-z0-9][\w-]*[*_`]*(?:\s*(?:,|&|\/|\band\b)\s*[*_`]*TASK-[A-Za-z0-9][\w-]*[*_`]*)*)/gi;

/** Task ids a task.md says it supersedes, upper-cased, in order, never the task itself. */
export function supersededIds(taskMd: string, selfId: string): string[] {
  const out: string[] = [];
  for (const match of taskMd.matchAll(SUPERSEDES)) {
    for (const ref of match[1].match(/TASK-[A-Za-z0-9][\w-]*/gi) ?? []) {
      const id = ref.replace(/[-_]+$/, '').toUpperCase();
      if (id !== selfId.toUpperCase() && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * An open task that another run's task.md supersedes (operator decision 2026-10-17: TASK-VS-040
 * said "Supersedes TASK-VS-030", and VS-030 stayed assigned until the operator noticed). Shown as
 * artifact drift: the task's status.yaml still says open while a newer record says it is replaced.
 * It outranks the task's other kinds, kept as detail, except an unapplied human decision (which
 * may be the close itself). Detection only: nothing is ever closed automatically.
 */
export function assessSupersession(summary: ReviewSummary, supersededBy: { id: string; phase: RunPhase | null }[]): ReviewSummary {
  if (supersededBy.length === 0 || summary.phase === null || TERMINAL_PHASES.includes(summary.phase)) return summary;
  if (summary.actionKind === 'decision_pending') return summary;
  const by = supersededBy.map((s) => `${s.id} (${s.phase ?? 'phase unreadable'})`).join(', ');
  const ids = supersededBy.map((s) => s.id).join(', ');
  return {
    ...summary,
    needsReview: false,
    requiresAction: true,
    actionKind: 'artifact_drift',
    actionReason: `Superseded by ${by}, still ${summary.phase}.${summary.actionReason ? ` Also: ${summary.actionReason}` : ''}`,
    recommendedAction: `Confirm ${ids} carries its scope, then close ${summary.taskId} as aborted (superseded by ${ids}) `
      + 'through the office scripts: open gates to na, then phase to aborted. Nothing is closed automatically.',
  };
}

async function readStatusYaml(filePath: string): Promise<{ data: Record<string, any>; problem: string | null }> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    return { data: {}, problem: 'status.yaml is missing' };
  }
  try {
    return { data: asObject(yaml.load(content)), problem: null };
  } catch (e) {
    const detail = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { data: {}, problem: `status.yaml cannot be parsed: ${detail}` };
  }
}

async function readYamlObject(filePath: string): Promise<Record<string, any> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return asObject(yaml.load(content));
  } catch (e) {
    return null;
  }
}

export class ReviewModelService {
  private readonly decisionStore: DecisionStore;
  private pendingRequest: Promise<ReviewSummary[]> | null = null;

  constructor(
    private readonly runsDir: string = config.runsDir,
    private readonly gateViews: GateViewService = globalGateViews,
    private readonly clock: () => Date = () => new Date(),
  ) {
    // Bind the decision store to the same runsDir so injection stays consistent.
    this.decisionStore = new DecisionStore(runsDir);
  }

  invalidate(): void {
    this.pendingRequest = null;
  }

  getReviewSummaries(): Promise<ReviewSummary[]> {
    if (this.pendingRequest) return this.pendingRequest;
    const request = this.scanReviewSummaries().finally(() => {
      if (this.pendingRequest === request) this.pendingRequest = null;
    });
    this.pendingRequest = request;
    return request;
  }

  private async scanReviewSummaries(): Promise<ReviewSummary[]> {
    let taskDirs: string[] = [];
    try {
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
      taskDirs = entries
        // Same strict id rule the detail/decision endpoints enforce, so every
        // listed row is addressable (no rows you can't open or decide on).
        .filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch (e) {
      return [];
    }

    const summaries = await Promise.all(
      taskDirs.map(async (taskId) => {
        const runPath = path.join(this.runsDir, taskId);
        const { data: statusData, problem: statusProblem } = await readStatusYaml(path.join(runPath, 'status.yaml'));
        // null (not {}) means the output is absent → that signal stays null.
        const reviewerData = await readYamlObject(path.join(runPath, 'reviewer-output.yaml'));
        const debuggerData = await readYamlObject(path.join(runPath, 'debugger-output.yaml'));
        const latestDecision = await this.decisionStore.latest(taskId);
        const gateView = hasCompletionGates(statusData) ? await this.gateViews.load(runPath) : null;
        const summary = buildReviewSummary(taskId, statusData, reviewerData, debuggerData, latestDecision, gateView, statusProblem);
        const taskMd = await fs.readFile(path.join(runPath, 'task.md'), 'utf8').catch(() => '');
        return { summary: { ...summary, title: await readRunTitle(runPath, taskId, statusData) }, statusData, supersedes: supersededIds(taskMd, taskId) };
      }),
    );

    // Blocker resolution and supersession need every task's phase, so they are a second pass.
    const phaseByTask = new Map(summaries.map(({ summary }) => [summary.taskId, summary.phase]));
    const supersededBy = new Map<string, { id: string; phase: RunPhase | null }[]>();
    for (const { summary, supersedes } of summaries) {
      for (const id of supersedes) supersededBy.set(id, [...(supersededBy.get(id) ?? []), { id: summary.taskId, phase: summary.phase }]);
    }
    const now = this.clock();
    return summaries.map(({ summary, statusData }) => assessSupersession(
      assessCheckDue(assessStaleness(summary, statusData, phaseByTask, now), statusData, now),
      (supersededBy.get(summary.taskId.toUpperCase()) ?? []).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    ));
  }
}

export const globalReviewModel = new ReviewModelService();
