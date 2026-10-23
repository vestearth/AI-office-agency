import { useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import type { ReleaseLadderResponse, ReleaseLadderTask } from '../../../shared/types';
import { RUNG_LABEL } from '../../../shared/releaseLadder';
import { apiFetchJson } from '../api';

// Monitor › run detail › Release: what a release train carries (and how far each
// carried task is proven), or which trains carry this task to production. The
// data is the Readiness ladder (GET /api/reports/release-ladder), read once a
// minute at most: the same contract, never a second interpretation.

const TTL_MS = 60_000;
let cache: { at: number; index: Map<string, ReleaseLadderTask> } | null = null;
let inflight: Promise<Map<string, ReleaseLadderTask>> | null = null;

function releaseAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function storeReleaseIndex(res: ReleaseLadderResponse): Map<string, ReleaseLadderTask> {
  const index = new Map(res.products.flatMap((p) => p.tasks.map((t) => [t.id, t] as const)));
  cache = { at: Date.now(), index };
  return index;
}

export function clearReleaseIndexCache(): void {
  cache = null;
  inflight = null;
}

// A caller that passes a signal owns that request: cancelling it must not
// reject the shared read used by ReleaseCard. Callers without a signal keep
// the single in-flight coalescing read.
export function loadReleaseIndex(signal?: AbortSignal): Promise<Map<string, ReleaseLadderTask>> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.index);
  if (signal?.aborted) return Promise.reject(releaseAbortError());
  if (signal) {
    return apiFetchJson<ReleaseLadderResponse>('/api/reports/release-ladder', { signal })
      .then((res) => {
        if (signal.aborted) throw releaseAbortError();
        return storeReleaseIndex(res);
      });
  }
  inflight ??= apiFetchJson<ReleaseLadderResponse>('/api/reports/release-ladder')
    .then((res) => storeReleaseIndex(res))
    .finally(() => { inflight = null; });
  return inflight;
}

/** The prod rung a person cares about: "Prod deployed: pending via TASK-EAR-406". */
export function prodLine(t: ReleaseLadderTask | undefined): string {
  if (!t) return 'not on the ladder';
  const dp = t.rungs.deploy_production;
  const pa = t.rungs.production_acceptance;
  const cell = pa.status === 'pass' ? pa : dp;
  const rung = cell === pa ? RUNG_LABEL.production_acceptance : RUNG_LABEL.deploy_production;
  if (cell.status === 'absent') return t.highest ? RUNG_LABEL[t.highest] : 'no rung passed';
  return `${rung}: ${cell.status}${cell.via ? ` via ${cell.via}` : ''}`;
}

export function ReleaseCard({ runId, carries, onSelectRun }: {
  runId: string;
  /** status.yaml carries of this run (from the run detail). */
  carries?: string[];
  onSelectRun: (id: string) => void;
}) {
  const [index, setIndex] = useState<Map<string, ReleaseLadderTask> | null>(cache?.index ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadReleaseIndex().then((i) => { if (active) setIndex(i); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [runId]);

  const self = index?.get(runId);
  const carriedBy = self?.carriedBy ?? [];
  if (!carries?.length && carriedBy.length === 0) return null;

  return (
    <div className="card monitor-section-card release-card">
      <div className="panel-heading"><Rocket size={14} /> <span>Release</span></div>
      {error && <div className="muted-meta">Readiness unavailable: {error}</div>}
      {carriedBy.length > 0 && (
        <p className="release-carried-by">
          Carried to production by{' '}
          {carriedBy.map((id, i) => (
            <span key={id}>{i > 0 && ', '}<button type="button" className="action-waits-link" onClick={() => onSelectRun(id)}>{id}</button></span>
          ))}
          <span className="release-prod"> · {prodLine(self)}</span>
          {carriedBy.length > 1 && <span className="release-note">Proven only when every carrying train passes.</span>}
        </p>
      )}
      {carries && carries.length > 0 && (
        <>
          <div className="release-sub">Carries {carries.length} task{carries.length === 1 ? '' : 's'}</div>
          <ul className="release-list">
            {carries.map((id) => {
              const t = index?.get(id);
              return (
                <li key={id}>
                  <button type="button" className="action-waits-link" onClick={() => onSelectRun(id)} title={t?.title}>{id}</button>
                  <span className="release-title">{t?.title ?? ''}</span>
                  <span className="release-rung">{index ? (t?.highest ? RUNG_LABEL[t.highest] : 'no rung passed') : '…'}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
