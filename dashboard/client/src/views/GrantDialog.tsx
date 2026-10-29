import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AuthorizationGrantsView, AwaitingGrant, RecordedGrant } from '../../../shared/types';
import { apiFetch, apiFetchJson } from '../api';
import { useToast } from '../components/Toast';

// Issue #56: record an authorization grant without leaving the dashboard. The server
// (services/authorizationGrants.ts) decides what may be granted (an action a pending
// gate of this task waits for) and who the grant is recorded as (the office.team.yaml
// owner of this checkout's task prefix); this dialog shows both and sends the rest.

export const EXPIRY_CHOICES: ReadonlyArray<{ hours: number | null; label: string }> = [
  { hours: null, label: 'No expiry (until revoked)' },
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
];

/** One choice per action, naming every gate it would cover. */
export function grantChoices(awaiting: AwaitingGrant[]): { action: string; gates: string[] }[] {
  const byAction = new Map<string, string[]>();
  for (const { gate, action } of awaiting) byAction.set(action, [...(byAction.get(action) ?? []), gate]);
  return [...byAction].map(([action, gates]) => ({ action, gates }));
}

export interface GrantDialogProps {
  taskId: string;
  onCancel: () => void;
  /** Called after the grant is recorded so the host can reload its model. */
  onDone: () => void;
}

export const GrantDialog: React.FC<GrantDialogProps> = ({ taskId, onCancel, onDone }) => {
  const [view, setView] = useState<AuthorizationGrantsView | null>(null);
  const [action, setAction] = useState('');
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeRef = useRef<HTMLInputElement>(null);
  // Restore focus to the button that opened the dialog, as DecisionDialog does.
  const triggerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const toast = useToast();

  useEffect(() => {
    const controller = new AbortController();
    apiFetchJson<AuthorizationGrantsView>(`/api/authorizations/${taskId}`, { signal: controller.signal })
      .then((loaded) => {
        setView(loaded);
        setAction(loaded.awaiting[0]?.action ?? '');
      })
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load the gates'); });
    return () => { controller.abort(); triggerRef.current?.focus?.(); };
  }, [taskId]);

  useEffect(() => { if (view) scopeRef.current?.focus(); }, [view]);

  // Esc closes; stopPropagation keeps a host modal's Esc handler from also firing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const choices = view ? grantChoices(view.awaiting) : [];
  const grantor = view?.grantor ?? null;
  const ready = Boolean(view && !view.problem && choices.length > 0 && grantor?.actor);

  const submit = async () => {
    if (!ready) return;
    if (!scope.trim() || !reason.trim()) {
      setError('Scope and reason are both required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/authorizations/${taskId}/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, scope: scope.trim(), reason: reason.trim(), ...(hours ? { expiresInHours: hours } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Failed to record the grant (${res.status})`);
        return;
      }
      const grant = body as RecordedGrant;
      toast.show(`Grant ${grant.id} recorded on ${taskId}: ${grant.action}`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record the grant');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={() => { if (!submitting) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Record a grant for ${taskId}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">Record grant</span>
          <span className="dialog-task">{taskId}</span>
        </div>
        <div className="dialog-body">
          {!view && !error && <div className="view-state" role="status"><Loader2 size={14} className="animate-spin" /> Loading gates…</div>}
          {view?.problem && <div className="dialog-error">{view.problem}</div>}
          {view && !view.problem && choices.length === 0 && <div className="dialog-error">No gate of {taskId} waits for a grant now.</div>}
          {view && !view.problem && choices.length > 0 && (
            <>
              <label className="dialog-label" htmlFor="grant-action">Action</label>
              <select id="grant-action" className="form-input" value={action} disabled={submitting} onChange={(e) => setAction(e.target.value)}>
                {choices.map((choice) => (
                  <option key={choice.action} value={choice.action}>{choice.action} (gate {choice.gates.join(', ')})</option>
                ))}
              </select>
              <label className="dialog-label" htmlFor="grant-scope">Scope <span className="dialog-required">(required)</span></label>
              <input id="grant-scope" ref={scopeRef} className="form-input" maxLength={200} value={scope} disabled={submitting}
                onChange={(e) => setScope(e.target.value)} placeholder="What it covers, e.g. slip-api #79 staging → prod" />
              <label className="dialog-label" htmlFor="grant-reason">Reason <span className="dialog-required">(required)</span></label>
              <input id="grant-reason" className="form-input" maxLength={500} value={reason} disabled={submitting}
                onChange={(e) => setReason(e.target.value)} placeholder="Why it is approved"
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
              <label className="dialog-label" htmlFor="grant-expiry">Expires</label>
              <select id="grant-expiry" className="form-input" value={hours ?? ''} disabled={submitting}
                onChange={(e) => setHours(e.target.value ? Number(e.target.value) : null)}>
                {EXPIRY_CHOICES.map((choice) => <option key={choice.label} value={choice.hours ?? ''}>{choice.label}</option>)}
              </select>
              {grantor && (grantor.actor !== null
                ? <p className="handoff-help">Recorded as <strong>{grantor.actor}</strong> (owner of {grantor.prefix} in office.team.yaml), via dashboard.</p>
                : <div className="dialog-error">{grantor.problem}</div>)}
            </>
          )}
          {error && <div className="dialog-error" role="alert">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="form-button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="form-button-primary" onClick={submit} disabled={!ready || submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? 'Recording…' : 'Record grant'}
          </button>
        </div>
      </div>
    </div>
  );
};
