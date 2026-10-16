import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronDown, ClipboardCopy, Loader2, RefreshCw } from 'lucide-react';
import type { ProdSignalsResponse, SignalCoverage, SignalEnv, SignalGroup } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';
import { useToast } from '../components/Toast';
import { formatAge } from './formatAge';
import { allDuringDeploys, closedLabel, deployLine, ictTime, signalBrief } from './prodSignalsBrief';

// Command › Attention › Production signals: what is failing in running services
// and whether a run owns it. Loaded separately from the Action Center so a slow
// CloudWatch read (first load can take about a minute) never delays the inbox.

const COVERAGE_META: Record<SignalCoverage, { label: string; className: string }> = {
  unowned: { label: 'Unowned', className: 'unowned' },
  recurs_after: { label: 'Recurs after a closed run', className: 'recurs' },
  closed_recently: { label: 'Owner closed recently', className: 'closed' },
  mentioned: { label: 'Mentioned by an open run', className: 'mentioned' },
};

function TaskLinks({ refs, closed }: { refs: SignalGroup['mentionedBy']; closed?: boolean }) {
  return (
    <>
      {refs.map((r) => (
        <button key={r.id} type="button" className="action-waits-link" onClick={() => navigateTo('monitor', r.id)}
          title={`${r.title}\nmatched: ${r.terms.join(', ')}`}>
          {r.id}{closed && r.completedAt ? ` (closed ${closedLabel(r.completedAt)})` : ''}
        </button>
      ))}
    </>
  );
}

function SignalRow({ g, res }: { g: SignalGroup; res: ProdSignalsResponse }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(signalBrief(g, res));
      toast.show('Task brief copied');
    } catch {
      toast.show('Clipboard not available', 'error');
    }
  };
  return (
    <li className={`signals-row ${COVERAGE_META[g.coverage].className}`}>
      <div className="signals-count" title={g.partialSince ? `At least ${g.failures}: the log was read back to ${ictTime(g.partialSince)} ICT only` : `${g.logLines} log lines`}>
        <strong>{g.partialSince ? '≥' : ''}{g.failures}</strong>
        <small>failure{g.failures === 1 ? '' : 's'}</small>
      </div>
      <div className="signals-main">
        <code className="signals-signature">{g.signature}</code>
        <small className="signals-meta">
          {g.service} · first {ictTime(g.firstAt)} · last {ictTime(g.lastAt)} ICT · {g.hours}h with failures
          {g.recurring && <span className="signals-badge">recurring</span>}
          {g.partialSince && <span className="signals-badge">partial read · since {ictTime(g.partialSince)}</span>}
          {g.deploys && (
            <span className="signals-badge signals-badge-deploy" title={deployLine(g) ?? undefined}>
              {allDuringDeploys(g) ? 'all' : `${g.deploys.during}/${g.failures}`} during {g.deploys.windows.length === 1 ? 'a deploy' : `${g.deploys.windows.length} deploys`}
            </span>
          )}
        </small>
        <span className="signals-coverage">
          <span className={`signals-chip ${COVERAGE_META[g.coverage].className}`}>{COVERAGE_META[g.coverage].label}</span>
          {g.mentionedBy.length > 0 && <>in <TaskLinks refs={g.mentionedBy} /></>}
          {g.recursAfter.length > 0 && <>{g.mentionedBy.length > 0 ? '· still failing after ' : 'still failing after '}<TaskLinks refs={g.recursAfter} closed /></>}
          {g.coverage === 'closed_recently' && <>by <TaskLinks refs={g.closedRecently} closed /> · no failure after its close yet</>}
        </span>
        <details className="signals-sample">
          <summary>Sample (redacted)</summary>
          <code>{g.sample}</code>
        </details>
      </div>
      <button type="button" className="form-button signals-copy" onClick={copy} aria-label={`Copy task brief for ${g.signature}`}>
        <ClipboardCopy size={13} /> Copy task brief
      </button>
    </li>
  );
}

export const PROD_SIGNALS_ANCHOR = 'production-signals';

export function ProdSignalsPanel({ onProdCounts }: {
  /** Production counts for Attention's top line, reported whenever a production read lands. */
  onProdCounts?: (counts: { unowned: number; recursAfter: number; recursAfterDuringDeploy: number } | null) => void;
} = {}) {
  const [env, setEnv] = useState<SignalEnv>('prod');
  const [data, setData] = useState<ProdSignalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    let active = true;
    setLoading(true);
    setError(null);
    apiFetchJson<ProdSignalsResponse>(`/api/signals?env=${env}${refresh ? '&refresh=1' : ''}`)
      .then((d) => {
        if (!active) return;
        setData(d);
        // A stale result came back while a fresh read runs on the server: fetch it once it is ready.
        if (d.refreshing) window.setTimeout(() => { if (active) load(); }, 15_000);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [env]);

  useEffect(() => load(), [load]);

  const shown = data && data.env === env ? data : null;
  useEffect(() => {
    if (data?.env === 'prod') onProdCounts?.({
      unowned: data.counts.unowned, recursAfter: data.counts.recurs_after,
      recursAfterDuringDeploy: data.groups.filter((g) => g.coverage === 'recurs_after' && allDuringDeploys(g)).length,
    });
  }, [data, onProdCounts]);
  // Owned groups (an open run, or one that just closed) fold away; the rest need a decision.
  const owned = (g: SignalGroup) => g.coverage === 'mentioned' || g.coverage === 'closed_recently';
  const open = shown?.groups.filter((g) => !owned(g)) ?? [];
  const mentioned = shown?.groups.filter(owned) ?? [];

  return (
    <section className="signals" id={PROD_SIGNALS_ANCHOR} aria-label="Production signals">
      <div className="signals-header">
        <div>
          <strong className="signals-title"><Activity size={16} /> Production signals</strong>
          <span className="signals-sub">
            Recurring ERROR logs from running ECS services, matched to the runs that mention them.
            {shown && <> Last {shown.windowHours}h · AWS profile {shown.awsProfile} · read {formatAge(shown.generatedAt)} ago{shown.refreshing ? ' · updating…' : ''}</>}
          </span>
        </div>
        <div className="signals-controls">
          <div className="signals-env" role="group" aria-label="Environment">
            {(['prod', 'staging'] as SignalEnv[]).map((e) => (
              <button key={e} type="button" className={`section-tab sidebar-chip ${env === e ? 'active' : ''}`} aria-pressed={env === e} onClick={() => setEnv(e)}>
                {e === 'prod' ? 'Production' : 'Staging'}
              </button>
            ))}
          </div>
          <button type="button" className="form-button" onClick={() => load(true)} disabled={loading} aria-label="Re-read CloudWatch now">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="action-center-error" role="alert">Production signals unavailable: {error}</div>}
      {loading && !shown && !error && (
        <p className="signals-loading"><Loader2 size={14} className="animate-spin" /> Reading CloudWatch… the first read can take about a minute; results are cached for 15 minutes.</p>
      )}

      {shown && (
        <>
          <ul className="signals-clusters">
            {shown.clusters.map((c) => (
              <li key={c.cluster} className={`signals-cluster ${c.status}`}>
                <b>{c.product}</b> <span>{c.cluster}</span>{' · '}
                {c.status === 'not_running' && 'no service running (desired 0), so there are no logs to read'}
                {c.status === 'error' && <>could not read: {c.error}</>}
                {c.status === 'ok' && <>{c.sourcesRead} service log{c.sourcesRead === 1 ? '' : 's'} read · {c.sourcesWithErrors} with errors{c.truncated && ' · partial read'}</>}
                {c.warnings.length > 0 && (
                  <details className="signals-warnings"><summary>{c.warnings.length} warning{c.warnings.length === 1 ? '' : 's'}</summary>
                    <ul>{c.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                  </details>
                )}
              </li>
            ))}
          </ul>

          <p className="signals-counts">
            <span className="signals-chip unowned">{shown.counts.unowned} unowned</span>
            <span className="signals-chip recurs">{shown.counts.recurs_after} recur after a closed run</span>
            <span className="signals-chip closed">{shown.counts.closed_recently ?? 0} owner closed recently</span>
            <span className="signals-chip mentioned">{shown.counts.mentioned} mentioned by an open run</span>
          </p>

          {shown.groups.length === 0 ? (
            <p className="signals-empty">
              {shown.clusters.some((c) => c.status === 'ok')
                ? `No ERROR lines in the last ${shown.windowHours}h from the services that were read.`
                : 'Nothing was read, so this is not a clean bill of health.'}
            </p>
          ) : (
            <>
              {open.length > 0 && <ul className="signals-list">{open.map((g) => <SignalRow key={g.key} g={g} res={shown} />)}</ul>}
              {mentioned.length > 0 && (
                <details className="signals-mentioned" open={open.length === 0}>
                  <summary><ChevronDown size={14} /> {mentioned.length} signal{mentioned.length === 1 ? '' : 's'} owned by an open run or one that just closed</summary>
                  <ul className="signals-list">{mentioned.map((g) => <SignalRow key={g.key} g={g} res={shown} />)}</ul>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
