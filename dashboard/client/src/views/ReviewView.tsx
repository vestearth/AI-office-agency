import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ClipboardCopy, ExternalLink, Inbox, Loader2 } from 'lucide-react';
import type { ActionKind, ReviewModelResponse, ReviewSummary } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';
import { useToast } from '../components/Toast';

type ActionFilter = ActionKind | 'all';

const ACTION_ORDER: ActionKind[] = [
  'awaiting_review',
  'decision_pending',
  'workflow_exception',
  'artifact_drift',
];

const ACTION_META: Record<ActionKind, { label: string; description: string; color: string }> = {
  awaiting_review: {
    label: 'Awaiting review',
    description: 'A reviewer decision is required',
    color: '#22d3ee',
  },
  decision_pending: {
    label: 'Decision pending',
    description: 'Recorded, waiting for driver reconcile',
    color: '#f59e0b',
  },
  workflow_exception: {
    label: 'Workflow exceptions',
    description: 'Blocked, failed, escalated, or off-contract',
    color: '#ef4444',
  },
  artifact_drift: {
    label: 'Artifact drift',
    description: 'Task state and review evidence disagree',
    color: '#a78bfa',
  },
};

function formatAge(value: string | null): string {
  if (!value) return 'Unknown';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function buildActionBrief(data: ReviewModelResponse, actions: ReviewSummary[]): string {
  const lines = [
    `AI Dev Office — Action Center (${actions.length}/${data.total})`,
    `Generated: ${data.generatedAt}`,
  ];

  for (const kind of ACTION_ORDER) {
    const group = actions.filter((action) => action.actionKind === kind);
    if (group.length === 0) continue;
    lines.push('', `${ACTION_META[kind].label} (${group.length})`);
    for (const action of group) {
      lines.push(
        `- ${action.taskId} | phase=${action.phase ?? 'unknown'} | ${action.actionReason ?? 'No reason recorded'} | next=${action.recommendedAction ?? 'Inspect task'}`,
      );
    }
  }

  return lines.join('\n');
}

function ActionBadge({ kind }: { kind: ActionKind }) {
  const meta = ACTION_META[kind];
  return (
    <span className="action-kind-badge" style={{ color: meta.color, borderColor: meta.color, backgroundColor: `${meta.color}1a` }}>
      {meta.label}
    </span>
  );
}

export const ReviewView: React.FC = () => {
  const [data, setData] = useState<ReviewModelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ActionFilter>('all');
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const response = await apiFetchJson<ReviewModelResponse>('/api/review');
      setData(response);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Action Center');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const run = () => { if (active) load(); };
    run();
    window.addEventListener('dashboard:refresh', run);
    return () => {
      active = false;
      window.removeEventListener('dashboard:refresh', run);
    };
  }, []);

  const actions = useMemo(
    () => data?.reviews.filter((review) => review.requiresAction && review.actionKind !== null) ?? [],
    [data],
  );
  const visibleActions = useMemo(
    () => filter === 'all' ? actions : actions.filter((action) => action.actionKind === filter),
    [actions, filter],
  );

  const copyBrief = async () => {
    if (!data || actions.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildActionBrief(data, actions));
      setCopied(true);
      toast.show('Action brief copied');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard not available');
      toast.show('Clipboard not available', 'error');
    }
  };

  if (loading) {
    return <div className="view-state" role="status"><Loader2 className="animate-spin" /> Loading Action Center…</div>;
  }
  if (!data) {
    return <div className="view-state" role="alert"><AlertCircle color="var(--status-error)" /> {error || 'No data'}</div>;
  }

  return (
    <div className="action-center">
      <div className="action-center-header">
        <div>
          <h2 className="action-center-title">
            <Inbox size={21} /> Action Center
            <span>{data.actionCount} need attention · {data.needsReviewCount} awaiting review</span>
          </h2>
          <p>Human intervention and workflow drift, derived from current task artifacts.</p>
        </div>
        <button type="button" onClick={copyBrief} disabled={actions.length === 0} className="form-button">
          <ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy action brief'}
        </button>
      </div>

      {error && <div className="action-center-error" role="alert">{error}</div>}

      <div className="action-summary-grid" aria-label="Action Center filters">
        {ACTION_ORDER.map((kind) => {
          const meta = ACTION_META[kind];
          const count = data.actionCounts[kind];
          const active = filter === kind;
          return (
            <button
              key={kind}
              type="button"
              className={`action-summary-card ${active ? 'active' : ''}`}
              aria-pressed={active}
              onClick={() => setFilter(active ? 'all' : kind)}
              style={{ '--action-color': meta.color } as React.CSSProperties}
            >
              <span className="action-summary-count">{count}</span>
              <strong>{meta.label}</strong>
              <small>{meta.description}</small>
            </button>
          );
        })}
      </div>

      <div className="action-list-heading">
        <div>
          <strong>{filter === 'all' ? 'All actions' : ACTION_META[filter].label}</strong>
          <span>{visibleActions.length} shown</span>
        </div>
        {filter !== 'all' && (
          <button type="button" className="action-clear-filter" onClick={() => setFilter('all')}>Clear filter</button>
        )}
      </div>

      {visibleActions.length === 0 ? (
        <div className="action-empty">
          <Inbox size={28} />
          <strong>{actions.length === 0 ? 'No operator action required' : 'No actions in this category'}</strong>
          <span>{actions.length === 0 ? 'The current task artifacts are aligned.' : 'Choose another category or clear the filter.'}</span>
        </div>
      ) : (
        <table className="review-table action-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Attention</th>
              <th>Why here</th>
              <th>Age</th>
              <th>Next step</th>
            </tr>
          </thead>
          <tbody>
            {visibleActions.map((action) => (
              <tr key={action.taskId}>
                <td data-label="Task">
                  <button type="button" className="action-task-link" onClick={() => navigateTo('command', action.taskId)}>
                    <strong>{action.taskId}</strong>
                    <span>{action.title}</span>
                    <small>phase: {action.phase ?? 'unknown'} · verdict: {action.verdict ?? 'none'}</small>
                  </button>
                </td>
                <td data-label="Attention">
                  {action.actionKind && <ActionBadge kind={action.actionKind} />}
                </td>
                <td data-label="Why here">
                  <span className="action-reason">{action.actionReason}</span>
                  {(action.issueCounts.error > 0 || action.issueCounts.warning > 0 || action.issueCounts.suggestion > 0) && (
                    <small className="action-findings">
                      findings: {action.issueCounts.error} error · {action.issueCounts.warning} warning · {action.issueCounts.suggestion} suggestion
                    </small>
                  )}
                </td>
                <td data-label="Age" className="action-age">{formatAge(action.statusUpdatedAt)}</td>
                <td data-label="Next step">
                  <span className="action-next-step">{action.recommendedAction}</span>
                  <button
                    type="button"
                    className="form-button action-open-button"
                    onClick={() => navigateTo('command', action.taskId)}
                    aria-label={`Open ${action.taskId} in Task Command Center`}
                  >
                    Open Command <ExternalLink size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
