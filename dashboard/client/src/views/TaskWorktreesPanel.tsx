import { useCallback, useEffect, useState } from 'react';
import type { WorktreeCleanup } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { cleanupSummary } from './taskWorkspace';

// Command › Operations › Task worktrees (docs/start-task-redesign-spec.md, D14): the
// worktrees the dashboard created for Runs (never adopted ones, never anything it did
// not record), each with why it is or is not removable. Remove asks for a confirmation;
// the server re-checks, runs `git worktree remove` without --force, and deletes the
// branch only when that is ticked too and the branch is the dashboard's and merged.
export function TaskWorktreesPanel() {
  const [views, setViews] = useState<WorktreeCleanup[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    apiFetchJson<{ worktrees: WorktreeCleanup[] }>('/api/launch/worktrees').then((r) => setViews(r.worktrees)).catch(() => setViews(null));
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 60_000); return () => clearInterval(timer); }, [load]);

  if (views === null) return null;
  const key = (v: WorktreeCleanup) => `${v.task}/${v.repo}`;

  const remove = async (v: WorktreeCleanup) => {
    setBusy(true); setMessage('');
    try {
      const res = await apiFetchJson<{ removed: boolean; forgot: boolean; branchDeleted: boolean }>('/api/launch/worktrees/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: v.task, repo: v.repo, confirm: true, deleteBranch: deleteBranch && v.canDeleteBranch }),
      });
      setMessage(res.forgot ? `Forgot ${v.path} (already gone).` : `Removed ${v.path}${res.branchDeleted ? ` and deleted ${v.branch}` : `; ${v.branch} kept`}.`);
      setConfirming(null); setDeleteBranch(false);
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Removal failed.'); }
    finally { setBusy(false); load(); }
  };

  return (
    <div className="panel">
      <h3 title="Worktrees the dashboard created for Runs. Adopted worktrees and ones it did not create are never listed or removed here.">⎇ TASK WORKTREES</h3>
      <div className="task-worktrees">
        {views.length === 0 && <div className="task-worktrees-empty">No worktrees created by the dashboard.</div>}
        {views.map((v) => (
          <div key={key(v)} className={`task-worktree ${v.removable ? 'removable' : ''}`}>
            <div className="task-worktree-head">
              <span title={v.path}>{v.task} · {v.repo}</span>
              <span className="task-worktree-state">{cleanupSummary(v)}</span>
              {v.removable && confirming !== key(v) && (
                <button type="button" className="form-button repo-small" disabled={busy} onClick={() => { setConfirming(key(v)); setDeleteBranch(false); setMessage(''); }}>
                  {v.action === 'forget' ? 'Forget' : 'Remove'}
                </button>
              )}
            </div>
            <details>
              <summary>{v.branch}{v.base ? ` · base ${v.base}` : ''}</summary>
              <ul>{v.checks.map((c) => <li key={c.text} className={c.ok ? 'ok' : 'fail'}>{c.ok ? '✓' : '✗'} {c.text}</li>)}</ul>
            </details>
            {confirming === key(v) && (
              <div className="task-worktree-confirm" role="group" aria-label={`Confirm removing ${v.path}`}>
                <span>{v.action === 'forget' ? `Forget the record of ${v.path}?` : `Remove ${v.path} (git worktree remove, no --force)?`}</span>
                {v.canDeleteBranch && (
                  <label className="launch-confirm">
                    <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                    Also delete {v.branch} (created by the dashboard, merged into {v.base})
                  </label>
                )}
                <button type="button" className="form-button-danger repo-small" disabled={busy} onClick={() => remove(v)}>{busy ? 'Removing…' : 'Confirm'}</button>
                <button type="button" className="form-button repo-small" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            )}
          </div>
        ))}
        {message && <div className="task-worktrees-message" role="status">{message}</div>}
      </div>
    </div>
  );
}
