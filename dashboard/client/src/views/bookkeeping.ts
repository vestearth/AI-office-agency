import type { ReleaseLadderTask, ReviewSummary } from '../../../shared/types';
import { WAIT_KINDS } from '../../../shared/waitKinds';
import { runPrefix as taskPrefixOf } from './monitorList';

// Command › Attention › Bookkeeping: records a person has to keep so the dashboard
// can group and credit work. Not decisions, so they stay out of "need attention".
// - A blocked task with no waits_on is in Attention but never grouped under
//   "What unblocks work" (scripts/update-waits-on.rb records it).
// - A staging-accepted task with no production gate that no train carries can
//   never be credited in prod (Readiness noProdGates); a done task cannot take new
//   gates (revise-task-plan refuses finished tasks), so it goes on a train
//   (scripts/update-train-carries.rb), or a train is opened for it.

export type GapKind = 'no_waits_on' | 'not_on_train';

export interface BookkeepingGap {
  kind: GapKind;
  taskId: string;
  title: string;
  detail: string;
  command: string;
  /** Open trains of the same product the task could go on (not_on_train). */
  trains: { id: string; title: string }[];
}

const TERMINAL = new Set(['completed', 'cancelled']);

export function openTrains(index: Map<string, ReleaseLadderTask>, prefix: string): { id: string; title: string }[] {
  return [...index.values()]
    .filter((t) => t.carries.length > 0 && !TERMINAL.has(t.status) && taskPrefixOf(t.id) === prefix)
    .map((t) => ({ id: t.id, title: t.title }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function bookkeepingGaps(reviews: ReviewSummary[], index: Map<string, ReleaseLadderTask> | null): BookkeepingGap[] {
  const gaps: BookkeepingGap[] = [];
  for (const r of reviews) {
    if (r.phase !== 'blocked' || r.waitsOn.length > 0) continue;
    gaps.push({
      kind: 'no_waits_on', taskId: r.taskId, title: r.title, trains: [],
      detail: `Blocked with no waits_on, so "What unblocks work" cannot group it. Kinds: ${WAIT_KINDS.join(', ')}.`,
      command: `ruby scripts/update-waits-on.rb ${r.taskId} add <kind> [--ref TASK-…] --actor <you> --reason "<why>"`,
    });
  }
  for (const t of index?.values() ?? []) {
    if (!t.noProdGates || t.carries.length > 0 || t.status === 'cancelled') continue;
    const trains = openTrains(index!, taskPrefixOf(t.id));
    gaps.push(trains.length > 0 ? {
      kind: 'not_on_train', taskId: t.id, title: t.title, trains,
      detail: 'Staging accepted with no production gate, and no train carries it, so production can never credit it. Put it on the train that ships its repo.',
      command: `ruby scripts/update-train-carries.rb ${trains.length === 1 ? trains[0]!.id : '<TRAIN>'} add ${t.id} --actor <you> --reason "<why>"`,
    } : {
      kind: 'not_on_train', taskId: t.id, title: t.title, trains,
      detail: 'Staging accepted with no production gate, and no train is open for this product. Open a train with the production gates and carry it.',
      command: `./run-agent.sh open <TRAIN_ID> --title "<release train>" --agent devops --preset train`,
    });
  }
  return gaps;
}
