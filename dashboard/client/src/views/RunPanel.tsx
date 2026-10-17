import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficeLaunch, OfficeLaunchTools, RunSummary, TaskLaunchCli, TaskLaunchResponse, WorktreeTarget } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { QueuedRun, QueueFailed } from './RunQueuePanel';
import { afterTaskOptions, confirmLine, defaultAtInput, runButtonLabel, TRIGGER_LABELS, triggerFromForm, type TriggerKind } from './runQueue';
import { startNotes } from './taskWorkspace';

// Start or open task › Run: one role step in an agent CLI, unattended, with the prompt
// the server builds from the task's files (previewed in the dialog). The agent writes
// only its role output; the server holds the task's ownership lease for the whole step,
// then runs validate-yaml.rb, enforce-output-contract.rb and sync-status-from-output.rb
// itself and, when they pass, commits each worktree's diff locally on the task branch
// (never pushed). The step runs in the task's worktrees, each CLI in its own sandbox
// (server cliAdapter.ts): writes only in the worktrees and the task's runs dir, network
// off, no permission prompts. Every Run goes through the dashboard's queue (D13): now
// (starts at once when a slot is free under the cap), at a time, or after another task's
// step ends; a queued Run can be cancelled until it starts.
const CLIS: TaskLaunchCli[] = ['claude', 'codex', 'cursor-agent'];

const CLI_HELP: Record<TaskLaunchCli, string> = {
  claude: 'claude -p · sandboxed commands, network off, no prompts; only your user settings load (no project hooks); push and web tools refused',
  codex: 'codex exec · model pinned by the dashboard (DASHBOARD_CODEX_MODEL) · workspace-write sandbox, network off, no /tmp, never asks for approval',
  'cursor-agent': 'cursor-agent -p · Cursor sandbox (.cursor/sandbox.json written by the dashboard in the worktree), network denied; --trust only on a worktree the dashboard created',
};

export function RunPanel({ taskId, role, note, tools, targets, primary, blockers, prompt, launchState, actionsTarget }: {
  taskId: string; role: string; note: string;
  tools: OfficeLaunchTools | null;
  /** The confirmed repositories, null while loading. */
  targets: WorktreeTarget[] | null;
  /** The primary worktree's planned path. */
  primary?: string;
  /** Why the repositories cannot run yet. */
  blockers: string[];
  prompt: string;
  launchState: ReturnType<typeof useOfficeLaunch<TaskLaunchResponse>>;
  /** The dialog footer: Start sits there. */
  actionsTarget: HTMLElement | null;
}) {
  const [cli, setCli] = useState<TaskLaunchCli>('claude');
  const [confirmed, setConfirmed] = useState(false);
  const [when, setWhen] = useState<TriggerKind>('now');
  const [atInput, setAtInput] = useState(() => defaultAtInput());
  const [afterTask, setAfterTask] = useState('');
  const [tasks, setTasks] = useState<{ id: string; label: string }[] | null>(null);
  const { data, launch, error, busy, active, submit, stop, lastResponse, refresh } = launchState;
  const repoKey = JSON.stringify(targets);
  useEffect(() => setConfirmed(false), [role, cli, note, repoKey, when, atInput, afterTask]);
  // The tasks a Run can wait on, read once "after" is picked.
  useEffect(() => {
    if (when !== 'after' || tasks) return;
    Promise.all([
      apiFetchJson<RunSummary[]>('/api/runs'),
      apiFetchJson<{ launches: OfficeLaunch[] }>('/api/launch/active').catch(() => ({ launches: [] as OfficeLaunch[] })),
    ]).then(([runs, active]) => setTasks(afterTaskOptions(runs, taskId, new Set(active.launches.map((l) => l.key)))))
      .catch(() => setTasks([]));
  }, [when, tasks, taskId]);
  const trigger = triggerFromForm(when, atInput, afterTask);
  const queued = data?.queued;

  const usability = (id: TaskLaunchCli) => tools?.clis.find((c) => c.id === id);
  const cliTool = usability(cli);
  const cliOk = cliTool?.available ?? false;
  const result = !isActive(launch) ? data?.result : undefined;
  const notes = startNotes(lastResponse as Parameters<typeof startNotes>[0]);

  const startButton = (
    <button type="button" className="form-button-primary"
      disabled={!confirmed || !cliOk || !prompt || busy || (active && when === 'now') || Boolean(queued) || !targets || blockers.length > 0 || 'error' in trigger}
      onClick={async () => { if (await submit({ role, cli, note, repos: targets, trigger })) setConfirmed(false); }}>
      {runButtonLabel(when, cli, busy)}
    </button>
  );

  return (
    <section className="cli-panel" aria-label="Run the step">
      <label className="dialog-label" htmlFor="office-cli">CLI</label>
      <select id="office-cli" className="form-input" value={cli} disabled={active || busy} onChange={(e) => setCli(e.target.value as TaskLaunchCli)}>
        {CLIS.map((id) => (
          <option key={id} value={id} disabled={tools ? !usability(id)?.available : false}>
            {id}{tools && !usability(id)?.available ? ' (cannot run)' : ''}
          </option>
        ))}
      </select>
      {tools && (
        <ul className="cli-usability" aria-label="CLI usability">
          {CLIS.map((id) => {
            const t = usability(id);
            return (
              <li key={id} className={t?.available ? 'ok' : 'fail'}>
                {t?.available ? '✓' : '✗'} <strong>{id}</strong>{' '}
                {t?.available ? `usable${t.model ? ` · model ${t.model}` : ''}${t.note ? ` · ${t.note}` : ''}` : `cannot run: ${t?.reason ?? 'not reported by the server'}`}
              </li>
            );
          })}
        </ul>
      )}
      <label className="dialog-label" htmlFor="run-when">When</label>
      <select id="run-when" className="form-input" value={when} disabled={busy || Boolean(queued)} onChange={(e) => setWhen(e.target.value as TriggerKind)}>
        {(Object.keys(TRIGGER_LABELS) as TriggerKind[]).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
      </select>
      {when === 'at' && (
        <input id="run-at" aria-label="Start at" type="datetime-local" className="form-input" value={atInput} disabled={busy} onChange={(e) => setAtInput(e.target.value)} />
      )}
      {when === 'after' && (
        <select id="run-after" aria-label="After the step of" className="form-input" value={afterTask} disabled={busy || !tasks} onChange={(e) => setAfterTask(e.target.value)}>
          <option value="">{tasks ? 'Pick a task…' : 'Loading tasks…'}</option>
          {tasks && <option value={taskId}>{taskId} (this task: after its current or next step)</option>}
          {tasks?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
      <p className="handoff-help">
        {when === 'now' && `Starts at once when a slot is free${tools?.queueCap ? ` (at most ${tools.queueCap} at once on this machine)` : ''}; otherwise it waits in the queue (Command › Operations › Run queue).`}
        {when === 'at' && 'Starts at that time, or later if the queue is full then. The queue only advances while the dashboard runs: a time it missed by more than an hour fails instead of starting late.'}
        {when === 'after' && "Starts when that task's step ends, however it ends (succeeded, failed, stopped, time limit), once the dashboard has verified it; if that task has nothing running or queued, it waits for its next step."}
        {when !== 'now' && ' The prompt and worktrees are prepared when it starts, from the task files as they are then.'}
      </p>
      {'error' in trigger && when !== 'now' && <p className="dialog-error">{trigger.error}</p>}
      <p className="handoff-help">
        {CLI_HELP[cli]}. Runs in the task&apos;s primary worktree{primary ? ` (${primary})` : ''} on this machine,
        writes only in the task&apos;s worktrees and its runs dir, and keeps going if this dialog closes or the dashboard
        restarts{tools?.timeLimitMinutes ? `; stopped and failed after ${tools.timeLimitMinutes} min` : ''}. The dashboard holds the task&apos;s
        lease for the whole step (run-agent.sh is refused meanwhile), then runs the office scripts itself and, only when they pass, commits each
        worktree&apos;s diff on its task branch: local only, never pushed. The agent never commits; a commit of its own fails the step.
      </p>
      {(!active || when !== 'now') && !queued && (
        <label className="launch-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {confirmLine({ role, taskId, cli, repos: targets?.map((t) => t.repo) ?? [], trigger })}
        </label>
      )}
      {actionsTarget && createPortal(startButton, actionsTarget)}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {notes.map((n) => <p key={n} className={`handoff-help${/could not fetch/.test(n) ? ' launch-warning' : ''}`} role="status">{n}</p>)}
      {queued && <QueuedRun item={queued} onChanged={refresh} />}
      {data?.queueFailed && !error && <QueueFailed item={data.queueFailed} />}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {launch && result && <StepResult result={result} />}
    </section>
  );
}
