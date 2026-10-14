import React, { useEffect, useState } from 'react';
import type { DecisionAction, ReviewSummary, RunDetail } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';
import { ACTOR_KEY, DecisionDialog } from './DecisionDialog';
import { detailPlaceholder } from './detailPlaceholder';
import { distinctTitle } from './runTitle';

// Quick decision panel: the review facts, one-line next action, reviewer issues
// and the decision buttons for one run, without leaving the current view.
// Command's queue and Attention open it; the run's full detail lives in Monitor.

const DECISION_ACTIONS: { action: DecisionAction; label: string }[] = [
  { action: 'approve', label: 'Approve' }, { action: 'request_changes', label: 'Changes' },
  { action: 'escalate', label: 'Escalate' }, { action: 'reject', label: 'Reject' },
];
const RISK_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e', none: '#5b6776' };
const SEVERITY_COLOR: Record<string, string> = { error: '#ef4444', warning: '#f59e0b' };

function readActor(): string {
  try { return localStorage.getItem(ACTOR_KEY) || ''; } catch { return ''; }
}

export interface QuickDecisionPanelProps {
  review: ReviewSummary;
  /** Status chip shown first in the facts row (each host has its own vocabulary). */
  status?: { label: string; color: string };
  onClose: () => void;
  /** Called after a decision is recorded so the host reloads its model. */
  onDecided: () => void;
}

export function QuickDecisionPanel({ review, status, onClose, onDecided }: QuickDecisionPanelProps) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ action: DecisionAction; label: string } | null>(null);
  const taskId = review.taskId;

  useEffect(() => {
    let active = true;
    setDetail(null); setDetailLoading(true); setDetailError(null); setDecision(null);
    apiFetchJson<RunDetail>(`/api/runs/${taskId}`)
      .then((d) => { if (active) setDetail(d); })
      .catch((err) => { if (active) setDetailError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [taskId]);

  // Esc closes the panel, except while the decision dialog (which owns its own Esc) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !decision) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decision, onClose]);

  return (
    <>
      <div className="modal-bg" onClick={onClose}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="quick-decision-title" onClick={(e) => e.stopPropagation()}>
          <header>
            <strong className="modal-title-id" id="quick-decision-title">{taskId}</strong>
            <span className="modal-title-name">{distinctTitle(taskId, review.title)}</span>
            <button type="button" className="open-monitor" onClick={() => navigateTo('monitor', taskId)}>
              Open full detail in Monitor ↗
            </button>
            <button className="x" type="button" aria-label="Close task detail" onClick={onClose}>✕</button>
          </header>
          <div className="body">
            <div className="task-facts" aria-label="Task status summary">
              {status && <span className="task-fact" style={{ color: status.color }}>● {status.label}</span>}
              <span className="task-fact">phase: {review.phase ?? '—'}</span>
              <span className="task-fact">verdict: {review.verdict ?? '—'}</span>
              <span className="task-fact" style={{ color: RISK_COLOR[review.riskLevel] }}>
                risk: {review.riskLevel} (e{review.issueCounts.error}/w{review.issueCounts.warning}/s{review.issueCounts.suggestion})
              </span>
              <span className="task-fact">confidence: {review.confidence ?? '—'}</span>
              {review.latestDecision && (
                <span className="task-fact" style={{ color: '#22c55e' }}>decided: {review.latestDecision.decision} · {review.latestDecision.actor}</span>
              )}
            </div>
            {review.lastTransition?.reason && (
              <div className="next-line">
                <strong>Latest: {review.lastTransition.agent} · {review.lastTransition.phase}</strong>
                <span>{review.lastTransition.reason}</span>
              </div>
            )}
            {detail?.nextActionPreview ? (
              <div className="next-line"><strong>➜ Next: {detail.nextActionPreview.targetRole ?? 'no launch target'}</strong>
                <span>{detail.nextActionPreview.reason}</span></div>
            ) : detailLoading || detailError ? (
              <div className="next-line">{detailPlaceholder({ loading: detailLoading, error: detailError }, '')}</div>
            ) : null}
            {detail?.reviewIssues?.length ? (
              <div><h4>REVIEWER ISSUES ({detail.reviewIssues.length})</h4>
                <div className="tl">
                  {detail.reviewIssues.map((iss, i) => {
                    const c = SEVERITY_COLOR[iss.severity] ?? '#8a97a8';
                    return (
                      <div key={i} style={{ borderLeftColor: c }}>
                        <span style={{ color: c }}>[{iss.severity}]</span>
                        {iss.file ? <span style={{ color: '#7f8da0' }}> {iss.file}</span> : null} — {iss.description}
                      </div>);
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <footer>
            <div className="decision-context">
              <strong>Decision</strong>
              <span>Recorded to decision.yaml; status changes on driver reconcile.</span>
            </div>
            <div className="decision-actions">
              {DECISION_ACTIONS.map(({ action, label }) => (
                <button className="decision-button" data-action={action} type="button" key={action} onClick={() => setDecision({ action, label })}>{label}</button>
              ))}
            </div>
          </footer>
        </div>
      </div>

      {decision && (
        <DecisionDialog
          taskId={taskId}
          action={decision.action}
          actionLabel={decision.label}
          actor={readActor()}
          onCancel={() => setDecision(null)}
          onDone={() => { setDecision(null); onDecided(); }}
        />
      )}
    </>
  );
}
