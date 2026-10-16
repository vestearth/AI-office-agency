import { useCallback, useEffect, useState } from 'react';
import type { OfficeLaunch, TaskLaunchContract } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { contractLines, isActive, launchOutput, launchStarted, launchSummary } from './officeLaunch';

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

  const post = useCallback(async (url: string, body: unknown) => {
    setBusy(true); setError('');
    try {
      const res = await apiFetchJson<{ launch: OfficeLaunch | null }>(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setData((current) => ({ ...(current ?? {}), launch: res.launch } as T));
      setReload((n) => n + 1);
      return res.launch;
    } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); return null; }
    finally { setBusy(false); }
  }, []);

  return {
    data, launch, error, busy, active,
    start: (body: unknown = {}) => post(route, body),
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

/** What a finished task step left behind, as the server checked it (not the CLI exit code). */
export function LaunchContract({ contract }: { contract: TaskLaunchContract }) {
  return (
    <div className={`launch-contract ${contract.met ? 'met' : 'unmet'}`} role="status">
      <strong>{contract.met ? 'Contract met' : 'Contract not met'}</strong> · checked by the server after the run, not taken from the CLI exit code
      <ul>{contractLines(contract).map((l) => <li key={l.text} className={l.ok ? 'ok' : 'fail'}>{l.ok ? '✓' : '✗'} {l.text}</li>)}</ul>
      {!contract.validation.ok && contract.validation.output && <pre className="cli-output">{contract.validation.output}</pre>}
    </div>
  );
}
