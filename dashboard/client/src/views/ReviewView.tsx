import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, ClipboardCopy, ShieldAlert } from 'lucide-react';
import type {
  ReviewModelResponse, ReviewSummary, RiskLevel, ReviewVerdict, ConfidenceLevel,
  DecisionAction, DecisionRecord,
} from '../../../shared/types';
import { apiFetchJson, syncIdentity, type IdentityResponse } from '../api';
import { DecisionDialog } from './DecisionDialog';
import { useToast } from '../components/Toast';

const ACTOR_KEY = 'dashboard_actor';

// All colors map from contracted enums only — the UI renders signals, never guesses.
const RISK_COLOR: Record<RiskLevel, string> = {
  high: '#ef4444', medium: '#f59e0b', low: '#22c55e', none: '#6b7280',
};
const CONFIDENCE_COLOR: Record<ConfidenceLevel, string> = {
  high: '#22c55e', medium: '#f59e0b', low: '#ef4444',
};
const DECISION_COLOR: Record<DecisionAction, string> = {
  approve: '#22c55e', request_changes: '#f59e0b', escalate: '#ef4444', reject: '#ef4444',
};
const DECISION_ACTIONS: { action: DecisionAction; label: string }[] = [
  { action: 'approve', label: 'Approve' },
  { action: 'request_changes', label: 'Request changes' },
  { action: 'escalate', label: 'Escalate' },
  { action: 'reject', label: 'Reject' },
];

function verdictColor(v: ReviewVerdict | null): string {
  if (v === 'approved') return '#22c55e';
  if (v === 'changes_requested') return '#f59e0b';
  if (v === 'escalate' || v === 'infra_failure') return '#ef4444';
  return '#6b7280';
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12,
      color, border: `1px solid ${color}`, backgroundColor: `${color}1a`, whiteSpace: 'nowrap',
    }}>{text}</span>
  );
}

function riskText(r: ReviewSummary): string {
  const { error, warning, suggestion } = r.issueCounts;
  return `${r.riskLevel} (e:${error} w:${warning} s:${suggestion})`;
}

function decisionLabel(d: DecisionRecord): string {
  return `${d.decision} · ${d.actor}`;
}

function buildReport(data: ReviewModelResponse): string {
  const lines: string[] = [];
  lines.push(`AI Dev Office — Needs Review (${data.needsReviewCount}/${data.total})`);
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push('');
  for (const r of data.reviews.filter((x) => x.needsReview)) {
    lines.push(
      `[${r.taskId}] phase=${r.phase ?? '—'} verdict=${r.verdict ?? '—'} ` +
      `risk=${r.riskLevel} (err:${r.issueCounts.error} warn:${r.issueCounts.warning} sug:${r.issueCounts.suggestion}) ` +
      `confidence=${r.confidence ?? '—'}` +
      (r.latestDecision ? ` decision=${r.latestDecision.decision}(${r.latestDecision.actor})` : ''),
    );
  }
  return lines.join('\n');
}

export const ReviewView: React.FC = () => {
  const [data, setData] = useState<ReviewModelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [actor, setActor] = useState<string>(() => localStorage.getItem(ACTOR_KEY) || '');
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  // In-app decision capture (replaces window.prompt). The targeted row shows a
  // pending/disabled state while its dialog is open.
  const [decision, setDecision] = useState<{ taskId: string; action: DecisionAction; label: string } | null>(null);
  const toast = useToast();

  const load = async () => {
    try {
      const res = await apiFetchJson<ReviewModelResponse>('/api/review');
      setData(res); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load review model');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const run = () => { if (active) load(); };
    run();
    window.addEventListener('dashboard:refresh', run);
    return () => { active = false; window.removeEventListener('dashboard:refresh', run); };
  }, []);

  // Show which TASK-<PREFIX> namespace intake on this machine allocates from.
  // Passing the stored name lets the server derive/claim a prefix (multi-user
  // git mode) and report a conflict when the prefix is owned by someone else.
  useEffect(() => {
    let active = true;
    syncIdentity(localStorage.getItem(ACTOR_KEY) || '').then((id) => { if (active && id) setIdentity(id); });
    return () => { active = false; };
  }, []);

  const onActorChange = (value: string) => {
    setActor(value);
    localStorage.setItem(ACTOR_KEY, value);
  };

  const onActorCommit = async () => {
    const id = await syncIdentity(actor);
    if (id) setIdentity(id);
  };

  const openDecision = (taskId: string, action: DecisionAction) => {
    const label = DECISION_ACTIONS.find((d) => d.action === action)?.label ?? action;
    setError(null);
    setDecision({ taskId, action, label });
  };

  const copyReport = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(buildReport(data));
      setCopied(true);
      toast.show('Report copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard not available');
      toast.show('Clipboard not available', 'error');
    }
  };

  if (loading) {
    return <div className="view-state"><Loader2 className="animate-spin" /> Loading review model…</div>;
  }
  if (!data) {
    return <div className="view-state"><AlertCircle color="var(--status-error)" /> {error || 'No data'}</div>;
  }

  const queue = data.reviews.filter((r) => r.needsReview);
  const rest = data.reviews.filter((r) => !r.needsReview);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
          <ShieldAlert size={20} /> Review
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {data.needsReviewCount} need review · {data.total} total
          </span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text" placeholder="Your name (for decisions)" value={actor}
            onChange={(e) => onActorChange(e.target.value)}
            onBlur={onActorCommit}
            className="form-input"
            style={{ width: 'auto', fontSize: 13 }}
          />
          {identity?.taskPrefix && (
            <span
              title={identity.conflict
                ? `Prefix ${identity.conflict.prefix} is registered to ${identity.conflict.owner} in office.team.yaml — pick another in office.config.local.yaml`
                : 'Intake on this machine allocates TASK ids in this namespace (office.config.local.yaml)'}
              style={{ fontSize: 12, color: identity.conflict ? 'var(--status-error)' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              TASK-{identity.taskPrefix}-…{identity.conflict ? ' ⚠ taken' : ''}
            </span>
          )}
          <button type="button" onClick={copyReport} disabled={queue.length === 0} className="form-button">
            <ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy review report'}
          </button>
        </div>
      </div>

      {error && <div style={{ color: 'var(--status-error)', marginBottom: 12 }}>{error}</div>}

      <ReviewTable title={`Needs Review (${queue.length})`} rows={queue} emptyText="Nothing awaiting review."
        onDecide={openDecision} pending={decision?.taskId ?? null} />
      <div style={{ height: 20 }} />
      <ReviewTable title={`All runs (${rest.length})`} rows={rest} emptyText="No other runs." />

      {decision && (
        <DecisionDialog
          taskId={decision.taskId}
          action={decision.action}
          actionLabel={decision.label}
          actor={actor}
          onCancel={() => setDecision(null)}
          onDone={() => { setDecision(null); load(); }}
        />
      )}
    </div>
  );
};

function ReviewTable({
  title, rows, emptyText, onDecide, pending,
}: {
  title: string; rows: ReviewSummary[]; emptyText: string;
  onDecide?: (taskId: string, action: DecisionAction) => void; pending?: string | null;
}) {
  return (
    <section>
      <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '0 0 8px' }}>{title}</h3>
      {rows.length === 0 ? (
        <div className="muted-meta" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
      ) : (
        <table className="review-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
              <th style={{ padding: '6px 8px' }}>Task</th>
              <th style={{ padding: '6px 8px' }}>Phase</th>
              <th style={{ padding: '6px 8px' }}>Verdict</th>
              <th style={{ padding: '6px 8px' }}>Risk</th>
              <th style={{ padding: '6px 8px' }}>Confidence</th>
              <th style={{ padding: '6px 8px' }}>Decision</th>
              {onDecide && <th style={{ padding: '6px 8px' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.taskId} style={{ borderTop: '1px solid var(--border-color)' }}>
                <td data-label="Task" style={{ padding: '6px 8px', fontWeight: 600 }}>{r.taskId}</td>
                <td data-label="Phase" style={{ padding: '6px 8px' }}>{r.phase ?? '—'}</td>
                <td data-label="Verdict" style={{ padding: '6px 8px' }}>
                  <Badge text={r.verdict ?? '—'} color={verdictColor(r.verdict)} />
                </td>
                <td data-label="Risk" style={{ padding: '6px 8px' }}>
                  <Badge text={riskText(r)} color={RISK_COLOR[r.riskLevel]} />
                </td>
                <td data-label="Confidence" style={{ padding: '6px 8px' }}>
                  <Badge text={r.confidence ?? '—'} color={r.confidence ? CONFIDENCE_COLOR[r.confidence] : '#6b7280'} />
                </td>
                <td data-label="Decision" style={{ padding: '6px 8px' }}>
                  {r.latestDecision
                    ? <Badge text={decisionLabel(r.latestDecision)} color={DECISION_COLOR[r.latestDecision.decision]} />
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                {onDecide && (
                  <td data-label="Actions" style={{ padding: '6px 8px' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {DECISION_ACTIONS.map(({ action, label }) => (
                        <button key={action} type="button" className="form-button" disabled={pending === r.taskId}
                          onClick={() => onDecide(r.taskId, action)}
                          style={{
                            padding: '3px 8px', fontSize: 12,
                            borderColor: DECISION_COLOR[action], color: DECISION_COLOR[action],
                            background: 'transparent', cursor: pending === r.taskId ? 'wait' : 'pointer',
                          }}>{label}</button>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
