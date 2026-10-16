import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { OPEN_TARGET_LABELS } from '../../../shared/openHandoff';
import type { OfficeLaunchTools, OpenTarget, TaskOpenResponse, WorktreeTarget } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { OPEN_TARGET_HELP, OPEN_TARGETS, openBlockers, openDoneMessage, promptLengthLine } from './startTask';
import { makePrimary, startNotes } from './taskWorkspace';

// Start or open task › Open (spec D15): the same step handed to an app the operator
// drives, on the task's worktree (made or reused like a Run's), the prompt filled in and
// not sent. The server opens the app's deep link with /usr/bin/open (macOS only); Cursor
// is prompt only. Open takes no lease and the dashboard does not verify the session: the
// hand-off is recorded on the task so a later Run warns.
export function OpenPanel({ taskId, role, note, tools, targets, primary, blockers, prompt, onTargets, onOpened, actionsTarget }: {
  taskId: string; role: string; note: string;
  tools: OfficeLaunchTools | null;
  targets: WorktreeTarget[] | null;
  primary?: string;
  blockers: string[];
  prompt: string;
  onTargets: (targets: WorktreeTarget[]) => void;
  /** After a hand-off: re-read the task (its newest hand-off). */
  onOpened: () => void;
  actionsTarget: HTMLElement | null;
}) {
  const [target, setTarget] = useState<OpenTarget>(tools?.open.available === false ? 'cursor' : 'claude-desktop');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<TaskOpenResponse | null>(null);
  const [message, setMessage] = useState('');
  const repoKey = JSON.stringify(targets);
  useEffect(() => { setDone(null); setMessage(''); setError(''); }, [target, role, note, repoKey]);
  useEffect(() => { if (tools?.open.available === false) setTarget('cursor'); }, [tools?.open.available]);

  const linkBlockers = openBlockers(target, tools?.open, prompt);
  const disabled = busy || !targets || !prompt || blockers.length > 0 || linkBlockers.length > 0;

  const open = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const res = await apiFetchJson<TaskOpenResponse>(`/api/launch/task/${encodeURIComponent(taskId)}/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, role, note, repos: targets }),
      });
      setDone(res);
      onOpened();
    } catch (e) { setError(e instanceof Error ? e.message : 'Open failed.'); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(done?.prompt ?? prompt); setMessage('Prompt copied.'); }
    catch {
      const box = document.getElementById('start-prompt') as HTMLTextAreaElement | null;
      box?.focus(); box?.select();
      setMessage('Clipboard access was blocked. The prompt is selected; copy it manually.');
    }
  };

  const buttons = (
    <>
      <button type="button" className="form-button" disabled={!prompt} onClick={copy}>Copy prompt</button>
      <button type="button" className="form-button-primary" disabled={disabled} onClick={open}>
        {busy ? 'Opening…' : target === 'cursor' ? 'Prepare worktree' : `Open in ${OPEN_TARGET_LABELS[target]}`}
      </button>
    </>
  );

  return (
    <section className="cli-panel" aria-label="Open the step in an app">
      <label className="dialog-label" htmlFor="open-target">App</label>
      <select id="open-target" className="form-input" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value as OpenTarget)}>
        {OPEN_TARGETS.map((t) => (
          <option key={t} value={t} disabled={t !== 'cursor' && tools?.open.available === false}>
            {OPEN_TARGET_LABELS[t]}{t !== 'cursor' && tools?.open.available === false ? ' (macOS only)' : ''}
          </option>
        ))}
      </select>
      <p className="handoff-help">{OPEN_TARGET_HELP[target]}</p>
      {targets && targets.length > 1 && (
        <>
          <label className="dialog-label" htmlFor="open-folder">Folder to open</label>
          <select id="open-folder" className="form-input" value={targets[0].repo} disabled={busy} onChange={(e) => onTargets(makePrimary(targets, e.target.value))}>
            {targets.map((t) => <option key={t.repo} value={t.repo}>{t.repo} worktree</option>)}
          </select>
          <p className="handoff-help">The app opens one folder: the primary worktree. The prompt names the others as also writable.</p>
        </>
      )}
      <p className="handoff-help">
        Opens on {primary ?? 'the primary worktree'} (made or reused when you open, like a Run&apos;s). No lease is taken and the dashboard does not
        verify or commit the session; the prompt has the session run validate-yaml.rb and leave status sync and the commit to you. The hand-off is
        recorded on the task (runs/{taskId}/open-handoffs.yaml), so a later Run warns.
      </p>
      {target !== 'cursor' && tools?.open.promptCap && prompt && <p className="handoff-help" role="status">{promptLengthLine(prompt, tools.open.promptCap)}</p>}
      {linkBlockers.map((b) => <p key={b} className="dialog-error">{b}</p>)}
      {actionsTarget && createPortal(buttons, actionsTarget)}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {done && <p className="handoff-status" role="status">{openDoneMessage(done)}</p>}
      {done && startNotes(done).map((n) => <p key={n} className={`handoff-help${/could not fetch/.test(n) ? ' launch-warning' : ''}`} role="status">{n}</p>)}
      {message && <p className="handoff-status" role="status">{message}</p>}
    </section>
  );
}
