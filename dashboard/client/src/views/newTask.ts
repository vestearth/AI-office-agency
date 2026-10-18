import type { NewTaskOptions, NewTaskRequest, NewTaskView } from '../../../shared/types';

// Command › New task (docs/start-task-redesign-spec.md, D11): the request form, and the
// stop after the pm step where the operator reads task.md and confirms before any chain.
// The server claims the id (open-task.rb), runs the pm step and decides every state;
// these only build the request and word what it reports.

export type GateChoice = 'presets' | 'none';

export interface NewTaskForm {
  title: string;
  request: string;
  prefix: string;
  gateChoice: GateChoice;
  presets: string[];
  noGatesReason: string;
}

export const emptyForm = (options: NewTaskOptions | null): NewTaskForm => ({
  title: '', request: '', prefix: options?.prefixes.default ?? '', gateChoice: 'presets', presets: [], noGatesReason: '',
});

/** "TASK-EAR-NNN" for a prefix ("TASK-NNN" for the legacy pool). */
export const idPattern = (prefix: string) => (prefix ? `TASK-${prefix}-NNN` : 'TASK-NNN');

/** The option text for a prefix. */
export const prefixLabel = (prefix: string, owner?: string) => `${prefix || '(no prefix)'} · ${idPattern(prefix)}${owner ? ` · ${owner}` : ''}`;

/** Why the form cannot be sent yet (empty: it can). The server checks all of it again. */
export function formBlockers(form: NewTaskForm, options: NewTaskOptions | null): string[] {
  if (!options) return ['Loading the prefixes and gate presets…'];
  const out: string[] = [];
  if (!form.title.trim()) out.push('Give the task a title.');
  if (/[\r\n]/.test(form.title)) out.push('The title is one line.');
  if (!form.request.trim()) out.push('Describe the request: the pm step writes task.md from it.');
  if (!options.prefixes.allowed.includes(form.prefix)) out.push('Pick a prefix.');
  if (form.gateChoice === 'presets' && form.presets.length === 0) out.push('Pick at least one gate preset, or choose no delivery gates with the reason.');
  if (form.gateChoice === 'none' && !form.noGatesReason.trim()) out.push('Say why the task needs no delivery gates.');
  if (!options.writer.usable) out.push(`${options.writer.cli} cannot run the pm step: ${options.writer.reason ?? 'not usable'}.`);
  return out;
}

/** The POST body: presets or the no-gates reason, never both. */
export function requestBody(form: NewTaskForm): NewTaskRequest {
  return {
    title: form.title.trim(), request: form.request.trim(), prefix: form.prefix,
    ...(form.gateChoice === 'presets' ? { presets: form.presets } : { noGatesReason: form.noGatesReason.trim() }),
  };
}

/** Toggles a preset on or off, keeping the order the presets file lists them in. */
export function togglePreset(selected: string[], name: string, order: string[]): string[] {
  const next = selected.includes(name) ? selected.filter((p) => p !== name) : [...selected, name];
  return order.filter((p) => next.includes(p));
}

/** What the form promises before the operator sends it. */
export function submitLine(form: NewTaskForm, writer: string): string {
  const gates = form.gateChoice === 'presets' ? `gates ${form.presets.join(' + ') || '…'}` : 'no delivery gates';
  return `Opens the next ${idPattern(form.prefix)} id with scripts/open-task.rb (${gates}), then runs a pm step on ${writer} that writes task.md. It stops there for you to read and confirm.`;
}

/** One line for a task opened here: "TASK-EAR-5 · pm running on claude" / "… · task.md ready for your review". */
export function newTaskLine(t: NewTaskView): string {
  const head = `${t.taskId} · ${t.title}`;
  switch (t.state) {
    case 'pm': return `${head} · pm ${t.pm.status === 'queued' ? (t.pm.text ?? 'queued') : t.pm.status} on ${t.cli}`;
    case 'pm-failed': return `${head} · pm step ${t.pm.status === 'not started' ? 'did not run' : 'failed'}: ${t.pm.text ?? 'no reason recorded'}`;
    case 'review': return `${head} · task.md ready for your review`;
    case 'confirmed': return `${head} · confirmed`;
    default: return `${head} · closed`;
  }
}

/** The review's headline for each state. */
export function reviewHeadline(t: NewTaskView): string {
  switch (t.state) {
    case 'pm': return `The pm step is ${t.pm.status === 'queued' ? (t.pm.text ?? 'queued') : t.pm.status} on ${t.cli}: task.md is not ready yet.`;
    case 'pm-failed': return `The pm step ${t.pm.status === 'not started' ? 'did not run' : 'failed'}: ${t.pm.text ?? 'no reason recorded'}. ${t.taskId} stays opened: Redo pm, or abort the task with the office tools.`;
    case 'review': return `The pm step is verified (${t.pm.text}). Read task.md, then confirm to start a chain, Redo pm with a note, or close it here.`;
    case 'confirmed': return 'Confirmed: start the chain from the Start dialog (it opens on Confirm).';
    default: return 'Closed here: the task itself stays as it is.';
  }
}

/** Keep re-reading the task while its pm step has not ended. */
export const pmPolling = (t: NewTaskView | null) => t?.state === 'pm';

/** The gate decision in words. */
export const gatesText = (t: Pick<NewTaskView, 'gates'>) => ('presets' in t.gates ? `Gate presets: ${t.gates.presets.join(', ')}` : `No delivery gates: ${t.gates.none}`);

/** The repositories a chain would start in, from the new task.md. */
export function reposLine(t: NewTaskView): string {
  const proposed = t.proposed ?? [];
  const ref = t.referenceOnly?.length ? `; reference only: ${t.referenceOnly.join(', ')}` : '';
  return proposed.length
    ? `Repositories proposed from task.md: ${proposed.join(', ')}${ref}. You confirm them in the Start dialog.`
    : `task.md names no repository a Run would preselect${ref}: pick them in the Start dialog, or Redo pm asking for Repo: lines.`;
}
