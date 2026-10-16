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
