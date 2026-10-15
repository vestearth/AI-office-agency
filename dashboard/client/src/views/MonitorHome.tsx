import React from 'react';
import { Clock, Inbox } from 'lucide-react';
import type { ReviewSummary, RunSummary } from '../../../shared/types';
import { countRuns } from '../../../shared/runCounts';
import { runStatusClass, runStatusLabel } from '../../../shared/statusLabels';
import { navigateTo } from '../navigation';
import { agentGlyph } from './agentDisplay';
import { formatAge } from './formatAge';
import { formatUpdated } from './monitorList';
import { distinctTitle } from './runTitle';
import { idleLabel, monitorHome } from './monitorDetail';

// Monitor with no run selected: a launcher into recent work and what waits on a
// human. Attention stays the full inbox; this shows at most five of each.
export function MonitorHome({ runs, reviews, onSelectRun, loading = false }: {
  runs: RunSummary[];
  reviews: Map<string, ReviewSummary>;
  onSelectRun: (id: string) => void;
  /** First load in flight: show placeholders, never the empty states ("No runs yet"). */
  loading?: boolean;
}) {
  const counts = countRuns(runs);
  // /api/review answers for every run; an empty model next to known runs means it failed to load.
  const reviewsUnavailable = !loading && runs.length > 0 && reviews.size === 0;
  const n = (value: number) => (loading ? '…' : value);
  const idle = runs.filter((run) => reviews.get(run.id)?.idle).length;
  const { recent, waiting, waitingTotal } = monitorHome(runs, reviews);

  return (
    <div className="monitor-home">
      <div className="monitor-home-head">
        <div className="flow-stats">
          <span><strong>{n(counts.active)}</strong> open</span>
          <span className="flow-warn"><strong>{reviewsUnavailable ? '?' : n(waitingTotal)}</strong> need you</span>
          <span><strong>{reviewsUnavailable ? '?' : n(idle)}</strong> idle</span>
          <span><strong>{n(counts.completed)}</strong> done</span>
        </div>
        <button type="button" className="monitor-home-link" onClick={() => navigateTo('analytics')}>Open Flow ↗</button>
      </div>

      <div className="monitor-home-grid">
        <section className="card monitor-section-card">
          <div className="panel-heading"><Clock size={14} /> <span>Recently updated</span></div>
          {loading ? <div className="muted-meta">Loading runs…</div> : recent.length === 0 ? <div className="muted-meta">No runs yet.</div> : (
            <ul className="monitor-home-list">
              {recent.map((run) => (
                <li key={run.id}>
                  <button type="button" className="monitor-home-row" onClick={() => onSelectRun(run.id)}>
                    <strong>{run.id}</strong>
                    <span className="monitor-home-title">{distinctTitle(run.id, run.title) ?? ''}</span>
                    <span className={`status-badge ${runStatusClass(run.status, run.currentStep)}`}>{runStatusLabel(run.status, run.currentStep)}</span>
                    <span className="monitor-home-meta">
                      {run.currentAgent && run.currentAgent !== 'unknown' ? `${agentGlyph(run.currentAgent)} ${run.currentAgent} · ` : ''}{formatUpdated(run.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card monitor-section-card">
          <div className="panel-heading">
            <Inbox size={14} /> <span>Waiting on you</span>
            {waitingTotal > waiting.length && (
              <button type="button" className="monitor-home-link monitor-heading-note" onClick={() => navigateTo('command', null, 'attention')}>
                all {waitingTotal} in Attention ↗
              </button>
            )}
          </div>
          {loading ? <div className="muted-meta">Loading…</div>
            : reviewsUnavailable ? <div className="muted-meta">The review model did not load, so what waits on you is unknown. Refresh, or open Attention.</div>
            : waiting.length === 0 ? <div className="muted-meta">Nothing waits on a human.</div> : (
            <ul className="monitor-home-list">
              {waiting.map(({ run, review }) => (
                <li key={run.id}>
                  <button type="button" className="monitor-home-row" title={review.actionReason ?? undefined} onClick={() => onSelectRun(run.id)}>
                    <strong>{run.id}</strong>
                    <span className="monitor-home-title">{distinctTitle(run.id, run.title) ?? ''}</span>
                    <span className="monitor-home-kind">{review.actionKind?.replace(/_/g, ' ')}</span>
                    <span className="monitor-home-meta">
                      {idleLabel(review) ?? formatAge(review.statusUpdatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
