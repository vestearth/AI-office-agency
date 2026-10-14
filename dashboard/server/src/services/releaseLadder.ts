import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type {
  GateView, ReleaseLadderProduct, ReleaseLadderResponse, ReleaseLadderTask, ReleaseRung, ReleaseRungCell, RunSummary,
} from '@shared/types';
// Runtime values use the relative path: the @shared alias is type-only under ts-node (see runCounts).
import { RELEASE_LADDER, RUNG_LABEL } from '../../../shared/releaseLadder';
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

export function ladderTask(run: RunSummary, gates: GateView): ReleaseLadderTask {
  const byName = new Map(gates.gates.map((g) => [g.name, g]));
  const rungs = Object.fromEntries(RELEASE_LADDER.map((rung) => {
    const g = byName.get(rung);
    const cell: ReleaseRungCell = g ? { status: g.status, ran: g.ran, grant: g.grant } : { status: 'absent', ran: null, grant: null };
    return [rung, cell];
  })) as Record<ReleaseRung, ReleaseRungCell>;
  const highest = [...RELEASE_LADDER].reverse().find((rung) => rungs[rung].status === 'pass') ?? null;
  const firstOpen = RELEASE_LADDER.find((rung) => rungs[rung].status === 'pending');
  const waitingOnProd = gates.readable && (firstOpen === 'deploy_production' || firstOpen === 'production_acceptance');
  const noProdGates = gates.readable && highest === 'staging_acceptance'
    && rungs.deploy_production.status === 'absent' && rungs.production_acceptance.status === 'absent';
  return {
    id: run.id, title: run.title, status: run.status, phase: run.currentStep, updatedAt: run.updatedAt,
    highest, rungs,
    extra: gates.gates.filter((g) => !RUNG_INDEX.has(g.name as ReleaseRung)).map((g) => ({ name: g.name, status: g.status })),
    waitingOnProd,
    noProdGates,
    unreadable: gates.readable ? null : (gates.problem ?? 'gate state unreadable'),
  };
}

export function buildReleaseLadder(entries: { run: RunSummary; gates: GateView | null }[], now = new Date()): ReleaseLadderResponse {
  const products = new Map<string, ReleaseLadderProduct>();
  const productFor = (id: string) => {
    const prefix = taskPrefix(id);
    let product = products.get(prefix);
    if (!product) {
      product = {
        id: prefix.toLowerCase(), name: PRODUCTS[prefix] ?? prefix, taskPrefix: prefix,
        counts: { byHighest: Object.fromEntries([...RELEASE_LADDER, 'none'].map((r) => [r, 0])) as Record<ReleaseRung | 'none', number>, waitingOnProd: 0, noProdGates: 0, unreadable: 0, noGates: 0 },
        tasks: [], noGates: [],
      };
      products.set(prefix, product);
    }
    return product;
  };
  for (const { run, gates } of entries) {
    const product = productFor(run.id);
    if (!gates) {
      product.noGates.push({ id: run.id, title: run.title, status: run.status, updatedAt: run.updatedAt });
      product.counts.noGates++;
      continue;
    }
    const task = ladderTask(run, gates);
    product.tasks.push(task);
    product.counts.byHighest[task.highest ?? 'none']++;
    if (task.waitingOnProd) product.counts.waitingOnProd++;
    if (task.noProdGates) product.counts.noProdGates++;
    if (task.unreadable) product.counts.unreadable++;
  }
  const rank = (t: ReleaseLadderTask) => (t.highest ? RUNG_INDEX.get(t.highest)! : -1);
  const byUpdated = (a: { updatedAt?: string }, b: { updatedAt?: string }) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  for (const product of products.values()) {
    product.tasks.sort((a, b) => rank(b) - rank(a) || byUpdated(a, b) || a.id.localeCompare(b.id));
    product.noGates.sort((a, b) => byUpdated(a, b) || b.id.localeCompare(a.id));
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
    const entries: { run: RunSummary; gates: GateView | null }[] = new Array(runs.length);
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
        entries[i] = { run, gates: hasCompletionGates(statusData) ? await this.gateViews.load(path.join(this.runsDir, run.id)) : null };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, runs.length) }, worker));
    return buildReleaseLadder(entries);
  }
}
