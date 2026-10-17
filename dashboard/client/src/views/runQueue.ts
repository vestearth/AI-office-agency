import type { RunQueueItem, RunSummary, RunTrigger } from '../../../shared/types';
import { triggerLabel } from '../../../shared/runQueue';

// Run › When (docs/start-task-redesign-spec.md, D13): every Run goes through the
// dashboard's queue; the dialog picks the trigger, the server validates it again.

/** after-chain: after another task's role chain ends (D12), however it stopped. */
export type TriggerKind = RunTrigger['kind'] | 'after-chain';

export const TRIGGER_LABELS: Record<TriggerKind, string> = {
  now: 'Now (or when a slot is free)',
  at: 'At a time',
  after: "After another task's step ends",
  'after-chain': "After another task's chain ends",
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local value (local time, minutes) for `date`. */
export const toLocalInput = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The time field's default: the next half hour, at least 10 minutes ahead. */
export function defaultAtInput(now = new Date()): string {
  const d = new Date(now.getTime() + 10 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() <= 30 ? 30 : 60);
  return toLocalInput(d);
}

/** The trigger to send, or why the form cannot queue yet. */
export function triggerFromForm(kind: TriggerKind, atInput: string, afterTask: string, now = new Date()): RunTrigger | { error: string } {
  if (kind === 'now') return { kind: 'now' };
  if (kind === 'at') {
    const at = atInput ? new Date(atInput) : null;
    if (!at || Number.isNaN(at.getTime())) return { error: 'Pick the time to start.' };
    if (at.getTime() < now.getTime() - 60_000) return { error: 'That time has passed: pick a later one, or start now.' };
    return { kind: 'at', at: at.toISOString() };
  }
  if (kind === 'after-chain') return afterTask ? { kind: 'after', taskId: afterTask, scope: 'chain' } : { error: 'Pick the task whose chain it waits for.' };
  if (!afterTask) return { error: 'Pick the task whose step it waits for.' };
  return { kind: 'after', taskId: afterTask, scope: 'step' };
}

const ENDED = new Set(['completed', 'cancelled']);

/** Tasks a Run can wait on: open ones, the running and queued first, then by id; never `self` unless asked. */
export function afterTaskOptions(runs: Pick<RunSummary, 'id' | 'status' | 'title'>[], self: string, runningKeys: Set<string> = new Set()): { id: string; label: string }[] {
  const rank = (r: Pick<RunSummary, 'id'>) => (runningKeys.has(r.id) ? 0 : 1);
  return runs.filter((r) => !ENDED.has(r.status) && r.id !== self)
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, label: `${r.id}${runningKeys.has(r.id) ? ' (running now)' : ''}${r.title && r.title !== r.id ? ` · ${r.title.slice(0, 60)}` : ''}` }));
}

/** The start button's text for the trigger. */
export const runButtonLabel = (kind: TriggerKind, cli: string, busy: boolean) => (busy ? 'Starting…' : kind === 'now' ? `Run with ${cli}` : `Queue with ${cli}`);

/** What the confirm line promises. */
export function confirmLine(input: { role: string; taskId: string; cli: string; repos: string[]; trigger: RunTrigger | { error: string } }): string {
  const when = 'error' in input.trigger ? '' : input.trigger.kind === 'now' ? '' : ` ${triggerLabel(input.trigger)}`;
  return `Run ${input.role} on ${input.taskId} with ${input.cli}${input.repos.length ? ` in ${input.repos.join(', ')}` : ''}${when}`;
}

/** The status line for an item still in the queue. */
export function queuedStatus(item: RunQueueItem): string {
  if (item.state === 'starting') return `${item.label}: starting now`;
  return `${item.label}: queued ${triggerLabel(item.trigger)}, waiting for ${item.waitingFor ?? 'its trigger'}`;
}

/** The line for an item that could not start (shown until a later launch). */
export const queueFailedLine = (item: RunQueueItem) => `Queued ${item.label} could not start: ${item.reason ?? 'unknown reason'}`;
