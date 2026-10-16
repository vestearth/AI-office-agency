import { useState } from 'react';
import type { TaskWorkspaceResponse, WorktreePlan, WorktreeTarget } from '../../../shared/types';
import { alsoMentioned, makePrimary, planLabel } from './taskWorkspace';

// Run and Open › target repositories (D3): proposed from task.md, confirmed or edited by the
// operator before a Run. Each repository gets a worktree at .worktrees/<repo>-<TASK>;
// the first one is the primary, the step's working directory. The server's plan says
// what a Run will do there (create, add, reuse, adopt only on opt-in, or refuse).
export function TaskReposField({ taskId, workspace, targets, plans, disabled, onChange }: {
  taskId: string;
  workspace: TaskWorkspaceResponse;
  targets: WorktreeTarget[];
  plans: WorktreePlan[];
  disabled: boolean;
  onChange: (targets: WorktreeTarget[]) => void;
}) {
  const [adding, setAdding] = useState('');
  const addable = workspace.repos.filter((r) => !targets.some((t) => t.repo === r) && !workspace.proposed.some((p) => p.repo === r));
  const update = (repo: string, change: Partial<WorktreeTarget>) => onChange(targets.map((t) => {
    if (t.repo !== repo) return t;
    const next: WorktreeTarget = { ...t, ...change };
    for (const key of ['base', 'branch'] as const) if (!next[key]) delete next[key];
    if (!next.adopt) delete next.adopt;
    return next;
  }));
  const evidence = new Map(workspace.proposed.map((p) => [p.repo, `${p.basis}\n${p.evidence.join('\n')}`]));
  const others = alsoMentioned(workspace.proposed, targets);

  return (
    <div className="repo-targets" aria-label="Target repositories">
      <span className="dialog-label">Target repositories</span>
      <p className="handoff-help">
        Preselected from task.md (named in its title, a Type:/Repo: line or its repository table); confirm or edit before running. Each gets a worktree at .worktrees/&lt;repo&gt;-{taskId};
        the first is the primary, where the step runs (and the folder Open opens). Nothing is created until you Run or Open.
      </p>
      {!targets.length && <p className="dialog-error">No repository confirmed: task.md names none that exists under the workspace root, so add one.</p>}
      <ul className="repo-target-list">
        {targets.map((target, i) => {
          const plan = plans.find((p) => p.repo === target.repo);
          return (
            <li key={target.repo} className={`repo-target repo-${plan?.action ?? 'loading'}`}>
              <div className="repo-target-head">
                <strong title={evidence.get(target.repo) ?? 'added by you'}>{target.repo}</strong>
                {i === 0 ? <span className="repo-primary">primary</span>
                  : <button type="button" className="form-button repo-small" disabled={disabled} onClick={() => onChange(makePrimary(targets, target.repo))}>Make primary</button>}
                <span className="repo-plan">{plan ? planLabel(plan) : 'checking…'}</span>
                <button type="button" className="form-button repo-small" disabled={disabled} aria-label={`Remove ${target.repo}`}
                  onClick={() => onChange(targets.filter((t) => t.repo !== target.repo))}>Remove</button>
              </div>
              {plan && <p className="handoff-help">{plan.reason}</p>}
              {plan?.action === 'create' && (
                <label className="repo-base">
                  Base
                  <input key={plan.base} className="form-input" list={`base-${target.repo}`} disabled={disabled} defaultValue={target.base ?? plan.base ?? ''}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (target.base ?? plan.base ?? '')) update(target.repo, { base: v }); }} />
                  <datalist id={`base-${target.repo}`}>
                    {plan.baseOptions?.map((o) => <option key={o.ref} value={o.ref}>{o.why}</option>)}
                  </datalist>
                </label>
              )}
              {plan?.branches && plan.branches.length > 1 && !target.branch && plan.action === 'refuse' && (
                <label className="repo-base">
                  Branch
                  <select className="form-input" disabled={disabled} value="" onChange={(e) => update(target.repo, { branch: e.target.value })}>
                    <option value="" disabled>choose a task branch</option>
                    {plan.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
              )}
              {plan?.action === 'adopt' && (
                <label className="launch-confirm">
                  <input type="checkbox" disabled={disabled} checked={Boolean(target.adopt)} onChange={(e) => update(target.repo, { adopt: e.target.checked })} />
                  Use the existing worktree (recorded as adopted: the dashboard never removes it, and cursor-agent gets no --trust there)
                </label>
              )}
              {plan?.warnings.map((w) => <p key={w} className="handoff-help launch-warning">{w}</p>)}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <div className="repo-also">
          <span className="handoff-help">Also mentioned in task.md (not included unless ticked):</span>
          {others.map((p) => (
            <label key={p.repo} className="launch-confirm" title={p.evidence.join('\n')}>
              <input type="checkbox" checked={false} disabled={disabled} onChange={() => onChange([...targets, { repo: p.repo }])} />
              {p.repo} <span className="repo-plan">{p.basis} · {p.evidence[0] ?? ''}</span>
            </label>
          ))}
        </div>
      )}
      {workspace.referenceOnly.length > 0 && (
        <p className="handoff-help">Reference only, never a worktree: {workspace.referenceOnly.map((r) => r.repo).join(', ')} (read-only under AGENTS.md).</p>
      )}
      <div className="repo-add">
        <select className="form-input" aria-label="Repository to add" disabled={disabled || !addable.length} value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">{addable.length ? 'Add a repository…' : 'No other repositories'}</option>
          {addable.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button type="button" className="form-button" disabled={disabled || !adding}
          onClick={() => { onChange([...targets, { repo: adding }]); setAdding(''); }}>Add</button>
      </div>
    </div>
  );
}
