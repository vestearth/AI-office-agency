import { useCallback, useEffect, useState } from 'react';
import type { OfficeLaunch, TaskStepResult } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { isActive, launchOutput, launchStarted, launchSummary, stepResultSections, stepVerdict } from './officeLaunch';

const POLL_MS = 3000;

type LaunchBody = { launch: OfficeLaunch | null };

/**
 * The newest launch at `route` (GET, with whatever else the route reports), refreshed
 * while it runs and once more when it ends; start = POST, stop = POST /api/launch/:id/stop.
 */
export function useOfficeLaunch<T extends LaunchBody = LaunchBody>(route: string, options: {
  /** Keep polling while this holds even with no launch running (a multi-round chain between rounds). */
  keepPolling?: (data: T) => boolean;
  /** POST here to stop instead of /api/launch/:id/stop. */
  stopRoute?: string;
  /** Also re-read this often while nothing runs, to notice a launch started elsewhere. */
  idlePollMs?: number;
} = {}) {
  const [data, setData] = useState<T | null>(null);
  const launch = data?.launch ?? null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The body of the last start or stop, beyond its launch (a task start's worktree notes). */
  const [lastResponse, setLastResponse] = useState<Record<string, unknown> | null>(null);
  const [reload, setReload] = useState(0);
  const active = isActive(launch);
  const { keepPolling, stopRoute, idlePollMs } = options;
  const polling = active || Boolean(data && keepPolling?.(data));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const res = await apiFetchJson<T>(route);
        if (cancelled) return;
        setData(res);
        if (isActive(res.launch) || keepPolling?.(res)) timer = setTimeout(refresh, POLL_MS);
        else if (idlePollMs) timer = setTimeout(refresh, idlePollMs);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the launch.'); }
    };
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
    // Re-read after a start or stop, and whenever polling turns on or off.
  }, [route, polling, reload]);

  /** POSTs and returns the response body (null on an error, shown in `error`). */
  const send = useCallback(async (url: string, body: unknown) => {
    setBusy(true); setError('');
    try {
      const res = await apiFetchJson<{ launch: OfficeLaunch | null } & Record<string, unknown>>(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setLastResponse(res);
      // A Run that only queued (202, no launch) keeps showing the previous launch.
      setData((current) => ({ ...(current ?? {}), launch: res.launch ?? current?.launch ?? null } as T));
      setReload((n) => n + 1);
      return res;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return null; }
    finally { setBusy(false); }
  }, []);
  const post = useCallback(async (url: string, body: unknown) => (await send(url, body))?.launch ?? null, [send]);

  return {
    data, launch, error, busy, active, lastResponse,
    /** Re-read the route now (after a queue item was cancelled elsewhere on the page). */
    refresh: () => setReload((n) => n + 1),
    start: (body: unknown = {}) => post(route, body),
    /** start, returning the whole response (a queued Run has no launch, only its queue item). */
    submit: (body: unknown = {}) => send(route, body),
    /** POST elsewhere (a chain start or stop under the route), returning the whole response; the route is re-read after. */
    submitTo: (url: string, body: unknown = {}) => send(url, body),
    stop: () => (stopRoute ? post(stopRoute, {}) : launch ? post(`/api/launch/${encodeURIComponent(launch.id)}/stop`, {}) : Promise.resolve(null)),
  };
}

export function OfficeLaunchStatus({ launch, busy, onStop }: { launch: OfficeLaunch; busy: boolean; onStop: () => void }) {
  const output = launchOutput(launch);
  return (
    <div className={`launch-status launch-${launch.status}`}>
      <div className="launch-status-head">
        <strong role="status">{launch.label}: {launchSummary(launch)}</strong>
        <span className="flow-scope" title={launch.startedAt}>{launchStarted(launch)}</span>
        {isActive(launch) && <button type="button" className="form-button-danger" disabled={busy || launch.status === 'stopping'} onClick={onStop}>Stop</button>}
      </div>
      <code className="cli-command">{launch.command}</code>
      {launch.failureReason && <p className="dialog-error" role="alert">Failed: {launch.failureReason}</p>}
      <details open={isActive(launch) || Boolean(launch.progress)}>
        <summary>{output.label}</summary>
        <pre className="cli-output">{output.text}</pre>
      </details>
      {launch.progress && (
        <details>
          <summary>Raw output (streamed JSON{launch.truncated ? ', last 64 KB' : ''})</summary>
          <pre className="cli-output">{launch.log || 'No output yet.'}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * What happened after a task step ended (D7), as the server did it: the protocol result,
 * each office script it ran (validate, enforce, sync), agent-commit detection, and its own
 * commit per worktree (sha), or why each was skipped.
 */
export function StepResult({ result }: { result: TaskStepResult }) {
  const ok = result.state === 'done' && result.protocol.ok && result.verified && result.agentCommits.ok && !result.commits.some((c) => c.status === 'failed');
  return (
    <div className={`launch-contract ${result.state === 'verifying' ? '' : ok ? 'met' : 'unmet'}`} role="status">
      <strong>{stepVerdict(result)}</strong> · checked by the dashboard with the office scripts after the step, not taken from the CLI exit code
      {result.runId && <span className="flow-scope"> · run {result.runId}</span>}
      {stepResultSections(result).map((section) => (
        <div key={section.title}>
          <span className="dialog-label">{section.title}</span>
          <ul>{section.lines.map((l, i) => (
            <li key={`${section.title}-${i}`} className={l.ok === null ? 'skip' : l.ok ? 'ok' : 'fail'}>
              {l.ok === null ? '–' : l.ok ? '✓' : '✗'} {l.text}
              {l.output && <pre className="cli-output">{l.output}</pre>}
            </li>
          ))}</ul>
        </div>
      ))}
    </div>
  );
}
