import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficeLaunchTools, TaskLaunchCli, TaskLaunchResponse, TaskWorkspaceResponse, WorktreePlan, WorktreeTarget } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { isActive, recentStatusWarning } from './officeLaunch';
import { LaunchContract, OfficeLaunchStatus, useOfficeLaunch } from './OfficeLaunchStatus';
import { TaskReposField } from './TaskReposField';
import { runBlockers, targetsFromPlans } from './taskWorkspace';

// Monitor › run detail › Open task › Start here: one role step in an agent CLI,
// with the prompt the server builds from the task's files (shown before starting).
// The prompt carries the runtime adapter contract; after the run the server checks
// that the role output was written, status.yaml synced and validate-yaml.rb passes.
// The step runs in the task's worktrees (one per confirmed repository, the first its
// working directory), each CLI in its own sandbox (server cliAdapter.ts): writes only
// in the worktrees and the task's runs dir, network off, no permission prompts.
const CLI_HELP: Record<TaskLaunchCli, string> = {
  claude: 'claude -p · sandboxed commands, network off, no prompts; only your user settings load (no project hooks); push and web tools refused',
  codex: 'codex exec · model pinned by the dashboard (DASHBOARD_CODEX_MODEL) · workspace-write sandbox, network off, no /tmp, never asks for approval',
  'cursor-agent': 'cursor-agent -p · Cursor sandbox (.cursor/sandbox.json written by the dashboard in the worktree), network denied; --trust only on a worktree the dashboard created',
};

const post = <T,>(url: string, body: unknown) => apiFetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
  const [workspace, setWorkspace] = useState<TaskWorkspaceResponse | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [targets, setTargets] = useState<WorktreeTarget[] | null>(null);
  const [plans, setPlans] = useState<WorktreePlan[]>([]);
  const route = `/api/launch/task/${encodeURIComponent(taskId)}`;
  const { data, launch, error, busy, active, start, stop } = useOfficeLaunch<TaskLaunchResponse>(route);
  const repoKey = JSON.stringify(targets);

  useEffect(() => { apiFetchJson<OfficeLaunchTools>('/api/launch/tools').then(setTools).catch(() => setTools(null)); }, []);
  // The proposal from task.md, once; after that the operator's list is planned on each change.
  useEffect(() => {
    apiFetchJson<TaskWorkspaceResponse>(`${route}/workspace`)
      .then((res) => { setWorkspace(res); setPlans(res.plans); setTargets(targetsFromPlans(res.plans)); })
      .catch((e) => setWorkspaceError(e instanceof Error ? e.message : 'Could not read the repositories.'));
  }, [route]);
  useEffect(() => {
    if (!targets || !workspace) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      post<TaskWorkspaceResponse>(`${route}/workspace`, { repos: targets })
        .then((res) => { if (!cancelled) { setPlans(res.plans); setWorkspaceError(''); } })
        .catch((e) => { if (!cancelled) setWorkspaceError(e instanceof Error ? e.message : 'Could not plan the worktrees.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, repoKey, launch?.status]);
  useEffect(() => setConfirmed(false), [role, cli, note, repoKey]);
  useEffect(() => {
    if (!targets) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      post<{ prompt: string }>(`${route}/prompt`, { role, note, repos: targets })
        .then((res) => { if (!cancelled) { setPrompt(res.prompt); setPromptError(''); } })
        .catch((e) => { if (!cancelled) setPromptError(e instanceof Error ? e.message : 'Could not build the prompt.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, role, note, repoKey]);

  const cliTool = tools?.clis.find((c) => c.id === cli);
  const cliOk = cliTool?.available ?? false;
  const warning = recentStatusWarning(data?.statusChangedAt, launch);
  const contract = !isActive(launch) ? data?.contract : undefined;
  const blockers = targets ? runBlockers(targets, plans) : [];
  const primary = plans[0]?.path;

  const startButton = (
    <button type="button" className="form-button-primary" disabled={!confirmed || !cliOk || !prompt || busy || active || !targets || blockers.length > 0}
      onClick={async () => { if (await start({ role, cli, note, repos: targets })) setConfirmed(false); }}>
      {busy ? 'Starting…' : `Start with ${cli}`}
    </button>
  );

  return (
    <section className="cli-panel" aria-label="Start a step here">
      <label className="dialog-label" htmlFor="office-cli">CLI</label>
      <select id="office-cli" className="form-input" value={cli} disabled={active || busy} onChange={(e) => setCli(e.target.value as TaskLaunchCli)}>
        {(['claude', 'codex', 'cursor-agent'] as const).map((id) => (
          <option key={id} value={id} disabled={tools ? !tools.clis.find((c) => c.id === id)?.available : false}>
            {id}{tools && !tools.clis.find((c) => c.id === id)?.available ? ' (cannot run)' : ''}
          </option>
        ))}
      </select>
      <p className="handoff-help">
        {CLI_HELP[cli]}{cliTool?.model ? ` · model ${cliTool.model}` : ''}. Runs in the task&apos;s primary worktree{primary ? ` (${primary})` : ''} on this machine,
        writes only in the task&apos;s worktrees and its runs dir, never commits or pushes, and keeps going if this dialog closes or the dashboard
        restarts{tools?.timeLimitMinutes ? `; stopped and failed after ${tools.timeLimitMinutes} min` : ''}.
      </p>
      {tools && !cliOk && <p className="dialog-error">{cli} cannot run a step: {cliTool?.reason ?? 'not reported by the server'}.</p>}
      {cliOk && cliTool?.note && <p className="handoff-help">{cliTool.note}.</p>}
      {workspace && targets && (
        <TaskReposField taskId={taskId} workspace={workspace} targets={targets} plans={plans} disabled={active || busy} onChange={setTargets} />
      )}
      {workspaceError && <p className="dialog-error">{workspaceError}</p>}
      <label className="dialog-label" htmlFor="office-prompt">Prompt sent to {cli}</label>
      <textarea id="office-prompt" className="form-input handoff-prompt" readOnly rows={10} value={promptError ? '' : prompt} />
      {promptError && <p className="dialog-error">{promptError}</p>}
      {warning && <p className="dialog-error launch-warning" role="alert">{warning}</p>}
      {!active && blockers.length > 0 && <ul className="dialog-error repo-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {!active && (
        <label className="launch-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Start {role} on {taskId} with {cli}{targets?.length ? ` in ${targets.map((t) => t.repo).join(', ')}` : ''}
        </label>
      )}
      {actionsTarget ? createPortal(startButton, actionsTarget) : <div className="cli-actions">{startButton}</div>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {launch && contract && <LaunchContract contract={contract} />}
    </section>
  );
}
