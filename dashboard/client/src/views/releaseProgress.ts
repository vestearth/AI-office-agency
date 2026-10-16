import type { ReleaseLadderTask } from '../../../shared/types';
import { RELEASE_LADDER, RUNG_LABEL } from '../../../shared/releaseLadder';

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
