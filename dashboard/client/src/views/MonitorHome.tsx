import React from 'react';
import { Clock, Inbox } from 'lucide-react';
import type { ReviewSummary, RunSummary } from '../../../shared/types';
import { countRuns } from '../../../shared/runCounts';
import { statusLabel } from '../../../shared/statusLabels';
import { navigateTo } from '../navigation';
import { agentGlyph } from './agentDisplay';
import { formatAge } from './formatAge';
import { formatUpdated } from './monitorList';
import { distinctTitle } from './runTitle';
import { idleLabel, monitorHome } from './monitorDetail';

// Monitor with no run selected: a launcher into recent work and what waits on a
// human. Attention stays the full inbox; this shows at most five of each.
export function MonitorHome({ runs, reviews, onSelectRun }: {
  runs: RunSummary[];
  reviews: Map<string, ReviewSummary>;
  onSelectRun: (id: string) => void;
}) {
  const counts = countRuns(runs);
  const idle = runs.filter((run) => reviews.get(run.id)?.idle).length;
  const { recent, waiting, waitingTotal } = monitorHome(runs, reviews);

  return (
    <div className="monitor-home">
      <div className="monitor-home-head">
        <div className="flow-stats">
          <span><strong>{counts.active}</strong> open</span>
          <span className="flow-warn"><strong>{waitingTotal}</strong> need you</span>
          <span><strong>{idle}</strong> idle</span>
          <span><strong>{counts.completed}</strong> done</span>
        </div>
        <button type="button" className="monitor-home-link" onClick={() => navigateTo('analytics')}>Open Flow ↗</button>
      </div>

      <div className="monitor-home-grid">
        <section className="card monitor-section-card">
          <div className="panel-heading"><Clock size={14} /> <span>Recently updated</span></div>
          {recent.length === 0 ? <div className="muted-meta">No runs yet.</div> : (
            <ul className="monitor-home-list">
              {recent.map((run) => (
                <li key={run.id}>
                  <button type="button" className="monitor-home-row" onClick={() => onSelectRun(run.id)}>
                    <strong>{run.id}</strong>
                    <span className="monitor-home-title">{distinctTitle(run.id, run.title) ?? ''}</span>
                    <span className={`status-badge status-${run.status}`}>{statusLabel(run.status)}</span>
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
          {waiting.length === 0 ? <div className="muted-meta">Nothing waits on a human.</div> : (
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
