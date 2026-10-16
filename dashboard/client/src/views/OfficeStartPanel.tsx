import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficeLaunchTools, TaskLaunchCli, TaskLaunchResponse } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { isActive, recentStatusWarning } from './officeLaunch';
import { LaunchContract, OfficeLaunchStatus, useOfficeLaunch } from './OfficeLaunchStatus';

// Monitor › run detail › Open task › Start here: one role step in an agent CLI,
// with the prompt the server builds from the task's files (shown before starting).
// The prompt carries the runtime adapter contract; after the run the server checks
// that the role output was written, status.yaml synced and validate-yaml.rb passes.
const CLI_HELP: Record<TaskLaunchCli, string> = {
  claude: 'claude -p · edits accepted; merges, force pushes and prod ECS/RDS starts refused',
  codex: 'codex exec · model pinned by the dashboard (DASHBOARD_CODEX_MODEL) · workspace-write sandbox: edits inside the workspace, no network (no push, no AWS)',
  'cursor-agent': 'cursor-agent -p · commands follow your Cursor CLI permissions',
};

export function OfficeStartPanel({ taskId, role, note, actionsTarget }: {
  taskId: string; role: string; note: string;
  /** The dialog footer: Start sits beside Close there. Without it, Start renders in place. */
  actionsTarget?: HTMLElement | null;
}) {
  const [tools, setTools] = useState<OfficeLaunchTools | null>(null);
  const [cli, setCli] = useState<TaskLaunchCli>('claude');
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const route = `/api/launch/task/${encodeURIComponent(taskId)}`;
  const { data, launch, error, busy, active, start, stop } = useOfficeLaunch<TaskLaunchResponse>(route);

  useEffect(() => { apiFetchJson<OfficeLaunchTools>('/api/launch/tools').then(setTools).catch(() => setTools(null)); }, []);
  useEffect(() => setConfirmed(false), [role, cli, note]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetchJson<{ prompt: string }>(`${route}/prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, note }),
      }).then((res) => { if (!cancelled) { setPrompt(res.prompt); setPromptError(''); } })
        .catch((e) => { if (!cancelled) setPromptError(e instanceof Error ? e.message : 'Could not build the prompt.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [route, role, note]);

  const cliOk = tools?.clis.find((c) => c.id === cli)?.available ?? false;
  const warning = recentStatusWarning(data?.statusChangedAt, launch);
  const contract = !isActive(launch) ? data?.contract : undefined;

  const startButton = (
    <button type="button" className="form-button-primary" disabled={!confirmed || !cliOk || !prompt || busy || active}
      onClick={async () => { if (await start({ role, cli, note })) setConfirmed(false); }}>
      {busy ? 'Starting…' : `Start with ${cli}`}
    </button>
  );

  return (
    <section className="cli-panel" aria-label="Start a step here">
      <label className="dialog-label" htmlFor="office-cli">CLI</label>
      <select id="office-cli" className="form-input" value={cli} disabled={active || busy} onChange={(e) => setCli(e.target.value as TaskLaunchCli)}>
        {(['claude', 'codex', 'cursor-agent'] as const).map((id) => (
          <option key={id} value={id} disabled={tools ? !tools.clis.find((c) => c.id === id)?.available : false}>{id}</option>
        ))}
      </select>
      <p className="handoff-help">{CLI_HELP[cli]}. Runs from the workspace root on this machine and keeps going if this dialog closes or the dashboard restarts.</p>
      {tools && !cliOk && <p className="dialog-error">{cli} is not on the dashboard server PATH.</p>}
      <label className="dialog-label" htmlFor="office-prompt">Prompt sent to {cli}</label>
      <textarea id="office-prompt" className="form-input handoff-prompt" readOnly rows={10} value={promptError ? '' : prompt} />
      {promptError && <p className="dialog-error">{promptError}</p>}
      {warning && <p className="dialog-error launch-warning" role="alert">{warning}</p>}
      {!active && (
        <label className="launch-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Start {role} on {taskId} with {cli}
        </label>
      )}
      {actionsTarget ? createPortal(startButton, actionsTarget) : <div className="cli-actions">{startButton}</div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {launch && contract && <LaunchContract contract={contract} />}
    </section>
  );
}
