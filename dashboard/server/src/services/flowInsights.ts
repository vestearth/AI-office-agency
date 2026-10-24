import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type {
  ActionKind,
  FlowHealth,
  FlowHealthFactor,
  FlowInsights,
  FlowMover,
  FlowPhaseWait,
  ReviewSummary,
  RunSummary,
} from '@shared/types';
import { FLOW_BACKLOG_DAYS } from '../../../shared/flow';
import { isActiveStatus } from '../../../shared/runCounts';
import { config } from '../config';
import { RunScanner, globalScanner, asObject, classifyActor, rowOperator } from './runScanner';
import { ReviewModelService, globalReviewModel } from './reviewModel';
import { dayOf, localDay, officeMs } from './officeTime';

// Insights "Flow": where open work is stuck (current state, never windowed, so
// long-running blocks cannot fall out of view) and how fast work closes (windowed).

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** A first history timestamp this close to created_at (a date) is when the run opened. */
const START_MATCH_MS = 36 * HOUR_MS;
const HEALTH_OK_THRESHOLD = 90;
const HEALTH_WARNING_THRESHOLD = 70;

// Operator decision 2026-10-14: a flat per-task penalty, each factor explained.
export const HEALTH_PENALTY = { failed: 10, idle: 5, unreadable: 5, blocked: 2 } as const;

export interface HistoryEntry { agent?: unknown; phase?: unknown; at?: unknown; operator?: unknown }

export interface BuildFlowInput {
  runs: RunSummary[];
  reviews: ReviewSummary[];
  /** status.yaml history per task id; only runs that can have in-window activity need to be present. */
  histories: Map<string, HistoryEntry[]>;
  now: Date;
  windowDays: number;
}

function daysSince(value: string | null | undefined, now: Date): number | null {
  const t = officeMs(value);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
}

function maxOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.max(...known) : null;
}

/** A history `at` with a time of day (a bare date says nothing about hours). */
function timestamp(at: unknown): number {
  if (at instanceof Date) return at.getTime();
  return typeof at === 'string' && at.includes('T') ? Date.parse(at) : NaN;
}

const DONE_PHASE = /->\s*(done|completed)\s*$/;
const ABORT_PHASE = /->\s*(aborted|cancelled)\s*$/;

/**
 * When a closed or aborted run ended: its last timed transition into done/aborted, else the
 * date-only completed_at. Lanes write that date as the UTC or the local date, so the timed
 * entry decides the local day (TASK-VS-031 closed 02:19 ICT 10-17 with completed_at 10-16).
 */
export function endedAt(run: RunSummary, history: HistoryEntry[] = []): number {
  const pattern = run.status === 'cancelled' ? ABORT_PHASE : DONE_PHASE;
  const entry = [...history].reverse().find((h) => typeof h.phase === 'string' && pattern.test(h.phase) && Number.isFinite(timestamp(h.at)));
  return entry ? timestamp(entry.at) : officeMs(run.completedAt);
}

/**
 * Open-to-done span of a closed run. created_at/completed_at are dates, so history
 * timestamps win when they fit: the first one if it lies near created_at (a history
 * rewritten later does not), the last transition into done for the end.
 */
export function cycleSpan(run: RunSummary, history: HistoryEntry[] = []): { ms: number; timed: boolean } | null {
  const created = officeMs(run.startedAt);
  const first = history.map((h) => timestamp(h.at)).find(Number.isFinite);
  const startTimed = first !== undefined && (!Number.isFinite(created) || Math.abs(first - created) <= START_MATCH_MS);
  const start = startTimed ? first! : created;
  const doneAt = [...history].reverse().find((h) => typeof h.phase === 'string' && DONE_PHASE.test(h.phase) && Number.isFinite(timestamp(h.at)));
  const end = doneAt ? timestamp(doneAt.at) : officeMs(run.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { ms: Math.max(0, end - start), timed: startTimed && Boolean(doneAt) };
}

/** Nearest-rank percentile over a sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return Math.round(sorted[rank - 1] * 10) / 10;
}

interface OpenRun { phase: string | null; actionKind: ActionKind | null; idleDays: number | null; waitingDays: number | null }

export function buildFlowHealth(counts: Record<FlowHealthFactor['label'], number>): FlowHealth {
  const factors: FlowHealthFactor[] = ([
    ['failed', 'validation failed'],
    ['idle', 'idle past the phase threshold'],
    ['unreadable', 'status.yaml unreadable'],
    ['blocked', 'blocked'],
  ] as const).map(([label, noun]) => {
    const count = counts[label];
    const perTask = HEALTH_PENALTY[label];
    return { label, count, perTask, impact: count ? -(count * perTask) : 0, detail: `${count} ${noun} × −${perTask}` };
  });
  const score = Math.max(0, Math.min(100, 100 + factors.reduce((sum, f) => sum + f.impact, 0)));
  const status = score >= HEALTH_OK_THRESHOLD ? 'ok' : score >= HEALTH_WARNING_THRESHOLD ? 'warning' : 'error';
  return { score, status, factors };
}

export function buildFlowInsights({ runs, reviews, histories, now, windowDays }: BuildFlowInput): FlowInsights {
  const reviewById = new Map(reviews.map((r) => [r.taskId, r]));
  const open = runs.filter((run) => isActiveStatus(run.status));

  // --- Stuck now (current state; the list itself lives in Attention) ---
  const openItems: OpenRun[] = open.map((run) => {
    const review = reviewById.get(run.id);
    return {
      phase: review?.phase ?? null,
      actionKind: review?.actionKind ?? null,
      idleDays: review?.idle?.days ?? null,
      waitingDays: daysSince(review?.statusUpdatedAt ?? run.updatedAt, now),
    };
  });

  // Same set as needsYou (Attention's count): a closed run with artifact drift gets its chip too.
  const kindCounts = new Map<ActionKind, number>();
  for (const run of runs) {
    const review = reviewById.get(run.id);
    if (review?.requiresAction && review.actionKind) kindCounts.set(review.actionKind, (kindCounts.get(review.actionKind) ?? 0) + 1);
  }

  const idle = openItems.filter((item) => item.idleDays !== null).length;
  const blocked = open.filter((run) => run.status === 'blocked').length;

  // --- Where it waits (current state) ---
  const byPhase = new Map<string, OpenRun[]>();
  for (const item of openItems) {
    const key = item.phase ?? 'unknown';
    byPhase.set(key, [...(byPhase.get(key) ?? []), item]);
  }
  const waits: FlowPhaseWait[] = [...byPhase].map(([phase, list]) => ({
    phase, count: list.length, oldestDays: maxOrNull(list.map((item) => item.waitingDays)),
  })).sort((a, b) => b.count - a.count || (b.oldestDays ?? -1) - (a.oldestDays ?? -1));

  const health = buildFlowHealth({
    failed: open.filter((run) => run.status === 'failed').length,
    idle,
    unreadable: runs.filter((run) => run.status === 'unknown').length,
    blocked,
  });

  // --- Throughput (windowed) ---
  // The window starts at local midnight of the first bar, so counts equal the sum of the bars.
  const cutoff = officeMs(localDay(now.getTime() - (windowDays - 1) * DAY_MS));
  const inWindowMs = (t: number) => Number.isFinite(t) && t >= cutoff && t <= now.getTime();
  const inWindow = (value: string | undefined) => inWindowMs(officeMs(value));
  const ended = (run: RunSummary) => endedAt(run, histories.get(run.id));
  const closedRuns = runs.filter((run) => run.status === 'completed' && inWindowMs(ended(run)));
  const openedRuns = runs.filter((run) => inWindow(run.startedAt));
  const abortedRuns = runs.filter((run) => run.status === 'cancelled' && inWindowMs(ended(run)));
  const spans = closedRuns.map((run) => cycleSpan(run, histories.get(run.id))).filter((s): s is { ms: number; timed: boolean } => s !== null);
  const freshHours = spans.filter((s) => s.ms <= FLOW_BACKLOG_DAYS * DAY_MS).map((s) => s.ms / HOUR_MS).sort((a, b) => a - b);
  const backlogDays = spans.filter((s) => s.ms > FLOW_BACKLOG_DAYS * DAY_MS).map((s) => Math.floor(s.ms / DAY_MS));
  const days = Array.from({ length: windowDays }, (_, i) => {
    const date = localDay(now.getTime() - (windowDays - 1 - i) * DAY_MS);
    return {
      date,
      opened: openedRuns.filter((run) => dayOf(run.startedAt) === date).length,
      closed: closedRuns.filter((run) => localDay(ended(run)) === date).length,
      aborted: abortedRuns.filter((run) => localDay(ended(run)) === date).length,
    };
  });

  // --- Who moved work (windowed, from history) ---
  // A phase change counts as a move; created -> … is an opening, reported apart; X -> X
  // (notes, evidence, metadata) is not a move. Gate updates are not phase entries.
  const roleCounts = new Map<string, FlowMover>();
  const conductorCounts = new Map<string, FlowMover>();
  let runsWithTransitions = 0;
  let runsWithConductor = 0;
  let opened = 0;
  let samePhaseUpdates = 0;
  for (const [, history] of histories) {
    let moved = false;
    let conducted = false;
    for (const entry of history) {
      const phase = typeof entry.phase === 'string' ? entry.phase : '';
      if (!phase.includes('->') || phase.startsWith('gate ')) continue;
      if (!inWindow(typeof entry.at === 'string' ? entry.at : entry.at instanceof Date ? entry.at.toISOString() : undefined)) continue;
      const [from, to] = phase.split('->').map((p) => p.trim());
      if (from === to) { samePhaseUpdates++; continue; }
      const opening = from === 'created';
      // A row counts once for its role and once for its operator (the field, or free text in agent).
      const actor = classifyActor(typeof entry.agent === 'string' ? entry.agent : undefined);
      const operator = rowOperator(entry);
      const counted: Array<[Map<string, FlowMover>, FlowMover['actor'], FlowMover['kind']]> = [];
      if (actor.kind !== 'operator') counted.push([roleCounts, actor.name, actor.kind]);
      if (operator) counted.push([conductorCounts, operator, 'operator']);
      for (const [bucket, name, kind] of counted) {
        const cur = bucket.get(name) ?? { actor: name, kind, transitions: 0, opened: 0 };
        if (opening) cur.opened++; else cur.transitions++;
        bucket.set(name, cur);
      }
      if (opening) opened++; else { moved = true; if (operator) conducted = true; }
    }
    if (moved) runsWithTransitions++;
    if (conducted) runsWithConductor++;
  }
  const byTransitions = (a: FlowMover, b: FlowMover) => b.transitions - a.transitions || b.opened - a.opened || a.actor.localeCompare(b.actor);

  return {
    generatedAt: now.toISOString(),
    windowDays,
    stuck: {
      open: open.length,
      // Same count as Attention: a closed run can still need a human (artifact drift on a done run).
      needsYou: runs.filter((run) => reviewById.get(run.id)?.requiresAction).length,
      needsYouClosed: runs.filter((run) => !open.includes(run) && reviewById.get(run.id)?.requiresAction).length,
      idle,
      blocked,
      oldestDays: maxOrNull(openItems.map((item) => item.waitingDays)),
      byKind: [...kindCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    },
    waits,
    health,
    throughput: {
      closed: closedRuns.length,
      opened: openedRuns.length,
      aborted: abortedRuns.length,
      cycle: {
        sample: spans.length,
        timed: spans.filter((s) => s.timed).length,
        fresh: { count: freshHours.length, medianHours: percentile(freshHours, 50), p90Hours: percentile(freshHours, 90) },
        backlog: { count: backlogDays.length, oldestDays: maxOrNull(backlogDays) },
      },
      days,
    },
    movers: {
      roles: [...roleCounts.values()].sort(byTransitions),
      conductors: [...conductorCounts.values()].sort(byTransitions),
      runsWithTransitions,
      runsWithConductor,
      opened,
      samePhaseUpdates,
    },
  };
}

export class FlowInsightsService {
  constructor(
    private readonly scanner: RunScanner = globalScanner,
    private readonly reviewModel: ReviewModelService = globalReviewModel,
    private readonly runsDir: string = config.runsDir,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(windowDays: number): Promise<FlowInsights> {
    const now = this.clock();
    const [runs, reviews] = await Promise.all([this.scanner.listRuns(), this.reviewModel.getReviewSummaries()]);
    // A transition inside the window means updated_at is at least that recent, so
    // only those runs' history needs reading (~tens of files, not every run).
    const cutoff = now.getTime() - windowDays * DAY_MS;
    const candidates = runs.filter((run) => { const t = officeMs(run.updatedAt); return Number.isFinite(t) && t >= cutoff; });
    const histories = new Map<string, HistoryEntry[]>();
    await Promise.all(candidates.map(async (run) => {
      try {
        const data = asObject(yaml.load(await fs.readFile(path.join(this.runsDir, run.id, 'status.yaml'), 'utf8')));
        if (Array.isArray(data.history)) histories.set(run.id, data.history.filter((h: unknown) => h && typeof h === 'object'));
      } catch { /* unreadable status.yaml is already counted by health */ }
    }));
    return buildFlowInsights({ runs, reviews, histories, now, windowDays });
  }
}
