import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ClipboardCopy, ExternalLink, Inbox, Loader2, ScanSearch } from 'lucide-react';
import type { ActionKind, ReviewModelResponse, ReviewSummary } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';
import { distinctTitle } from './runTitle';
import { formatAge } from './formatAge';
import { useToast } from '../components/Toast';
import { QuickDecisionPanel } from './QuickDecisionPanel';
import { PROD_SIGNALS_ANCHOR, ProdSignalsPanel } from './ProdSignalsPanel';
import { CommandCopy, isShellCommand } from './CommandCopy';
import { BookkeepingPanel } from './BookkeepingPanel';
import { KnowledgeDecisionsLine } from './KnowledgeDecisionsLine';
import { WAIT_KINDS, WAIT_KIND_LABEL, isOwnRunWait } from '../../../shared/waitKinds';
import { ACTION_ORDER } from './actionOrder';
import { loadReleaseIndex } from './ReleaseCard';
import { rungProgress } from './releaseProgress';
import type { ReleaseLadderTask } from '../../../shared/types';

// Open actions grouped by status.yaml waits_on: one entry per kind (and per
// unblocking task when a ref is recorded), so one act can be seen to clear many.
export function waitGroups(actions: ReviewSummary[]): { kind: (typeof WAIT_KINDS)[number]; ref: string | null; tasks: ReviewSummary[] }[] {
  const groups = new Map<string, { kind: (typeof WAIT_KINDS)[number]; ref: string | null; tasks: ReviewSummary[] }>();
  for (const action of actions) {
    for (const wait of action.waitsOn) {
      if (isOwnRunWait(action.taskId, action.isReleaseTrain, wait)) continue;
      const key = `${wait.kind}|${wait.ref ?? ''}`;
      const group = groups.get(key) ?? { kind: wait.kind, ref: wait.ref ?? null, tasks: [] };
      if (!group.tasks.includes(action)) group.tasks.push(action);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.tasks.length - a.tasks.length
    || WAIT_KINDS.indexOf(a.kind) - WAIT_KINDS.indexOf(b.kind) || (a.ref ?? '').localeCompare(b.ref ?? ''));
}

type ActionFilter = ActionKind | 'all';

export { isShellCommand } from './CommandCopy';

// ACTION_ORDER lives in actionOrder.ts (shared with Monitor's landing).

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
    description: 'Task state disagrees with review evidence, or a newer task supersedes it',
    color: '#a78bfa',
  },
  gates_unreadable: {
    label: 'Gate unreadable',
    description: 'Completion gate state cannot be trusted',
    color: '#f43f5e',
  },
  authorization_required: {
    label: 'Authorization required',
    description: 'A gate waits for a human grant',
    color: '#fb923c',
  },
  completion_held: {
    label: 'Completion held',
    description: 'Approved; open gates hold done',
    color: '#34d399',
  },
  stale_work: {
    label: 'Stale work',
    description: 'Blocked only by finished tasks, or idle past its threshold',
    color: '#eab308',
  },
};

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

// A decision is the next step: review in place. Everything else needs the run's
// full detail (blocker, gates, evidence), which lives in Monitor.
const DECIDE_IN_PLACE: ReadonlySet<ActionKind> = new Set<ActionKind>(['awaiting_review', 'decision_pending']);

function isActionKind(value: string | null): value is ActionKind {
  return value !== null && (ACTION_ORDER as string[]).includes(value);
}

function ActionBadge({ kind }: { kind: ActionKind }) {
  const meta = ACTION_META[kind];
  return (
    <span className="action-kind-badge" style={{ color: meta.color, borderColor: meta.color, backgroundColor: `${meta.color}1a` }}>
      {meta.label}
    </span>
  );
}

export const ReviewView: React.FC<{ kind?: string | null; onKindChange?: (kind: string | null) => void }> = ({
  kind = null, onKindChange = () => {},
}) => {
  const [data, setData] = useState<ReviewModelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState<ReviewSummary | null>(null);
  // The filter lives in the URL (?kind=) so Flow's chips and shared links land filtered.
  const filter: ActionFilter = isActionKind(kind) ? kind : 'all';
  const setFilter = (next: ActionFilter) => onKindChange(next === 'all' ? null : next);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  // Reported by the Production signals panel (bottom of the page) for the line near the top.
  const [prodCounts, setProdCounts] = useState<{ unowned: number; recursAfter: number; recursAfterDuringDeploy: number } | null>(null);

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

  // Readiness per task, so a row says how far its gates got (the hand-off note can be older).
  const [ladder, setLadder] = useState<Map<string, ReleaseLadderTask> | null>(null);
  useEffect(() => {
    let active = true;
    const read = () => loadReleaseIndex().then((index) => { if (active) setLadder(index); }).catch(() => { /* rows just omit the rung */ });
    read();
    window.addEventListener('dashboard:refresh', read);
    return () => { active = false; window.removeEventListener('dashboard:refresh', read); };
  }, []);

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
        {ACTION_ORDER.filter((k) => data.actionCounts[k] > 0 || filter === k).map((kind) => {
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

      {ACTION_ORDER.some((k) => data.actionCounts[k] === 0 && filter !== k) && (
        <p className="action-zero-line">
          0 in: {ACTION_ORDER.filter((k) => data.actionCounts[k] === 0 && filter !== k).map((k) => ACTION_META[k].label.toLowerCase()).join(' · ')}
        </p>
      )}

      {waitGroups(actions).length > 0 && (
        <section className="action-waits" aria-label="What unblocks waiting work">
          <strong>What unblocks work</strong>
          <ul>
            {waitGroups(actions).map((g) => (
              <li key={`${g.kind}|${g.ref ?? ''}`}>
                <span className="action-waits-count">{g.tasks.length}</span>
                <span>wait on <b>{WAIT_KIND_LABEL[g.kind]}</b>{g.ref && <> via <button type="button" className="action-waits-link" onClick={() => navigateTo('monitor', g.ref)}>{g.ref}</button></>}</span>
                <span className="action-waits-tasks">
                  {g.tasks.map((t) => (
                    <button type="button" key={t.taskId} className="action-waits-link" onClick={() => navigateTo('monitor', t.taskId)} title={t.title}>{t.taskId}</button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prodCounts && prodCounts.unowned + prodCounts.recursAfter > 0 && (
        <p className="knowledge-decisions-line prod-signals-line">
          <Activity size={14} />
          <span>
            {prodCounts.unowned > 0 && <><strong>{prodCounts.unowned}</strong> production error{prodCounts.unowned === 1 ? '' : 's'} no run owns</>}
            {prodCounts.unowned > 0 && prodCounts.recursAfter > 0 && ' · '}
            {prodCounts.recursAfter > 0 && <><strong>{prodCounts.recursAfter}</strong> still failing after a run closed{prodCounts.recursAfterDuringDeploy > 0 ? ` (${prodCounts.recursAfterDuringDeploy === prodCounts.recursAfter ? 'all' : prodCounts.recursAfterDuringDeploy} during deploys)` : ''}</>}
          </span>
          <button type="button" className="action-waits-link"
            onClick={() => document.getElementById(PROD_SIGNALS_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            See Production signals ↓
          </button>
        </p>
      )}
      <KnowledgeDecisionsLine />

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
              <th>Latest update</th>
              <th>Age</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleActions.map((action) => (
              <tr key={action.taskId}>
                <td data-label="Task">
                  <button type="button" className="action-task-link" title="Open full detail in Monitor" onClick={() => navigateTo('monitor', action.taskId)}>
                    <strong>{action.taskId}</strong>
                    {distinctTitle(action.taskId, action.title) && <span>{distinctTitle(action.taskId, action.title)}</span>}
                    <small>phase <code className="phase-code">{action.phase ?? 'unknown'}</code> · verdict: {action.verdict ?? 'none'}</small>
                  </button>
                </td>
                <td data-label="Attention">
                  {action.actionKind && <ActionBadge kind={action.actionKind} />}
                </td>
                <td data-label="Latest update">
                  {action.actionKind && DECIDE_IN_PLACE.has(action.actionKind) && action.lastTransition?.reason ? (
                    <>
                      <small className="action-latest-who">
                        {action.lastTransition.agent} · {action.lastTransition.phase}
                      </small>
                      <span className="action-reason" title={action.lastTransition.reason}>{action.lastTransition.reason}</span>
                    </>
                  ) : (
                    <span className="action-reason" title={action.actionReason ?? undefined}>{action.actionReason}</span>
                  )}
                  {ladder?.get(action.taskId) && (
                    <small className="action-rung" title="Highest passed completion gate, and the next one pending">{rungProgress(ladder.get(action.taskId)!)}</small>
                  )}
                  {(action.issueCounts.error > 0 || action.issueCounts.warning > 0 || action.issueCounts.suggestion > 0) && (
                    <small className="action-findings">
                      findings: {action.issueCounts.error} error · {action.issueCounts.warning} warning · {action.issueCounts.suggestion} suggestion
                    </small>
                  )}
                </td>
                <td data-label="Age" className="action-age">
                  {formatAge(action.statusUpdatedAt)}
                  {action.idle && (
                    <small
                      className="action-age-stale"
                      title={`No status.yaml change for ${action.idle.days} days; ${action.phase ?? 'this phase'} is stale after ${action.idle.thresholdDays}.`}
                    >
                      stale &gt;{action.idle.thresholdDays}d
                    </small>
                  )}
                </td>
                <td data-label="Action">
                  {action.recommendedAction && isShellCommand(action.recommendedAction) ? (
                    <CommandCopy command={action.recommendedAction} label={`Copy the command for ${action.taskId}`} />
                  ) : (
                    <span className="action-next-step">{action.recommendedAction}</span>
                  )}
                  {action.actionKind && DECIDE_IN_PLACE.has(action.actionKind) ? (
                    <button type="button" className="form-button action-open-button action-decide-button"
                      onClick={() => setDeciding(action)} aria-label={`Review and decide ${action.taskId}`}>
                      <ScanSearch size={13} /> Review &amp; decide
                    </button>
                  ) : (
                    <button type="button" className="form-button action-open-button"
                      onClick={() => navigateTo('monitor', action.taskId)} aria-label={`Open ${action.taskId} in Monitor`}>
                      Open in Monitor <ExternalLink size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Bookkeeping is not attention: it sits under the inbox, above the signal details. */}
      <BookkeepingPanel reviews={data.reviews} />

      <ProdSignalsPanel onProdCounts={setProdCounts} />

      {deciding && (
        <QuickDecisionPanel
          review={deciding}
          status={deciding.actionKind ? { label: ACTION_META[deciding.actionKind].label, color: ACTION_META[deciding.actionKind].color } : undefined}
          onClose={() => setDeciding(null)}
          onDecided={() => { setDeciding(null); load(); }}
        />
      )}
    </div>
  );
};
