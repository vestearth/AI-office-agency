import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { NewTaskOptions, NewTaskResponse, NewTaskView, RunDetail } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';
import {
  emptyForm, formBlockers, gatesText, idPattern, newTaskLine, pmPolling, prefixLabel, reposLine, requestBody, reviewHeadline, submitLine, togglePreset,
  type NewTaskForm,
} from './newTask';
import { StartTaskDialog } from './StartTaskDialog';

// Command › New task (docs/start-task-redesign-spec.md, D11). The operator types a
// request and picks the prefix and the gate decision; the server claims the next id with
// scripts/open-task.rb in this office checkout and queues a pm step (runs/<TASK> only, no
// worktree) that writes task.md. Then it stops: the review shows task.md, and only
// "Confirm and start chain" lets a chain start (it opens the Start dialog on "Until a
// human is needed", with the repositories proposed from the new task.md). Localhost
// viewers only, like Running now (the routes answer 403 elsewhere).

const GFM = [remarkGfm];
const post = <T,>(url: string, body: unknown) => apiFetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const route = (taskId: string) => `/api/launch/new-task/${encodeURIComponent(taskId)}`;

/** The shared dialog frame: Escape closes, Tab stays inside, focus returns to the trigger. */
function Dialog({ title, task, onClose, children, footer }: { title: string; task?: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    const back = trigger.current;
    return () => back?.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog desktop-handoff" ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          if (e.key === 'Tab') {
            const controls = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
            const first = controls?.[0], last = controls?.[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="dialog-header">
          <span className="dialog-title">{title}</span>
          {task && <span className="dialog-task">{task}</span>}
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>
  );
}

/** New task › the request form. On success it hands the opened task to the review. */
function NewTaskDialog({ options, onClose, onOpened }: { options: NewTaskOptions; onClose: () => void; onOpened: (t: NewTaskView) => void }) {
  const [form, setForm] = useState<NewTaskForm>(() => emptyForm(options));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<NewTaskForm>) => { setForm((f) => ({ ...f, ...patch })); setError(''); };
  const blockers = formBlockers(form, options);
  const order = options.presets.map((p) => p.name);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const res = await post<NewTaskResponse>('/api/launch/new-task', requestBody(form));
      onOpened(res.task);
    } catch (e) { setError(e instanceof Error ? e.message : 'New task failed.'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title="New task" task={idPattern(form.prefix)} onClose={onClose} footer={(
      <>
        <button className="form-button" type="button" onClick={onClose}>Cancel</button>
        <button className="form-button-primary" type="button" disabled={busy || blockers.length > 0} onClick={submit}>{busy ? 'Opening…' : 'Open task and run pm'}</button>
      </>
    )}>
      <label className="dialog-label" htmlFor="new-task-title">Title</label>
      <input id="new-task-title" className="form-input" value={form.title} maxLength={120} disabled={busy} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Wallet: reject a negative debit" />
      <label className="dialog-label" htmlFor="new-task-request">Request</label>
      <textarea id="new-task-request" className="form-input" rows={6} value={form.request} maxLength={4000} disabled={busy} onChange={(e) => set({ request: e.target.value })}
        placeholder="What should change and why; the repositories you know of; how you will know it works. The pm step turns it into task.md." />
      <label className="dialog-label" htmlFor="new-task-prefix">Prefix</label>
      <select id="new-task-prefix" className="form-input" value={form.prefix} disabled={busy} onChange={(e) => set({ prefix: e.target.value })}>
        {!options.prefixes.allowed.includes(form.prefix) && <option value={form.prefix}>Pick a prefix…</option>}
        {options.prefixes.allowed.map((p) => <option key={p} value={p}>{prefixLabel(p)}</option>)}
      </select>
      {options.prefixes.note && <p className="handoff-help">{options.prefixes.note}</p>}
      <span className="dialog-label">Completion gates</span>
      <div className="start-actions" role="group" aria-label="Completion gates">
        {([['presets', 'Gate presets'], ['none', 'No gates']] as const).map(([id, label]) => (
          <button key={id} type="button" className={`section-tab sidebar-chip ${form.gateChoice === id ? 'active' : ''}`} aria-pressed={form.gateChoice === id}
            disabled={busy} onClick={() => set({ gateChoice: id })}>{label}</button>
        ))}
      </div>
      {form.gateChoice === 'presets' ? (
        <>
          <div className="start-actions" role="group" aria-label="Gate presets">
            {options.presets.map((p) => (
              <button key={p.name} type="button" className={`section-tab sidebar-chip ${form.presets.includes(p.name) ? 'active' : ''}`} aria-pressed={form.presets.includes(p.name)}
                title={p.gates.join(' → ')} disabled={busy} onClick={() => set({ presets: togglePreset(form.presets, p.name, order) })}>{p.name}</button>
            ))}
          </div>
          {form.presets.length > 0 && (
            <ul className="cli-usability" aria-label="Gates the task is opened with">
              {options.presets.filter((p) => form.presets.includes(p.name)).map((p) => <li key={p.name} className="ok"><strong>{p.name}</strong> {p.gates.join(' → ')}</li>)}
            </ul>
          )}
          {options.presetsError && <p className="dialog-error">{options.presetsError}</p>}
        </>
      ) : (
        <>
          <label className="dialog-label" htmlFor="new-task-no-gates">Why no completion gates</label>
          <input id="new-task-no-gates" className="form-input" value={form.noGatesReason} maxLength={300} disabled={busy} onChange={(e) => set({ noGatesReason: e.target.value })} placeholder="e.g. office docs only: nothing is deployed" />
        </>
      )}
      <p className="handoff-help">{submitLine(form, options.writer.cli)} The id is claimed when you press Open: if another lane takes it first, the next one is used.</p>
      {blockers.length > 0 && <ul className="dialog-error repo-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </Dialog>
  );
}

/** New task › the stop: the pm step's state, task.md, and the operator's Confirm / Redo pm / Close. */
function NewTaskReviewDialog({ initial, onClose, onChanged }: { initial: NewTaskView; onClose: () => void; onChanged: () => void }) {
  const [task, setTask] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redoing, setRedoing] = useState(false);
  const [note, setNote] = useState('');
  const [chainRun, setChainRun] = useState<RunDetail | null>(null);
  const polling = pmPolling(task);

  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => {
      apiFetchJson<{ task: NewTaskView }>(route(task.taskId)).then((r) => setTask(r.task)).catch(() => undefined);
    }, 4_000);
    return () => clearInterval(timer);
  }, [polling, task.taskId]);

  const act = async (path: 'confirm' | 'close' | 'redo', body: unknown = {}) => {
    setBusy(true); setError('');
    try {
      const res = await post<{ task: NewTaskView }>(`${route(task.taskId)}/${path}`, body);
      setTask(res.task); onChanged();
      if (path === 'confirm') setChainRun(await apiFetchJson<RunDetail>(`/api/runs/${encodeURIComponent(task.taskId)}`));
      if (path === 'redo') { setRedoing(false); setNote(''); }
      if (path === 'close') onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); }
    finally { setBusy(false); }
  };

  if (chainRun) return <StartTaskDialog run={chainRun} initialRunMode="chain" onClose={() => { setChainRun(null); onClose(); }} />;

  const canRedo = task.state === 'review' || task.state === 'pm-failed';
  return (
    <Dialog title="Review the new task" task={task.taskId} onClose={onClose} footer={(
      <>
        <button className="form-button" type="button" onClick={onClose}>Close</button>
        <button className="form-button" type="button" onClick={() => navigateTo('monitor', task.taskId)}>Open in Monitor</button>
        {task.state !== 'pm' && task.state !== 'closed' && task.state !== 'confirmed' && (
          <button className="form-button-danger" type="button" disabled={busy} onClick={() => act('close')}
            title="Takes it off New task. The task stays opened: abort it with the office tools if it should not go on.">Close task here</button>
        )}
        {canRedo && <button className="form-button" type="button" disabled={busy} onClick={() => setRedoing((r) => !r)}>Redo pm</button>}
        {(task.state === 'review' || task.state === 'confirmed') && (
          <button className="form-button-primary" type="button" disabled={busy} onClick={() => act('confirm')}>{busy ? 'Confirming…' : 'Confirm and start chain'}</button>
        )}
      </>
    )}>
      <p className={task.state === 'pm-failed' ? 'dialog-error' : 'handoff-help'} role="status">{reviewHeadline(task)}</p>
      <p className="handoff-help">{task.title} · {gatesText(task)} · pm on {task.cli}{task.attempts.length > 1 ? ` · claimed after ${task.attempts.length - 1} id${task.attempts.length > 2 ? 's' : ''} taken by other lanes (${task.attempts.slice(0, -1).map((a) => a.taskId).join(', ')})` : ''}</p>
      <details>
        <summary className="dialog-label">Your request</summary>
        <p className="handoff-help" style={{ whiteSpace: 'pre-wrap' }}>{task.request}</p>
      </details>
      {task.taskMarkdown && (
        <>
          <span className="dialog-label">task.md (runs/{task.taskId}/task.md)</span>
          <div className="monitor-markdown-body expanded" style={{ maxHeight: 360, overflowY: 'auto' }}><ReactMarkdown remarkPlugins={GFM}>{task.taskMarkdown}</ReactMarkdown></div>
          <p className="handoff-help">{reposLine(task)}{task.nextAction?.reason ? ` Next: ${task.nextAction.agent ?? '?'}, ${task.nextAction.reason}` : ''}</p>
          <p className="handoff-help">To change it yourself, edit runs/{task.taskId}/task.md and reopen this review; or Redo pm with what to change.</p>
        </>
      )}
      {redoing && (
        <>
          <label className="dialog-label" htmlFor="new-task-redo">What the pm step should change <span className="dialog-optional">(optional)</span></label>
          <textarea id="new-task-redo" className="form-input" rows={3} value={note} maxLength={4000} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <div><button className="form-button-primary" type="button" disabled={busy} onClick={() => act('redo', { note })}>{busy ? 'Queueing…' : 'Queue the pm step again'}</button></div>
        </>
      )}
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </Dialog>
  );
}

// Command › Operations › New task: the entry point, and the tasks opened here that still
// need the operator (the pm step running or failed, task.md to review).
export function NewTaskPanel() {
  const [options, setOptions] = useState<NewTaskOptions | null>(null);
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState<NewTaskView | null>(null);
  const load = useCallback(() => {
    apiFetchJson<NewTaskOptions>('/api/launch/new-task').then(setOptions).catch(() => setOptions(null));
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 15_000); return () => clearInterval(timer); }, [load]);
  if (!options) return null;
  return (
    <div className="panel">
      <h3 title="Open a task from a request: the dashboard claims the id with open-task.rb, a pm step writes task.md, and nothing more starts until you confirm it.">
        ✚ NEW TASK
        <button type="button" className="form-button repo-small" style={{ marginLeft: 8 }} onClick={() => setCreating(true)}>New task</button>
      </h3>
      <div className="task-worktrees">
        {options.tasks.length === 0 && <div className="task-worktrees-empty">Nothing opened here waits on you.</div>}
        {options.tasks.map((t) => (
          <div key={t.taskId} className={`task-worktree ${t.state === 'review' ? 'removable' : ''}`}>
            <div className="task-worktree-head">
              <span className={`task-worktree-state${t.state === 'pm-failed' ? ' run-queue-failed' : ''}`} title={t.request}>{newTaskLine(t)}</span>
              <button type="button" className="form-button repo-small" onClick={() => setReviewing(t)}>{t.state === 'review' ? 'Review' : 'Open'}</button>
            </div>
          </div>
        ))}
      </div>
      {creating && <NewTaskDialog options={options} onClose={() => setCreating(false)} onOpened={(t) => { setCreating(false); setReviewing(t); load(); }} />}
      {reviewing && <NewTaskReviewDialog initial={reviewing} onClose={() => { setReviewing(null); load(); }} onChanged={load} />}
    </div>
  );
}
