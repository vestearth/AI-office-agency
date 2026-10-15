export type RunStatus =
  | "queued"
  | "running"
  | "waiting_review"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled"
  | "unknown";

export type TaskWorkstream =
  | "frontend"
  | "backend"
  | "devops"
  | "framework"
  | "docs"
  | "general";

export type AgentName =
  | "pm"
  | "dev"
  | "dev-2"
  | "reviewer"
  | "debugger"
  | "devops"
  | "free-roam"
  | "unknown";

/** A workflow role that can appear in an existing next_action artifact. */
export type TaskActionRole = Exclude<AgentName, "unknown"> | "done";

/**
 * Read-only next-step proposal. It is projected from status.yaml, never used
 * to start an agent or mutate a task artifact.
 */
export interface NextActionPreview {
  previewOnly: true;
  source: "status-next-action" | "phase-current-agent" | "unavailable";
  targetRole?: TaskActionRole;
  reason: string;
}

/**
 * Operator model (knowledge-base ADR-0003): a `history[].agent` value can be a
 * role (the workflow contract), an operator (conductor/subagent — who ran it),
 * or an actor (orchestrator/user/done). `AgentName` stays role-only on purpose
 * (zones, analytics, and current_agent are role-enforced); the timeline uses the
 * wider `TimelineActor` + `AgentKind` so it can show "who ran it" distinctly.
 */
export type AgentKind = "role" | "operator" | "actor" | "unknown";

export type TimelineActor =
  | AgentName
  | "done"
  | "orchestrator"
  | "user"
  | "operator"
  | "claude"
  | "codex"
  | "cursor"
  | "gemini";

/**
 * Raw workflow phase from runs/<id>/status.yaml `phase`.
 * Mirrors the enum in schemas/status.schema.yaml exactly (no fuzzy mapping).
 */
export type RunPhase =
  | "pending"
  | "blocked"
  | "assigned"
  | "assigned_parallel"
  | "review"
  | "in_review"
  | "debugging"
  | "debugging_complete"
  | "devops_needed"
  | "devops_complete"
  | "escalated"
  | "free_roam_complete"
  | "validation_failed"
  | "done"
  | "aborted";

/**
 * Reviewer verdict from runs/<id>/reviewer-output.yaml `review_verdict`.
 * Mirrors the enum in schemas/reviewer-output.schema.yaml exactly.
 */
export type ReviewVerdict =
  | "approved"
  | "changes_requested"
  | "escalate"
  | "infra_failure";

/**
 * Confidence from runs/<id>/debugger-output.yaml `diagnosis.confidence`.
 * Mirrors the enum enforced by validate-yaml.rb.
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * Risk level derived (server-owned rule) from contracted issue severities —
 * never inferred from free-form prose. "none" = no review issues assessed.
 */
export type RiskLevel = "high" | "medium" | "low" | "none";

/** Counts of reviewer-output artifacts[].issues[].severity (contracted enum). */
export interface IssueCounts {
  error: number;
  warning: number;
  suggestion: number;
}

/**
 * Human supervisor decision (Slice 4). Written by the dashboard into
 * runs/<id>/decision.yaml — a NEW input signal, never a mutation of status.yaml.
 * See schemas/decision.schema.yaml.
 */
export type DecisionAction = "approve" | "request_changes" | "escalate" | "reject";

export interface DecisionRecord {
  decision: DecisionAction;
  actor: string;
  note?: string;
  decidedAt: string;
  /** Traceability: the contracted signals this decision was made against. */
  againstVerdict?: ReviewVerdict | null;
  /** Loose string (any phase, incl. future ones) — matches decision.schema.yaml. */
  againstPhase?: string | null;
}

export interface DecisionLogResponse {
  taskId: string;
  decisions: DecisionRecord[];
}

export type ActionKind =
  | 'awaiting_review'
  | 'decision_pending'
  | 'workflow_exception'
  | 'artifact_drift'
  | 'gates_unreadable'
  | 'authorization_required'
  | 'completion_held'
  | 'stale_work';

/**
 * Issue #28 Phase 2F: one completion gate as CompletionGuard.gate_view derives it
 * (scripts/gate-view-json.rb). The dashboard renders it; it never re-derives it.
 */
export interface GateEntry {
  name: string;
  /** As stored: pending | pass | na. */
  status: string;
  /** The done guard's rule (bound gates need a valid grant; records when required). */
  resolved: boolean;
  /** Unresolved gates named in `after`, with their state, e.g. "a (pending)". */
  waitsOn: string[];
  requiresAuthorization: string | null;
  /** Pending bound gates only; unknown = the authorization ledger cannot be read. */
  grant: 'available' | 'missing' | 'unknown' | null;
  requiresRecord: boolean;
  /** The 2C run record of a pass gate (by, ref, url); null otherwise. */
  ran: Record<string, string> | null;
  /** Can pass now: pending, nothing to wait on, grant available when bound, task not finished. */
  passable: boolean;
  unresolvedReason: string | null;
  /** The CLI text after "name: status — "; "" when the CLI adds nothing. */
  detail: string;
}

/** Issue #28 Phase 2F: a task's gates. readable=false means the state cannot be trusted. */
export interface GateView {
  readable: boolean;
  problem: string | null;
  finishedPhase: string | null;
  summary: { total: number; resolved: number; passable: number; byStatus: Record<string, number> };
  gates: GateEntry[];
}

/**
 * Read-only Review read model. Every field is a projection of a contracted
 * producer field — the dashboard renders these, it never infers them from prose.
 * See schemas/run-summary.schema.yaml and docs/run-summary-read-model.md.
 */
export interface ReviewSummary {
  taskId: string;
  /** Provenance: status.yaml `task_label`, falling back to taskId. */
  title: string;
  /** Provenance: status.yaml `phase` (exact enum; null if missing/unrecognized). */
  phase: RunPhase | null;
  /** Provenance: reviewer-output.yaml `review_verdict` (null if never reviewed). */
  verdict: ReviewVerdict | null;
  /** Projection: phase ∈ {review, in_review}. */
  inReviewQueue: boolean;
  /** Projection: verdict ∈ {changes_requested, escalate, infra_failure}. */
  verdictNeedsAttention: boolean;
  /** True only while a human review decision is still required. */
  needsReview: boolean;
  /** True when the Action Center has a classified intervention for this task. */
  requiresAction: boolean;
  /** Server-owned Action Center classification; null when no intervention is required. */
  actionKind: ActionKind | null;
  /** Evidence-backed explanation for why this task is in the Action Center. */
  actionReason: string | null;
  /** Safe next step; this is guidance, not a dashboard-executed workflow action. */
  recommendedAction: string | null;
  /** True when decision.yaml contains a newer decision than status.yaml applied. */
  decisionPending: boolean;
  /** Provenance: status.yaml `updated_at`; null when absent. */
  statusUpdatedAt: string | null;
  /** Provenance: status.yaml `updated_at` when a reviewer-output exists; else null. */
  lastReviewedAt: string | null;
  /** Provenance: debugger-output.yaml `diagnosis.confidence` (exact enum; null if never debugged). */
  confidence: ConfidenceLevel | null;
  /** Provenance: counts of reviewer-output.yaml artifacts[].issues[].severity (exact enum). */
  issueCounts: IssueCounts;
  /** Projection (server-owned rule): error>0 → high; warning>0 → medium; reviewed & clean → low; not reviewed → none. */
  riskLevel: RiskLevel;
  /** Provenance: latest entry in decision.yaml `decisions[]` (human input); null if none. */
  latestDecision: DecisionRecord | null;
  /** Days since status.yaml `updated_at` when past the stale threshold for its phase; else null. */
  idle: { days: number; thresholdDays: number } | null;
  /** Provenance: last status.yaml `history[]` phase transition (gate updates skipped); null if none. Reason is shown verbatim, never classified. */
  lastTransition: { agent: TimelineActor; phase: string; reason: string | null; at: string | null } | null;
  /** Provenance: status.yaml `waits_on` (kind from WAIT_KINDS, optional ref = the task that unblocks it); [] when none. */
  waitsOn: WaitsOnEntry[];
  /** status.yaml carries is non-empty: this run is a release train (a waits_on prod_run of its own is its own run). */
  isReleaseTrain: boolean;
  /** Phase 2F: gate counts; absent for a task without status.yaml `completion_gates`. */
  gates?: { readable: boolean; total: number; resolved: number; passable: number };
}

export interface ReviewModelResponse {
  generatedAt: string;
  total: number;
  needsReviewCount: number;
  actionCount: number;
  actionCounts: Record<ActionKind, number>;
  reviews: ReviewSummary[];
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  currentAgent?: AgentName;
  /**
   * Derived (not a status.yaml field): the operator that drove the most recent
   * history transition (ADR-0003), i.e. who is conducting. Undefined when the
   * run's history never recorded an operator.
   */
  currentConductor?: TimelineActor;
  currentStep?: string;
  workstream?: TaskWorkstream;
  startedAt?: string;
  updatedAt?: string;
  /**
   * Precedence: Explicit status.yaml completed_at -> terminal status updatedAt -> null
   */
  completedAt?: string;
  /**
   * Only calculated if startedAt and completedAt (or now for running) are valid.
   * If missing startedAt, this should be null/undefined.
   */
  durationSeconds?: number;
  runPath: string;
  logPath?: string;
  errorReason?: string;
  /**
   * Precedence: error_reason -> history[last].reason -> history[last].message -> "unknown"
   */
  normalizedReason?: string;
}

export interface ReviewIssue {
  file: string;
  severity: string;
  description: string;
}

/** One status.yaml `waits_on` entry (structured twin of `waiting_for`). */
export interface WaitsOnEntry { kind: import('./waitKinds').WaitKind; ref?: string }

export interface RunDetail extends RunSummary {
  taskMarkdown?: string;
  statusRaw?: unknown;
  outputMarkdown?: string;
  nextActionPreview?: NextActionPreview;
  artifacts: RunArtifact[];
  timeline: AgentTimelineEvent[];
  reviewIssues?: ReviewIssue[];
  /** Phase 2F: absent for a task without status.yaml `completion_gates`. */
  gates?: GateView;
  /** status.yaml `waits_on`, validated; absent when empty. */
  waitsOn?: WaitsOnEntry[];
  /** status.yaml `carries` (release trains); absent when empty. */
  carries?: string[];
}

export interface RunFileResponse {
  name: string;
  content: string;
  truncated: boolean;
}

export interface RunArtifact {
  type: "markdown" | "patch" | "log" | "json" | "yaml" | "other" | "directory";
  name: string;
  path: string;
  /** Directories only: entries inside (dotfiles excluded). */
  count?: number;
}

export interface AgentTimelineEvent {
  id: string;
  agent: TimelineActor;
  agentKind: AgentKind;
  action: string;
  status?: RunStatus;
  timestamp?: string;
  message?: string;
}

export interface DashboardStats {
  totalRuns: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  successRate: number;
}

export type FlowHealthStatus = "ok" | "warning" | "error";

/**
 * Insights "Flow" read model (GET /api/analytics/flow). Stuck, waits and health
 * describe open work right now and ignore the window; throughput and movers are
 * windowed. Every number is derived from runs/, the review model and history.
 */
export interface FlowPhaseWait {
  phase: string;
  count: number;
  /** Longest wait since the last status change among runs in this phase. */
  oldestDays: number | null;
}

export interface FlowHealthFactor {
  label: "failed" | "idle" | "unreadable" | "blocked";
  count: number;
  perTask: number;
  impact: number;
  detail: string;
}

export interface FlowHealth {
  score: number;
  status: FlowHealthStatus;
  factors: FlowHealthFactor[];
}

export interface FlowDay {
  date: string;
  opened: number;
  closed: number;
}

export interface FlowMover {
  actor: TimelineActor;
  kind: AgentKind;
  transitions: number;
}

export interface FlowInsights {
  generatedAt: string;
  windowDays: number;
  stuck: {
    open: number;
    /** Open runs the Action Center flags (ReviewSummary.requiresAction). */
    needsYou: number;
    /** Of needsYou, runs already closed (e.g. artifact drift on a done run); Attention lists them too. */
    needsYouClosed: number;
    idle: number;
    blocked: number;
    oldestDays: number | null;
    /** Per Action Center kind; each links to Attention filtered by it. */
    byKind: { kind: ActionKind; count: number }[];
  };
  waits: FlowPhaseWait[];
  health: FlowHealth;
  throughput: {
    /** Completed runs whose completedAt is inside the window. */
    closed: number;
    /** Runs whose startedAt is inside the window. */
    opened: number;
    cycleDays: { median: number | null; p90: number | null; sample: number };
    days: FlowDay[];
  };
  movers: {
    /** Phase transitions (gate updates excluded) recorded in history inside the window. */
    roles: FlowMover[];
    conductors: FlowMover[];
    runsWithTransitions: number;
    runsWithConductor: number;
  };
}

/**
 * Insights › Readiness: the release ladder. Every cell is a status.yaml
 * completion gate as CompletionGuard.gate_view reports it; the dashboard never
 * infers a rung from phase, branch state or prose.
 */
export type { ReleaseRung } from './releaseLadder';
import type { ReleaseRung } from './releaseLadder';

export interface ReleaseRungCell {
  /** As stored: pass | pending | na; "absent" when the task defines no such gate. */
  status: "pass" | "pending" | "na" | "absent" | string;
  /** The 2C run record of a pass gate (by, ref, url); null otherwise. */
  ran: Record<string, string> | null;
  /** Pending bound gates only. */
  grant: "available" | "missing" | "unknown" | null;
  /** Credited from this release train's gate of the same name (status.yaml `carries`); absent when the task's own gate. */
  via?: string;
  /** The task's own gate this rung was read from when its name differs (authenticated_staging → staging_acceptance). */
  from?: string;
}

export interface ReleaseLadderTask {
  id: string;
  title: string;
  status: RunStatus;
  phase?: string;
  updatedAt?: string;
  /** Highest ladder rung with status pass; null when none has passed. */
  highest: ReleaseRung | null;
  rungs: Record<ReleaseRung, ReleaseRungCell>;
  /** Gates outside the ladder (shared_lib_publication, prod_claim_census, …). */
  extra: { name: string; status: string }[];
  /**
   * The next thing a production run would prove: deploy_production or
   * production_acceptance is the first unresolved ladder rung.
   */
  waitingOnProd: boolean;
  /** Highest rung is staging_acceptance and both production rungs are absent. */
  noProdGates: boolean;
  /** Gate state could not be trusted (CompletionGuard problem). */
  unreadable: string | null;
  /** This task is a release train: the tasks it carries. */
  carries: string[];
  /** Release trains carrying this task. */
  carriedBy: string[];
  /**
   * Carrying trains that still have to pass this task's next open production rung.
   * Several names mean one production run is not enough (each train must pass).
   */
  pendingTrains: string[];
}

export interface ReleaseLadderProduct {
  id: string;
  name: string;
  taskPrefix: string;
  counts: {
    byHighest: Record<ReleaseRung | "none", number>;
    waitingOnProd: number;
    /** Staging-accepted tasks whose status.yaml declares neither production gate: a prod run proves nothing for them under the contract. */
    noProdGates: number;
    unreadable: number;
    noGates: number;
    /** Release trains (runs with carries): listed in the table, not counted as tasks on the ladder. */
    trains: number;
  };
  tasks: ReleaseLadderTask[];
  /** Open tasks whose status.yaml waits_on has kind prod_run: what one production run would also unblock. */
  unblockedByProdRun: { id: string; title: string; ref?: string }[];
  /** Runs without completion_gates (before 2026-10-07 the contract did not exist): readiness unknown, never assumed. */
  noGates: { id: string; title: string; status: RunStatus; updatedAt?: string }[];
}

export interface ReleaseLadderResponse {
  generatedAt: string;
  ladder: { rung: ReleaseRung; label: string }[];
  products: ReleaseLadderProduct[];
}

export type KnowledgeReviewWriteMode = "proposal_only" | "approved_scope_auto_write";
export type KnowledgeReviewMode = "pre_write" | "post_write";
export type KnowledgeFindingStatus = "new" | "recurring" | "resolved" | "suppressed";
export type KnowledgeFindingPriority = "critical" | "high" | "medium" | "low";
export type KnowledgeEvidenceState = "confirmed" | "partial" | "missing" | "conflicted";
export type KnowledgeFindingPriorityCounts = Partial<Record<KnowledgeFindingPriority, number>>;

export interface KnowledgeReviewScope {
  product: string;
  paths: string[];
  maxNotes: number;
  timeboxMinutes: number;
}

export interface KnowledgeReviewSummary {
  reviewId: string;
  generatedAt: string;
  scope: KnowledgeReviewScope;
  writeMode: KnowledgeReviewWriteMode;
  reviewMode: KnowledgeReviewMode;
  requiresHumanReview: true;
  notesReviewedCount: number;
  findingsCount: number;
  changesCount: number;
  appliedChangesCount: number;
  summary: string;
  priorityCounts?: KnowledgeFindingPriorityCounts;
}

export interface KnowledgeReviewFinding {
  fingerprint: string;
  notePath: string;
  question: string;
  issueType: string;
  status: KnowledgeFindingStatus;
  priority: KnowledgeFindingPriority;
  evidenceState: KnowledgeEvidenceState;
  verificationScope: string;
  sources: string[];
  recommendedAction: string;
  /** Provenance: closure_criteria (required by the librarian schema); shown and matched, never rewritten. */
  closureCriteria: string;
  answer: string;
  confidence: "high" | "medium" | "low";
}

export interface KnowledgeReviewChange {
  notePath: string;
  targetClass: string;
  action: string;
  disposition: "proposed" | "applied";
  findingFingerprint: string;
  resultingStatus: string | null;
  summary: string;
}

export interface KnowledgeReviewDetail extends KnowledgeReviewSummary {
  authorization: {
    approvedScope: string;
    policySource: string;
    approvedBy: string;
    approvedAt: string;
  } | null;
  notesReviewed: string[];
  findings: KnowledgeReviewFinding[];
  changes: KnowledgeReviewChange[];
}

export interface KnowledgeReviewsResponse {
  generatedAt: string;
  total: number;
  invalidCount: number;
  invalidFiles: string[];
  /** Why each invalid file was dropped (validator errors, or a duplicate reviewId); its findings are not counted. */
  invalid: { file: string; errors: string[] }[];
  reviews: KnowledgeReviewSummary[];
}

/**
 * One finding fingerprint whose latest audit (by generatedAt) still reports it
 * as new or recurring. "Open" is an upper bound: a note fixed since then stays
 * open until a later audit marks the fingerprint resolved or suppressed.
 */
export interface KnowledgeOpenFinding {
  fingerprint: string;
  /** notePath with a leading `knowledge-base/` repo prefix removed (same vault). */
  notePath: string;
  /** Grouping folder: up to two directory levels under `Knowledge Base/`, else under the repo. */
  folder: string;
  question: string;
  priority: KnowledgeFindingPriority;
  status: KnowledgeFindingStatus;
  evidenceState: KnowledgeEvidenceState;
  recommendedAction: string;
  /**
   * Only a human can close it (product/architecture choice): recommended_action
   * is append_review_queue and the fingerprint or closure_criteria names a human
   * decision. Excluded from automated re-check runs.
   */
  needsHumanDecision: boolean;
  /** Number of audits that reported this fingerprint. */
  timesReported: number;
  firstReportedAt: string;
  lastReportedAt: string;
  /** The latest audit that reported it. */
  reviewId: string;
  /** The finding's closure_criteria (what closes it), shown to the person deciding. */
  closureCriteria: string;
  /** Only for needsHumanDecision findings: what kind of answer the question asks for (a hint). */
  decisionKind?: KnowledgeDecisionKind;
  /** The operator's latest answer from the decision queue, if any. */
  humanDecision?: KnowledgeHumanDecision;
  /**
   * The answer is waiting for the next re-check run: answered after the latest audit
   * that reported the finding, and not a deferral.
   */
  decisionPending?: boolean;
}

export type KnowledgeBriefAudience = "human" | "task";

/** One Librarian re-check run's scope (GET /api/knowledge-reviews/findings/brief). */
export interface KnowledgeRecheckBrief {
  generatedAt: string;
  audience: KnowledgeBriefAudience;
  /** Paste-ready text for the Librarian. */
  text: string;
  notes: {
    notePath: string;
    /** Open findings on this note left out by the per-run cap. */
    remaining: number;
    findings: { fingerprint: string; priority: KnowledgeFindingPriority; evidenceState: KnowledgeEvidenceState; lastReportedAt: string; reviewId: string; question: string }[];
  }[];
  /** Open findings considered (after audience filters) and how many notes wait for a later run. */
  considered: number;
  totalOpen: number;
  remainingNotes: number;
  limits: { maxNotes: number; maxFindings: number };
  /** Findings left out because only a human can close them (answered in Knowledge › Decisions). */
  humanDecisionsExcluded: number;
  /** Task briefs: operator answers from the decision queue waiting to be recorded by this run. */
  answers: { decisionId: string; fingerprint: string; notePath: string; question: string; answer: KnowledgeDecisionAnswer; note?: string; actor: string; decidedAt: string }[];
}

export interface KnowledgeOpenFindingsResponse {
  generatedAt: string;
  /** Distinct fingerprints across every valid audit, by their latest status. */
  totals: { fingerprints: number; open: number; resolved: number; suppressed: number };
  items: KnowledgeOpenFinding[];
}

export type SocraticodeConnectionStatus = "active" | "unknown" | "unavailable" | "error" | "skipped";
export type SocraticodeBackend = "remote" | "local-docker" | "none";

export interface SocraticodeStatus {
  status: SocraticodeConnectionStatus;
  backend: SocraticodeBackend;
  /** Backends the dashboard probe was configured to try, in order. */
  attemptedBackends?: Array<Exclude<SocraticodeBackend, "none">>;
  projectPath?: string;
  checkedAt: string;
  message?: string;
}

export interface HealthStatus {
  ok: boolean;
  status: "ok" | "warning" | "error";
  aiOfficeRoot: string;
  timestamp: string;
  uptime?: number;
  totalRuns?: number;
  runsDirExists: boolean;
  logsDirExists: boolean;
  watcherActive: boolean;
  paths: {
    runsDir: string;
    logsDir: string;
  };
  config: {
    port: number;
    sseHeartbeatMs: number;
    logTailLines: number;
  };
  watcher: {
    active: boolean;
    debounceMs: number;
  };
  socraticode: SocraticodeStatus;
  error?: string;
}

export type WatcherEventType = "add" | "change" | "unlink";

export interface WatcherUpdate {
  type: "runs.changed";
  events: WatcherEventType[];
  paths: string[];
  timestamp: string;
}

export type DashboardSseEvent = WatcherUpdate;

/**
 * Owner Intake Review (M5). Mirrors `dashboard/server/src/intake/reviewStore.ts`
 * exactly — the review router (`/api/intake/review/*`) projects these shapes
 * verbatim, so the client can import them from here instead of duplicating.
 */



export interface LogTailResponse {
  content: string;
  size: number;
  bytesRead: number;
  truncated: boolean;
  strategy: "full-read-tail" | "reverse-chunk-tail";
}

/**
 * Command › Attention › Production signals (GET /api/signals). Recurring ERROR
 * log groups read from CloudWatch for ECS services that are running, matched to
 * the TASK runs that mention them. Read-only; the dashboard never opens runs.
 */
export type SignalEnv = 'prod' | 'staging';
/**
 * unowned: no open or recently closed run mentions it. recurs_after: a run closed in the window
 * mentions it and it failed after that close. closed_recently: a run closed in the window mentions
 * it, and every failure is from before (or the same day as) that close — the owner just finished.
 * mentioned: an open run mentions it.
 */
export type SignalCoverage = 'unowned' | 'recurs_after' | 'closed_recently' | 'mentioned';

export interface SignalTaskRef {
  id: string;
  title: string;
  status: RunStatus;
  /** completedAt for a closed run (recurs_after); undefined for open runs. */
  completedAt?: string;
  /** The search terms found in that run's files. */
  terms: string[];
}

export interface SignalGroup {
  key: string;
  cluster: string;
  product: string;
  taskPrefix: string;
  service: string;
  logGroup: string;
  signature: string;
  /** Unique failures: log lines sharing a request/correlation id count once. */
  failures: number;
  logLines: number;
  firstAt: string;
  lastAt: string;
  /** Distinct clock hours with at least one failure. */
  hours: number;
  recurring: boolean;
  /** Selected fields only, with ids, IPs, emails and long numbers redacted. */
  sample: string;
  /**
   * Set when its log was not read to the start of the window (cap or time budget): the counts
   * are minimums and cover only this ISO time onward (read newest first).
   */
  partialSince?: string;
  /** Phrase used for the reproduce command (CloudWatch filter pattern). */
  searchPhrase: string;
  terms: string[];
  coverage: SignalCoverage;
  mentionedBy: SignalTaskRef[];
  recursAfter: SignalTaskRef[];
  /** Runs closed in the window that mention it, with no failure after their close. */
  closedRecently: SignalTaskRef[];
}

export interface SignalClusterState {
  cluster: string;
  product: string;
  taskPrefix: string;
  status: 'ok' | 'not_running' | 'error';
  servicesRunning: number;
  sourcesRead: number;
  sourcesWithErrors: number;
  truncated: boolean;
  warnings: string[];
  error?: string;
}

export interface ProdSignalsResponse {
  generatedAt: string;
  env: SignalEnv;
  windowHours: number;
  closedWindowDays: number;
  awsProfile: string;
  region: string;
  clusters: SignalClusterState[];
  groups: SignalGroup[];
  counts: Record<SignalCoverage, number>;
  /**
   * The cached result was older than cache_minutes: this is it, served at once while a fresh read
   * runs in the background (fetch again shortly). generatedAt says how old it is.
   */
  refreshing?: boolean;
}

/**
 * Knowledge › Decisions: the operator answers a human-decision finding. Answers are
 * an INPUT ledger (knowledge-reviews/decisions/human-decisions.yaml); finding status
 * still changes only when the next Librarian audit records it (closure spec D4, amended
 * 2026-10-15: the operator chose to answer from the dashboard).
 */
export type KnowledgeDecisionKind = 'duplicate_proposal' | 'status_check' | 'approval' | 'product';
export type KnowledgeDecisionAnswer =
  | 'existing_proposal_enough'
  | 'still_true'
  | 'no_longer_true'
  | 'check_it'
  | 'approve'
  | 'reject'
  | 'answer'
  | 'defer';

export interface KnowledgeHumanDecision {
  id: string;
  fingerprint: string;
  answer: KnowledgeDecisionAnswer;
  note?: string;
  actor: string;
  decidedAt: string;
  /** Snapshot of what was answered, so the ledger reads on its own. */
  question: string;
  notePath: string;
}
