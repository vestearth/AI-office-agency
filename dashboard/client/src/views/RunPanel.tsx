import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficeLaunchTools, TaskLaunchCli, TaskLaunchResponse, WorktreeTarget } from '../../../shared/types';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { startNotes } from './taskWorkspace';

// Start or open task › Run: one role step in an agent CLI, unattended, with the prompt
// the server builds from the task's files (previewed in the dialog). The agent writes
// only its role output; the server holds the task's ownership lease for the whole step,
// then runs validate-yaml.rb, enforce-output-contract.rb and sync-status-from-output.rb
// itself and, when they pass, commits each worktree's diff locally on the task branch
// (never pushed). The step runs in the task's worktrees, each CLI in its own sandbox
// (server cliAdapter.ts): writes only in the worktrees and the task's runs dir, network
// off, no permission prompts.
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
  const { data, launch, error, busy, active, start, stop, lastResponse } = launchState;
  const repoKey = JSON.stringify(targets);
  useEffect(() => setConfirmed(false), [role, cli, note, repoKey]);

  const usability = (id: TaskLaunchCli) => tools?.clis.find((c) => c.id === id);
  const cliTool = usability(cli);
  const cliOk = cliTool?.available ?? false;
  const result = !isActive(launch) ? data?.result : undefined;
  const notes = startNotes(lastResponse as Parameters<typeof startNotes>[0]);

  const startButton = (
    <button type="button" className="form-button-primary" disabled={!confirmed || !cliOk || !prompt || busy || active || !targets || blockers.length > 0}
      onClick={async () => { if (await start({ role, cli, note, repos: targets })) setConfirmed(false); }}>
      {busy ? 'Starting…' : `Run with ${cli}`}
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
      <p className="handoff-help">
        {CLI_HELP[cli]}. Runs in the task&apos;s primary worktree{primary ? ` (${primary})` : ''} on this machine,
        writes only in the task&apos;s worktrees and its runs dir, and keeps going if this dialog closes or the dashboard
        restarts{tools?.timeLimitMinutes ? `; stopped and failed after ${tools.timeLimitMinutes} min` : ''}. The dashboard holds the task&apos;s
        lease for the whole step (run-agent.sh is refused meanwhile), then runs the office scripts itself and, only when they pass, commits each
        worktree&apos;s diff on its task branch: local only, never pushed. The agent never commits; a commit of its own fails the step.
      </p>
      {!active && (
        <label className="launch-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Run {role} on {taskId} with {cli}{targets?.length ? ` in ${targets.map((t) => t.repo).join(', ')}` : ''}
        </label>
      )}
      {actionsTarget && createPortal(startButton, actionsTarget)}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {notes.map((n) => <p key={n} className={`handoff-help${/could not fetch/.test(n) ? ' launch-warning' : ''}`} role="status">{n}</p>)}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {launch && result && <StepResult result={result} />}
    </section>
  );
}
