import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type {
  GateView, ReleaseLadderProduct, ReleaseLadderResponse, ReleaseLadderTask, ReleaseRung, ReleaseRungCell, RunSummary,
} from '@shared/types';
// Runtime values use the relative path: the @shared alias is type-only under ts-node (see runCounts).
import { KNOWLEDGE_CLOSEOUT_GATE, RELEASE_LADDER, RUNG_ALIASES, RUNG_LABEL } from '../../../shared/releaseLadder';

export { RUNG_ALIASES };
import { isOwnRunWait } from '../../../shared/waitKinds';
import { config } from '../config';
import { RunScanner, globalScanner, asObject } from './runScanner';
import { GateViewService, globalGateViews, hasCompletionGates } from './gateView';

// Insights › Readiness: which rung of the release ladder each task has proven,
// per product, straight from completion gates. "done" is not a rung: 14 of the
// first 19 gated done runs never passed production_acceptance (2026-10-15).

// Task prefixes are project codes here (office.team.yaml, Option A); the
// product names are the dashboard's, not a contract.
const PRODUCTS: Record<string, string> = { EAR: 'Games Labs', VS: 'VerifySlip', KAS: 'Casper', GW: 'Event gateway', TASK: 'Legacy runs (no prefix)' };
const LOAD_CONCURRENCY = 4;

export function taskPrefix(id: string): string {
  return id.match(/^TASK-([A-Z][A-Z0-9]*)-\d+$/)?.[1] ?? 'TASK';
}

const RUNG_INDEX = new Map(RELEASE_LADDER.map((rung, i) => [rung, i]));

const PROD_RUNGS: ReleaseRung[] = ['deploy_production', 'production_acceptance'];

export interface LadderEntry {
  run: RunSummary;
  /** null: the run declares no completion_gates. */
  gates: GateView | null;
  /** status.yaml `carries` when this run is a release train. */
  carries?: string[];
  /** status.yaml `waits_on` kinds/refs (only prod_run matters here). */
  waitsOn?: { kind: string; ref?: string }[];
}

function ownCells(gates: GateView | null): Record<ReleaseRung, ReleaseRungCell> {
  const byName = new Map((gates?.gates ?? []).map((g) => [g.name, g]));
  return Object.fromEntries(RELEASE_LADDER.map((rung) => {
    const g = byName.get(rung);
    if (g) return [rung, { status: g.status, ran: g.ran, grant: g.grant }];
    const alias = (RUNG_ALIASES[rung] ?? []).find((name) => byName.has(name));
    const a = alias ? byName.get(alias)! : null;
    const cell: ReleaseRungCell = a ? { status: a.status, ran: a.ran, grant: a.grant, from: alias } : { status: 'absent', ran: null, grant: null };
    return [rung, cell];
  })) as Record<ReleaseRung, ReleaseRungCell>;
}

/**
 * One task's ladder. `trains` are the readable release trains carrying it: a
 * production rung the task does not declare itself is taken from a train's gate
 * of the same name. A task carried by several trains has its changes split across
 * them (TASK-EAR-389: Go part on one, backoffice tab on another), so the rung passes
 * only when every carrying train passed it; otherwise it shows the first train still
 * pending. Aborted/cancelled/failed trains never ship and are left out by the caller.
 */
export function ladderTask(run: RunSummary, gates: GateView | null, trains: { id: string; gates: GateView }[] = [], carries: string[] = []): ReleaseLadderTask {
  const rungs = ownCells(gates);
  for (const rung of PROD_RUNGS) {
    if (rungs[rung].status !== 'absent') continue;
    const offered = trains
      .map((train) => ({ train, cell: ownCells(train.gates)[rung] }))
      .filter(({ cell }) => cell.status !== 'absent');
    const best = offered.find(({ cell }) => cell.status !== 'pass') ?? offered[0];
    if (best) rungs[rung] = { ...best.cell, via: best.train.id };
  }
  const readable = gates ? gates.readable : true;
  const nextProd = PROD_RUNGS.find((rung) => rungs[rung].status === 'pending' && rungs[rung].via);
  const pendingTrains = nextProd
    ? trains.filter((t) => { const c = ownCells(t.gates)[nextProd]; return c.status !== 'absent' && c.status !== 'pass'; }).map((t) => t.id)
    : [];
  const highest = [...RELEASE_LADDER].reverse().find((rung) => rungs[rung].status === 'pass') ?? null;
  const firstOpen = RELEASE_LADDER.find((rung) => rungs[rung].status === 'pending');
  const waitingOnProd = readable && (firstOpen === 'deploy_production' || firstOpen === 'production_acceptance');
  const noProdGates = readable && highest === 'staging_acceptance'
    && rungs.deploy_production.status === 'absent' && rungs.production_acceptance.status === 'absent';
  return {
    id: run.id, title: run.title, status: run.status, phase: run.currentStep, updatedAt: run.updatedAt,
    highest, rungs,
    // A gate read as a rung (alias) is shown in that rung, not again under "other gates".
    extra: (gates?.gates ?? []).filter((g) => !RUNG_INDEX.has(g.name as ReleaseRung) && !Object.values(rungs).some((c) => c.from === g.name))
      .map((g) => ({ name: g.name, status: g.status })),
    waitingOnProd,
    noProdGates,
    unreadable: readable ? null : (gates?.problem ?? 'gate state unreadable'),
    carries,
    carriedBy: trains.map((t) => t.id),
    pendingTrains,
  };
}

export function buildReleaseLadder(entries: LadderEntry[], now = new Date()): ReleaseLadderResponse {
  // Readable trains by carried task id, newest train first.
  const trainsFor = new Map<string, { id: string; gates: GateView }[]>();
  for (const { run, gates, carries } of [...entries].sort((a, b) => (b.run.updatedAt ?? '').localeCompare(a.run.updatedAt ?? ''))) {
    if (!carries?.length || !gates?.readable) continue;
    // A train that ended without shipping (aborted → cancelled, failed) carries nothing.
    if (run.status === 'cancelled' || run.status === 'failed') continue;
    for (const id of carries) trainsFor.set(id, [...(trainsFor.get(id) ?? []), { id: run.id, gates }]);
  }
  const products = new Map<string, ReleaseLadderProduct>();
  const productFor = (id: string) => {
    const prefix = taskPrefix(id);
    let product = products.get(prefix);
    if (!product) {
      product = {
        id: prefix.toLowerCase(), name: PRODUCTS[prefix] ?? prefix, taskPrefix: prefix,
        counts: { byHighest: Object.fromEntries([...RELEASE_LADDER, 'none'].map((r) => [r, 0])) as Record<ReleaseRung | 'none', number>, waitingOnProd: 0, noProdGates: 0, unreadable: 0, noGates: 0, trains: 0, aborted: 0 },
        tasks: [], noGates: [], unblockedByProdRun: [],
      };
      products.set(prefix, product);
    }
    return product;
  };
  for (const { run, gates, carries, waitsOn } of entries) {
    const product = productFor(run.id);
    const prodWait = waitsOn?.find((w) => w.kind === 'prod_run');
    // A task a train carries is already listed under what that run would prove.
    const carried = (trainsFor.get(run.id) ?? []).length > 0;
    if (prodWait && !carried && !isOwnRunWait(run.id, Boolean(carries?.length), prodWait) && run.status !== 'completed' && run.status !== 'cancelled') {
      product.unblockedByProdRun.push(prodWait.ref ? { id: run.id, title: run.title, ref: prodWait.ref } : { id: run.id, title: run.title });
    }
    const trains = trainsFor.get(run.id) ?? [];
    // A task without its own gates still has a proven prod rung when a train carries it.
    // The closeout gate every task carries is not a delivery gate (unreadable state never hides here).
    const closeoutOnly = Boolean(gates?.readable) && gates!.gates.length > 0 && gates!.gates.every((g) => g.name === KNOWLEDGE_CLOSEOUT_GATE);
    if ((!gates || closeoutOnly) && trains.length === 0) {
      product.noGates.push({ id: run.id, title: run.title, status: run.status, updatedAt: run.updatedAt });
      product.counts.noGates++;
      continue;
    }
    // An aborted task (status cancelled) will never be proven: not open work on the ladder,
    // only counted (TASK-VS-030 sat under "no rung yet" with every gate na, 2026-10-17).
    if (run.status === 'cancelled') { product.counts.aborted++; continue; }
    const task = ladderTask(run, gates, trains, carries ?? []);
    product.tasks.push(task);
    // A release train is the production run, not a task climbing the ladder.
    if (task.unreadable) product.counts.unreadable++;
    if (task.carries.length > 0) { product.counts.trains++; continue; }
    product.counts.byHighest[task.highest ?? 'none']++;
    if (task.waitingOnProd && task.carries.length === 0) product.counts.waitingOnProd++;
    if (task.noProdGates) product.counts.noProdGates++;
  }
  const rank = (t: ReleaseLadderTask) => (t.highest ? RUNG_INDEX.get(t.highest)! : -1);
  const byUpdated = (a: { updatedAt?: string }, b: { updatedAt?: string }) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  for (const product of products.values()) {
    product.tasks.sort((a, b) => rank(b) - rank(a) || byUpdated(a, b) || a.id.localeCompare(b.id));
    product.noGates.sort((a, b) => byUpdated(a, b) || b.id.localeCompare(a.id));
    product.unblockedByProdRun.sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    generatedAt: now.toISOString(),
    ladder: RELEASE_LADDER.map((rung) => ({ rung, label: RUNG_LABEL[rung] })),
    // Products with gated work first, then by task count.
    products: [...products.values()].sort((a, b) => b.tasks.length - a.tasks.length || b.noGates.length - a.noGates.length || a.name.localeCompare(b.name)),
  };
}

export class ReleaseLadderService {
  constructor(
    private readonly scanner: RunScanner = globalScanner,
    private readonly gateViews: GateViewService = globalGateViews,
    private readonly runsDir: string = config.runsDir,
  ) {}

  async get(): Promise<ReleaseLadderResponse> {
    const runs = await this.scanner.listRuns();
    const entries: LadderEntry[] = new Array(runs.length);
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const i = next++;
        const run = runs[i];
        let statusData: Record<string, unknown> = {};
        try {
          statusData = asObject(yaml.load(await fs.readFile(path.join(this.runsDir, run.id, 'status.yaml'), 'utf8')));
        } catch { /* unreadable status.yaml → no gates known */ }
        // gate_view is a ruby child process per task: only runs that declare gates pay for it.
        const carries = Array.isArray(statusData.carries) ? statusData.carries.filter((id): id is string => typeof id === 'string') : undefined;
        const waitsOn = Array.isArray(statusData.waits_on)
          ? statusData.waits_on.map((w) => asObject(w)).filter((w) => typeof w.kind === 'string').map((w) => ({ kind: String(w.kind), ...(typeof w.ref === 'string' ? { ref: w.ref } : {}) }))
          : undefined;
        entries[i] = { run, carries, waitsOn, gates: hasCompletionGates(statusData) ? await this.gateViews.load(path.join(this.runsDir, run.id)) : null };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, runs.length) }, worker));
    return buildReleaseLadder(entries);
  }
}
