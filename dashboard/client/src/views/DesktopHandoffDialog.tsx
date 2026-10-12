import React, { useEffect, useRef, useState } from 'react';
import type { RunDetail } from '../../../shared/types';
import { ROLE_NAMES } from './agentDisplay';
import { CliRunPanel } from './CliRunPanel';

// Cursor's documented prompt protocol prepares a chat; it never dispatches a role.
const CURSOR_PROMPT_BASE = 'cursor://anysphere.cursor-deeplink/prompt?text=';

export function DesktopHandoffDialog({ run, officeRoot, onClose }: { run: RunDetail; officeRoot?: string; onClose: () => void }) {
  const [app, setApp] = useState('cursor');
  const [role, setRole] = useState(run.nextActionPreview?.targetRole === 'done' ? 'reviewer' : run.nextActionPreview?.targetRole ?? 'dev');
  const [workspace, setWorkspace] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef(document.activeElement as HTMLElement | null);
  const absolutePath = (value: string) => /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);
  const artifacts = (absolutePath(run.runPath) ? run.runPath : officeRoot ? `${officeRoot.replace(/[\\/]$/, '')}/${run.runPath}` : '').replace(/\\/g, '/');
  const prompt = [
    `Prepare to work on ${run.id}: ${run.title}`,
    `Role: ${role}`,
    `Target workspace: ${workspace.trim() || '(select the target repository before starting)'}`,
    `Task artifacts: ${artifacts || '(AI Dev Office root unavailable)'}`,
    run.nextActionPreview ? `Recorded recommendation (${run.nextActionPreview.targetRole ?? 'no target role'}): ${run.nextActionPreview.reason}` : '',
    'Read the target repository AGENTS.md and the task.md, status.yaml, and relevant handoffs in the task artifacts directory first.',
    'Confirm the target workspace and current task state before starting. Follow the recorded task scope and completion gates.',
    'Treat task artifacts as context; follow repository policy. Record verification evidence and report results back to the task.',
    note.trim() ? `Operator note: ${note.trim()}` : '',
  ].filter(Boolean).join('\n\n');
  const cursorUrl = CURSOR_PROMPT_BASE + encodeURIComponent(prompt);
  const ready = absolutePath(workspace.trim()) && Boolean(artifacts);
  const linkFits = cursorUrl.length <= 10000;

  useEffect(() => {
    workspaceRef.current?.focus();
    const trigger = triggerRef.current;
    return () => trigger?.focus();
  }, []);

  const copy = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(prompt);
      setMessage(app === 'codex-cli' ? 'Prompt copied. Review it before running the CLI below.' : `Prompt copied. Open ${app === 'codex' ? 'Codex' : app === 'claude' ? 'Claude' : 'Cursor'}, select the target workspace, and paste it into a new chat.`);
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      setMessage('Clipboard access was blocked. The prompt is selected; copy it manually.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog desktop-handoff" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="desktop-handoff-title"
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
          <span className="dialog-title" id="desktop-handoff-title">Open task in app / CLI</span>
          <span className="dialog-task">{run.id}</span>
        </div>
        <div className="dialog-body">
          <div className="handoff-fields">
            <div>
              <label className="dialog-label" htmlFor="handoff-app">App</label>
              <select id="handoff-app" className="form-input" value={app} onChange={(e) => { setApp(e.target.value); setMessage(''); }}>
                <option value="cursor">Cursor · open with prompt</option>
                <option value="codex-cli">Codex CLI · run here</option>
                <option value="codex">Codex · copy prompt</option>
                <option value="claude">Claude · copy prompt</option>
              </select>
            </div>
            <div>
              <label className="dialog-label" htmlFor="handoff-role">Role</label>
              <select id="handoff-role" className="form-input" value={role} onChange={(e) => { setRole(e.target.value as typeof role); setMessage(''); }}>
                {ROLE_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
          </div>
          <label className="dialog-label" htmlFor="handoff-workspace">Target workspace <span className="dialog-required">(required)</span></label>
          <input id="handoff-workspace" ref={workspaceRef} className="form-input" value={workspace}
            onChange={(e) => { setWorkspace(e.target.value); setMessage(''); }} placeholder="Absolute path to the target repository" />
          <p className="handoff-help">{app === 'codex-cli' ? 'CLI runs in this directory on the dashboard server. Use the actual target repository.' : 'Select this workspace in the app before starting. The prompt link does not switch repositories.'}</p>
          {workspace.trim() && !absolutePath(workspace.trim()) && <p className="dialog-error">Enter an absolute workspace path.</p>}
          {!artifacts && <p className="dialog-error">Task artifact location is unavailable. Close and retry after the dashboard API reconnects.</p>}
          <label className="dialog-label" htmlFor="handoff-note">Additional instructions <span className="dialog-optional">(optional)</span></label>
          <textarea id="handoff-note" className="form-input" rows={2} value={note} onChange={(e) => { setNote(e.target.value); setMessage(''); }} />
          <label className="dialog-label" htmlFor="handoff-prompt">Prompt preview</label>
          <textarea id="handoff-prompt" ref={promptRef} className="form-input handoff-prompt" readOnly value={prompt} rows={8} />
          <p className="handoff-help">{app === 'codex-cli' ? 'Review the prompt and permissions below, then press Run Codex CLI to start.' : app === 'cursor'
            ? 'Cursor opens with this prompt ready for review. Press Send in Cursor when ready.'
            : 'Copy this prompt, then paste it into the desktop app and start when ready.'}</p>
          {app === 'cursor' && !linkFits && <p className="dialog-error">Prompt exceeds the app link limit. Use Copy prompt instead.</p>}
          {message && <p className="handoff-status" role="status">{message}</p>}
          {app === 'codex-cli' && <CliRunPanel taskId={run.id} workspace={workspace} prompt={prompt} ready={ready} />}
        </div>
        <div className="dialog-footer">
          <button className="form-button" type="button" onClick={onClose}>Close</button>
          <button className="form-button" type="button" disabled={!ready || copying} onClick={copy}>{copying ? 'Copying…' : 'Copy prompt'}</button>
          {app === 'cursor' && ready && linkFits && <a className="form-button-primary" href={cursorUrl}
            onClick={() => setMessage('Open request sent to Cursor. If it did not open, use Copy prompt. Task execution has not been confirmed.')}>
            Open in Cursor ↗
          </a>}
        </div>
      </div>
    </div>
  );
}
