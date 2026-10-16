import type { GateView, ReleaseLadderTask } from '../../../shared/types';
import { RELEASE_LADDER, RUNG_ALIASES, RUNG_LABEL, type ReleaseRung } from '../../../shared/releaseLadder';

/**
 * "Prod deployed · next: Prod accepted": how far the gates prove a task. Attention shows it
 * beside the last hand-off note, which goes stale when lanes advance gates without a phase
 * change (VS-028 read "Not merged" after it was deployed to prod, 2026-10-16).
 */
export function rungProgress(t: ReleaseLadderTask): string {
  const reached = t.highest ? RUNG_LABEL[t.highest] : 'no rung passed';
  const next = RELEASE_LADDER.find((rung) => t.rungs[rung]?.status === 'pending');
  return next ? `${reached} · next: ${RUNG_LABEL[next]}` : reached;
}

/**
 * The same line from a task's own gates (the Monitor header): its last hand-off note goes
 * stale when gates advance without a phase change (VS-028, 2026-10-17). Train credit is not
 * read here; Readiness shows it. Null without a readable ladder gate.
 */
export function gateRungProgress(view: GateView): string | null {
  if (!view.readable) return null;
  const byName = new Map(view.gates.map((g) => [g.name, g.status]));
  const status = (rung: ReleaseRung) => byName.get(rung) ?? (RUNG_ALIASES[rung] ?? []).map((a) => byName.get(a)).find(Boolean) ?? 'absent';
  const rungs = Object.fromEntries(RELEASE_LADDER.map((r) => [r, { status: status(r) }])) as unknown as ReleaseLadderTask['rungs'];
  if (RELEASE_LADDER.every((r) => rungs[r].status === 'absent')) return null;
  const highest = [...RELEASE_LADDER].reverse().find((r) => rungs[r].status === 'pass') ?? null;
  return rungProgress({ highest, rungs } as ReleaseLadderTask);
}

const RESOLVED = new Set(['pass', 'na', 'absent']);

/**
 * Finished for its own ladder: production acceptance passed, or the task is done and every
 * gate it declared (ladder and extra) passed or is not applicable. A test-only fix that
 * declares only implementation_verification is complete at "Verified" (VS-032..034).
 */
export function isComplete(t: Pick<ReleaseLadderTask, 'status' | 'rungs' | 'extra'>): boolean {
  if (t.rungs.production_acceptance?.status === 'pass') return true;
  if (t.status !== 'completed') return false;
  return RELEASE_LADDER.every((rung) => RESOLVED.has(t.rungs[rung]?.status ?? 'absent'))
    && t.extra.every((g) => g.status === 'pass' || g.status === 'na');
}
