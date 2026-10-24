import { PHASE_TO_ZONE } from '../commandZones';
import { boardReason } from './officeAborted';
import { ARROW, clean, daysSince, ordered, roomLabel, type EscalationCardModel, type EscalationLine } from './officeEscalation';
import type { OfficeTask } from './officeSelection';

const PHASE = 'validation_failed';

interface Origin {
  from: string | null;
  reason: string | null;
  reasonLabel: 'reason' | 'latest note' | null;
}

/**
 * Where a task that failed validation came from and why, read from the structured `lastTransition`
 * only. Nothing is shown unless that transition is the one into `validation_failed`. A move inside
 * the room keeps its text but calls it the latest note and names no origin. When the agent is
 * `orchestrator` (the output contract failed) only the room is named: the role is never taken out
 * of the reason text.
 */
function originOf(item: OfficeTask): Origin {
  const transition = item.lastTransition;
  const match = transition ? ARROW.exec(transition.phase) : null;
  if (!transition || !match || match[2] !== item.phase) return { from: null, reason: null, reasonLabel: null };
  const reason = clean(transition.reason);
  if (PHASE_TO_ZONE.get(match[1]) === 'rejected') {
    return { from: null, reason, reasonLabel: reason ? 'latest note' : null };
  }
  const role = transition.agent === 'orchestrator' ? null : clean(transition.agent);
  return {
    from: [roomLabel(match[1]), role].filter(Boolean).join(' · ') || null,
    reason,
    reasonLabel: reason ? 'reason' : null,
  };
}

/** One line per task in the room, longest wait first. */
export function valFailedLines(tasks: readonly OfficeTask[], now: number): Omit<EscalationLine, 'kind'>[] {
  return ordered(tasks, PHASE).map((item) => {
    const origin = originOf(item);
    return {
      taskId: item.taskId,
      title: item.title,
      from: origin.from,
      reason: origin.reason === null ? null : boardReason(origin.reason),
      reasonLabel: origin.reasonLabel,
      days: daysSince(item, now),
    };
  });
}

/** What the selection card adds for a task in this room, or null for a task elsewhere. */
export function valFailedCard(item: OfficeTask, now: number): EscalationCardModel | null {
  if (item.phase !== PHASE) return null;
  const origin = originOf(item);
  return { heading: 'Failed validation', from: origin.from, reason: origin.reason, reasonLabel: origin.reasonLabel, days: daysSince(item, now) };
}
