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
import { isActiveStatus } from '../../../shared/runCounts';
import { config } from '../config';
import { RunScanner, globalScanner, asObject, classifyActor } from './runScanner';
import { ReviewModelService, globalReviewModel } from './reviewModel';

// Insights "Flow": where open work is stuck (current state, never windowed, so
// long-running blocks cannot fall out of view) and how fast work closes (windowed).

const DAY_MS = 24 * 60 * 60 * 1000;
const HEALTH_OK_THRESHOLD = 90;
const HEALTH_WARNING_THRESHOLD = 70;

// Operator decision 2026-10-14: a flat per-task penalty, each factor explained.
export const HEALTH_PENALTY = { failed: 10, idle: 5, unreadable: 5, blocked: 2 } as const;

export interface HistoryEntry { agent?: unknown; phase?: unknown; at?: unknown }

export interface BuildFlowInput {
  runs: RunSummary[];
  reviews: ReviewSummary[];
  /** status.yaml history per task id; only runs that can have in-window activity need to be present. */
  histories: Map<string, HistoryEntry[]>;
  now: Date;
  windowDays: number;
}

function ms(value: string | null | undefined): number {
  return value ? Date.parse(value) : NaN;
}

function daysSince(value: string | null | undefined, now: Date): number | null {
  const t = ms(value);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY_MS)) : null;
}

function maxOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.max(...known) : null;
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

  const kindCounts = new Map<ActionKind, number>();
  for (const item of openItems) if (item.actionKind) kindCounts.set(item.actionKind, (kindCounts.get(item.actionKind) ?? 0) + 1);

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
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const inWindow = (value: string | undefined) => { const t = ms(value); return Number.isFinite(t) && t >= cutoff && t <= now.getTime(); };
  const closedRuns = runs.filter((run) => run.status === 'completed' && inWindow(run.completedAt));
  const openedRuns = runs.filter((run) => inWindow(run.startedAt));
  const cycles = closedRuns
    .map((run) => (ms(run.completedAt) - ms(run.startedAt)) / DAY_MS)
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const days = Array.from({ length: windowDays }, (_, i) => {
    const date = new Date(now.getTime() - (windowDays - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return {
      date,
      opened: openedRuns.filter((run) => run.startedAt?.slice(0, 10) === date).length,
      closed: closedRuns.filter((run) => run.completedAt?.slice(0, 10) === date).length,
    };
  });

  // --- Who moved work (windowed, from history) ---
  const roleCounts = new Map<string, FlowMover>();
  const conductorCounts = new Map<string, FlowMover>();
  let runsWithTransitions = 0;
  let runsWithConductor = 0;
  for (const [, history] of histories) {
    let moved = false;
    let conducted = false;
    for (const entry of history) {
      const phase = typeof entry.phase === 'string' ? entry.phase : '';
      if (!phase.includes('->') || phase.startsWith('gate ')) continue;
      if (!inWindow(typeof entry.at === 'string' ? entry.at : entry.at instanceof Date ? entry.at.toISOString() : undefined)) continue;
      const actor = classifyActor(typeof entry.agent === 'string' ? entry.agent : undefined);
      const bucket = actor.kind === 'operator' ? conductorCounts : roleCounts;
      const cur = bucket.get(actor.name) ?? { actor: actor.name, kind: actor.kind, transitions: 0 };
      cur.transitions++;
      bucket.set(actor.name, cur);
      moved = true;
      if (actor.kind === 'operator') conducted = true;
    }
    if (moved) runsWithTransitions++;
    if (conducted) runsWithConductor++;
  }
  const byTransitions = (a: FlowMover, b: FlowMover) => b.transitions - a.transitions || a.actor.localeCompare(b.actor);

  return {
    generatedAt: now.toISOString(),
    windowDays,
    stuck: {
      open: open.length,
      needsYou: open.filter((run) => reviewById.get(run.id)?.requiresAction).length,
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
      cycleDays: { median: percentile(cycles, 50), p90: percentile(cycles, 90), sample: cycles.length },
      days,
    },
    movers: {
      roles: [...roleCounts.values()].sort(byTransitions),
      conductors: [...conductorCounts.values()].sort(byTransitions),
      runsWithTransitions,
      runsWithConductor,
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
    const candidates = runs.filter((run) => { const t = ms(run.updatedAt); return Number.isFinite(t) && t >= cutoff; });
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
