import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { config } from '../config';
import { asObject } from './runScanner';
import type {
  ActionKind, ReviewSummary, RunPhase, ReviewVerdict, ConfidenceLevel, RiskLevel, IssueCounts, DecisionRecord,
} from '@shared/types';
import { DecisionStore } from './decisionStore';
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

function classifyAction(
  phase: RunPhase | null,
  rawPhase: unknown,
  verdict: ReviewVerdict | null,
  decisionPending: boolean,
): ActionClassification | null {
  if (decisionPending) {
    return {
      kind: 'decision_pending',
      reason: 'A human decision is recorded but has not been reconciled into status.yaml.',
      recommendedAction: 'Run the task driver to reconcile the latest decision.',
    };
  }

  if (phase === 'review' || phase === 'in_review') {
    return {
      kind: 'awaiting_review',
      reason: `status.yaml phase = ${phase}; a reviewer decision is required.`,
      recommendedAction: 'Open the Task Command Center and review the evidence.',
    };
  }

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
      escalated: 'Open the Task Command Center and resolve the escalation.',
      validation_failed: 'Inspect validation evidence and route the required fix.',
      devops_needed: 'Review the infrastructure failure and route it to DevOps.',
    };
    return {
      kind: 'workflow_exception',
      reason: `status.yaml phase = ${phase}; operator intervention is required.`,
      recommendedAction: nextByPhase[phase] ?? 'Open the Task Command Center and inspect the workflow state.',
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

/**
 * Server-owned risk rule. Derives only from contracted issue severities (and
 * whether a review happened) — not from prose. `none` = not yet review-assessed.
 */
function deriveRiskLevel(reviewerData: Record<string, any> | null, counts: IssueCounts): RiskLevel {
  if (!reviewerData) return 'none';
  if (counts.error > 0) return 'high';
  if (counts.warning > 0) return 'medium';
  return 'low';
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
): ReviewSummary {
  const phase = normalizePhase(statusData.phase);
  const verdict = reviewerData ? normalizeVerdict(reviewerData.review_verdict) : null;

  const inReviewQueue = phase !== null && IN_REVIEW_PHASES.includes(phase);
  const verdictNeedsAttention = verdict !== null && ATTENTION_VERDICTS.includes(verdict);
  const statusDecisionAppliedAt = text(statusData.decision_applied_at);
  const decisionPending = latestDecision !== null
    && latestDecision.decidedAt !== statusDecisionAppliedAt;
  const action = classifyAction(phase, statusData.phase, verdict, decisionPending);

  const confidence = debuggerData
    ? normalizeConfidence(debuggerData?.diagnosis?.confidence)
    : null;
  const issueCounts = countIssues(reviewerData);
  const riskLevel = deriveRiskLevel(reviewerData, issueCounts);

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
  };
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

  constructor(private readonly runsDir: string = config.runsDir) {
    // Bind the decision store to the same runsDir so injection stays consistent.
    this.decisionStore = new DecisionStore(runsDir);
  }

  async getReviewSummaries(): Promise<ReviewSummary[]> {
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
        const statusData = (await readYamlObject(path.join(runPath, 'status.yaml'))) ?? {};
        // null (not {}) means the output is absent → that signal stays null.
        const reviewerData = await readYamlObject(path.join(runPath, 'reviewer-output.yaml'));
        const debuggerData = await readYamlObject(path.join(runPath, 'debugger-output.yaml'));
        const latestDecision = await this.decisionStore.latest(taskId);
        return buildReviewSummary(taskId, statusData, reviewerData, debuggerData, latestDecision);
      }),
    );

    return summaries;
  }
}

export const globalReviewModel = new ReviewModelService();
