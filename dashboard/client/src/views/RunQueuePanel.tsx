import { useCallback, useEffect, useState } from 'react';
import type { RunQueueItem, RunQueueView } from '../../../shared/types';
import { queueItemLine } from '../../../shared/runQueue';
import { apiFetchJson } from '../api';
import { queueFailedLine, queuedStatus } from './runQueue';

const RECENT_FAILED_MS = 24 * 60 * 60_000;

/** POST cancel for a waiting queue item; the error text when the server refuses. */
async function cancelItem(id: string): Promise<string | null> {
  try {
    await apiFetchJson(`/api/launch/queue/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return null;
  } catch (e) { return e instanceof Error ? e.message : 'Cancel failed.'; }
}

/**
 * A Run waiting in the queue (Launch card, Run panel): what it waits for, and Cancel
 * while it has not started. onChanged re-reads whatever shows it.
 */
export function QueuedRun({ item, onChanged }: { item: RunQueueItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="launch-status launch-queued">
      <div className="launch-status-head">
        <strong role="status">{queuedStatus(item)}</strong>
        <span className="flow-scope" title={item.enqueuedAt}>queued {new Date(item.enqueuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {item.state === 'waiting' && (
          <button type="button" className="form-button-danger" disabled={busy}
            onClick={async () => { setBusy(true); const err = await cancelItem(item.id); setBusy(false); setError(err ?? ''); onChanged(); }}>
            {busy ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
      {item.step && <p className="handoff-help">{item.step.role} with {item.step.cli} in {item.step.repos.map((r) => r.repo).join(', ')}{item.step.note ? ' · with additional instructions' : ''}. The prompt and worktrees are prepared when it starts.</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </div>
  );
}

/** A queued Run that could not start, until a later launch replaces it. */
export const QueueFailed = ({ item }: { item: RunQueueItem }) => <p className="dialog-error" role="alert">{queueFailedLine(item)}</p>;

// Command › Operations › Run queue (D13): every Run waits here for its trigger, a free
// slot under the cap, and its task to be free; oldest first. Cancel takes a waiting item
// out before it starts. Items that could not start in the last day stay listed with the
// reason. Localhost viewers only, like Running now (the route answers 403 elsewhere).
export function RunQueuePanel() {
  const [view, setView] = useState<RunQueueView | null>(null);
  const [message, setMessage] = useState('');
  const load = useCallback(() => {
    apiFetchJson<RunQueueView>('/api/launch/queue').then(setView).catch(() => setView(null));
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 15_000); return () => clearInterval(timer); }, [load]);
  if (!view) return null;
  const failed = view.recent.filter((i) => i.state === 'failed' && Date.now() - Date.parse(i.endedAt ?? i.enqueuedAt) < RECENT_FAILED_MS);
  return (
    <div className="panel">
      <h3 title="Every Run goes through this queue: it starts when its trigger fires, a slot is free under the cap, and no other step of its task runs. It only advances while the dashboard runs.">
        ⏳ RUN QUEUE · {view.running} of {view.cap} running
      </h3>
      <div className="task-worktrees">
        {view.items.length === 0 && <div className="task-worktrees-empty">Nothing waiting.</div>}
        {view.items.map((item) => (
          <div key={item.id} className="task-worktree">
            <div className="task-worktree-head">
              <span className="task-worktree-state" title={item.id}>{queueItemLine(item)}</span>
              {item.state === 'waiting' && (
                <button type="button" className="form-button repo-small"
                  onClick={async () => { const err = await cancelItem(item.id); setMessage(err ?? `Cancelled ${item.label}.`); load(); }}>Cancel</button>
              )}
            </div>
          </div>
        ))}
        {failed.map((item) => <div key={item.id} className="task-worktree run-queue-failed" title={item.id}>{queueFailedLine(item)}</div>)}
        {message && <div className="task-worktrees-message" role="status">{message}</div>}
      </div>
    </div>
  );
}
