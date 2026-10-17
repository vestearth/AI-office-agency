import { useEffect, useRef, useState } from 'react';
import type { OfficeLaunchTools, RunDetail, TaskLaunchResponse, TaskWorkspaceResponse, WorktreePlan, WorktreeTarget } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { ROLE_NAMES } from './agentDisplay';
import { chainPolling } from './chain';
import { useOfficeLaunch } from './OfficeLaunchStatus';
import { OpenPanel } from './OpenPanel';
import { RunPanel } from './RunPanel';
import { defaultRole, taskWarnings, type StartAction } from './startTask';
import { TaskReposField } from './TaskReposField';
import { runBlockers, targetsFromPlans } from './taskWorkspace';

const post = <T,>(url: string, body: unknown) => apiFetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * The repositories and the server-built prompt both actions share: task.md's proposal
 * once, then a plan per repository and the prompt (Run or Open wording) on every change.
 */
function useTaskSetup(route: string, role: string, note: string, mode: StartAction, refreshKey: string) {
  const [workspace, setWorkspace] = useState<TaskWorkspaceResponse | null>(null);
  const [workspaceError, setWorkspaceError] = useState('');
  const [targets, setTargets] = useState<WorktreeTarget[] | null>(null);
  const [plans, setPlans] = useState<WorktreePlan[]>([]);
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState('');
  const repoKey = JSON.stringify(targets);

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
  }, [route, repoKey, refreshKey]);
  useEffect(() => {
    if (!targets) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      post<{ prompt: string }>(`${route}/prompt`, { role, note, repos: targets, mode })
        .then((res) => { if (!cancelled) { setPrompt(res.prompt); setPromptError(''); } })
        .catch((e) => { if (!cancelled) setPromptError(e instanceof Error ? e.message : 'Could not build the prompt.'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, role, note, repoKey, mode]);

  return { workspace, workspaceError, targets, setTargets, plans, prompt: promptError ? '' : prompt, promptError };
}

// Monitor › run detail › Start or open task (docs/start-task-redesign-spec.md, D1): Run
// the next role step unattended in a sandboxed CLI, or Open it in an app you drive.
// Both use the task's worktrees and the prompt the server builds from the task's files.
export function StartTaskDialog({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const [action, setAction] = useState<StartAction>('run');
  const [role, setRole] = useState(() => defaultRole(run.nextActionPreview?.targetRole, run.currentAgent));
  const [note, setNote] = useState('');
  const [tools, setTools] = useState<OfficeLaunchTools | null>(null);
  const [opened, setOpened] = useState(0);
  // Each action renders its buttons into the footer, beside Close.
  const [footerSlot, setFooterSlot] = useState<HTMLSpanElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef(document.activeElement as HTMLElement | null);
  const route = `/api/launch/task/${encodeURIComponent(run.id)}`;
  const launchState = useOfficeLaunch<TaskLaunchResponse>(route, { keepPolling: (d) => d.result?.state === 'verifying' || Boolean(d.queued) || chainPolling(d.chain), idlePollMs: 15_000 });
  const { launch, active, busy } = launchState;
  const setup = useTaskSetup(route, role, note, action, `${launch?.status ?? ''}-${opened}`);
  const blockers = setup.targets ? runBlockers(setup.targets, setup.plans) : [];
  const warnings = taskWarnings(launchState.data);
  const locked = active || busy;

  useEffect(() => { apiFetchJson<OfficeLaunchTools>('/api/launch/tools').then(setTools).catch(() => setTools(null)); }, []);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button, select')?.focus();
    const trigger = triggerRef.current;
    return () => trigger?.focus();
  }, []);

  const shared = { taskId: run.id, role, note, tools, targets: setup.targets, primary: setup.plans[0]?.path, blockers, prompt: setup.prompt, actionsTarget: footerSlot };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog desktop-handoff" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="start-task-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          if (e.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]');
            const first = controls?.[0], last = controls?.[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="dialog-header">
          <span className="dialog-title" id="start-task-title">Start or open task</span>
          <span className="dialog-task">{run.id}</span>
        </div>
        <div className="dialog-body">
          <div className="start-actions" role="group" aria-label="Action">
            {([['run', 'Run'], ['open', 'Open']] as const).map(([id, label]) => (
              <button key={id} type="button" className={`section-tab sidebar-chip ${action === id ? 'active' : ''}`} aria-pressed={action === id}
                disabled={locked && id !== action} onClick={() => setAction(id)}>{label}</button>
            ))}
            <span className="handoff-help">{action === 'run' ? 'Unattended, in a sandboxed CLI; verified and committed by the dashboard.' : 'In an app you drive; no lease, not verified by the dashboard.'}</span>
          </div>
          <div className="handoff-fields">
            <div>
              <label className="dialog-label" htmlFor="start-role">Role</label>
              <select id="start-role" className="form-input" value={role} disabled={locked} onChange={(e) => setRole(e.target.value)}>
                {ROLE_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          </div>
          {run.nextActionPreview?.reason && <p className="handoff-help">Recorded recommendation{run.nextActionPreview.targetRole ? ` (${run.nextActionPreview.targetRole})` : ''}: {run.nextActionPreview.reason}</p>}
          <label className="dialog-label" htmlFor="start-note">Additional instructions <span className="dialog-optional">(optional)</span></label>
          <textarea id="start-note" className="form-input" rows={2} value={note} disabled={locked} onChange={(e) => setNote(e.target.value)} />
          {setup.workspace && setup.targets && (
            <TaskReposField taskId={run.id} workspace={setup.workspace} targets={setup.targets} plans={setup.plans} disabled={locked} onChange={setup.setTargets} />
          )}
          {setup.workspaceError && <p className="dialog-error">{setup.workspaceError}</p>}
          <label className="dialog-label" htmlFor="start-prompt">{action === 'run' ? 'Prompt sent to the CLI' : 'Prompt filled in the app'}</label>
          <textarea id="start-prompt" className="form-input handoff-prompt" readOnly rows={10} value={setup.prompt} />
          {setup.promptError && <p className="dialog-error">{setup.promptError}</p>}
          {warnings.map((w) => <p key={w} className="dialog-error launch-warning" role="alert">{w}</p>)}
          {!active && blockers.length > 0 && <ul className="dialog-error repo-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          {action === 'run'
            ? <RunPanel {...shared} launchState={launchState} />
            : <OpenPanel {...shared} onTargets={setup.setTargets} onOpened={() => setOpened((n) => n + 1)} />}
        </div>
        <div className="dialog-footer">
          <button className="form-button" type="button" onClick={onClose}>Close</button>
          <span ref={setFooterSlot} className="dialog-footer-slot" />
        </div>
      </div>
    </div>
  );
}
