import React, { useEffect, useRef, useState } from 'react';
import { apiFetchJson } from '../api';

interface Run {
  id: string; workspace: string; sandbox: string; status: string;
  output: string; truncated: boolean; startedAt: string; finishedAt?: string; exitCode?: number | null;
}

export function CliRunPanel({ taskId, workspace, prompt, ready }: { taskId: string; workspace: string; prompt: string; ready: boolean }) {
  const [run, setRun] = useState<Run | null>(null);
  const [available, setAvailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sandbox, setSandbox] = useState('read-only');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const generation = useRef(0);
  const mutationPending = useRef(false);
  useEffect(() => { setError(''); }, [workspace, prompt, sandbox]);
  const active = run && ['running', 'stopping'].includes(run.status);
  const route = `/api/cli/${encodeURIComponent(taskId)}`;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const version = generation.current;
      try {
        const [tools, status] = await Promise.all([
          apiFetchJson<{ tools: { id: string; available: boolean }[] }>('/api/cli/tools'),
          apiFetchJson<{ run: Run | null }>(route),
        ]);
        if (!cancelled && !mutationPending.current && version === generation.current) { setAvailable(tools.tools.some((t) => t.id === 'codex' && t.available)); setRun(status.run); setLoaded(true); setPollError(''); }
      } catch (e) { if (!cancelled) { setPollError(e instanceof Error ? e.message : 'Could not load CLI status.'); setLoaded(false); } }
      if (!cancelled) timer = setTimeout(refresh, 2000);
    };
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [route]);
  const act = async (stop: boolean) => {
    generation.current++; mutationPending.current = true;
    setBusy(true); setError('');
    try {
      const result = await apiFetchJson<{ run: Run }>(stop ? `${route}/stop` : route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stop ? { id: run?.id } : { cli: 'codex', workspace: workspace.trim(), sandbox, prompt }),
      });
      setRun(result.run);
    } catch (e) { setError(e instanceof Error ? e.message : 'CLI request failed.'); }
    finally { generation.current++; mutationPending.current = false; setBusy(false); }
  };
  return <section className="cli-panel" aria-label="Codex CLI execution">
    <label className="dialog-label" htmlFor="cli-sandbox">CLI permissions</label>
    <select id="cli-sandbox" className="form-input" value={sandbox} disabled={Boolean(active) || busy} onChange={(e) => setSandbox(e.target.value)}>
      <option value="read-only">Read only · inspect and review</option>
      <option value="workspace-write">Workspace write · implement changes</option>
    </select>
    <p className="handoff-help">Runs on the dashboard server using its existing Codex login. Requests needing interactive approval cannot proceed in this mode.</p>
    <code className="cli-command">codex exec --json --color never --sandbox {sandbox} -c approval_policy="never" -</code>
    <p className="handoff-help">Working directory: {workspace.trim() || 'Enter a target workspace above.'} · Prompt: preview above, sent through stdin.</p>
    {loaded && !available && <p className="dialog-error">Codex CLI is not installed on the server PATH. Use Copy prompt instead.</p>}
    <div className="cli-actions">
      <button type="button" className="form-button-primary" disabled={!loaded || !available || !ready || busy || Boolean(active)} onClick={() => act(false)}>{busy ? 'Sending…' : 'Run Codex CLI'}</button>
      {active && <button type="button" className="form-button-danger" disabled={busy || run?.status === 'stopping'} onClick={() => act(true)}>Stop CLI</button>}
    </div>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {pollError && <p className="dialog-error" role="alert">{pollError}</p>}
    {run && <div>
      <p className="handoff-status" role="status">CLI: {run.status}{run.exitCode != null ? ` · exit ${run.exitCode}` : ''}</p>
      <p className="handoff-help">{run.workspace} · {run.sandbox} · {run.startedAt}</p>
      {run.truncated && <p className="handoff-help">Showing the last 200,000 characters.</p>}
      <pre className="cli-output" aria-label="CLI output">{run.output || 'Waiting for CLI output…'}</pre>
    </div>}
    <p className="handoff-help">CLI exit status is separate from task completion. Logs are held in memory until the dashboard server restarts; closing this dialog keeps the CLI running.</p>
  </section>;
}
