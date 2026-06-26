import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { DecisionAction } from '../../../shared/types';
import { apiFetch } from '../api';
import { useToast } from '../components/Toast';

// Shared in-app replacement for window.prompt() decision capture. Owns the
// POST /api/decisions/:taskId call so Command and Review share one contract:
// a note is required for every action except `approve`. Self-contained dialog —
// focuses the textarea on open, closes on Esc/backdrop, and surfaces API errors
// inline rather than only in the host view's page-level error string.
export interface DecisionDialogProps {
  taskId: string;
  action: DecisionAction;
  actionLabel: string;
  /** Display name recorded on the decision (per-view actor state). */
  actor: string;
  onCancel: () => void;
  /** Called after a successful POST so the host can reload its model. */
  onDone: () => void;
}

export const DecisionDialog: React.FC<DecisionDialogProps> = ({
  taskId, action, actionLabel, actor, onCancel, onDone,
}) => {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The element focused when the dialog opened (the decision button) — restore
  // focus to it on close so keyboard users aren't dropped at the top of the page.
  const triggerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const toast = useToast();
  const noteRequired = action !== 'approve';

  useEffect(() => {
    textareaRef.current?.focus();
    return () => { triggerRef.current?.focus?.(); };
  }, []);

  // Esc closes this dialog. stopPropagation keeps Command's task-modal Esc
  // handler from also firing while the dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = async () => {
    if (noteRequired && !note.trim()) {
      setError(`A note is required for "${actionLabel}".`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/decisions/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: action, actor: actor.trim() || undefined, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Failed to record decision (${res.status})`);
        return;
      }
      toast.show(`Decision recorded: ${action} on ${taskId}`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record decision');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={() => { if (!submitting) onCancel(); }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${actionLabel} ${taskId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <span className="dialog-title">{actionLabel}</span>
          <span className="dialog-task">{taskId}</span>
        </div>
        <div className="dialog-body">
          <label className="dialog-label" htmlFor="decision-note">
            Note{' '}
            {noteRequired
              ? <span className="dialog-required">(required)</span>
              : <span className="dialog-optional">(optional)</span>}
          </label>
          <textarea
            id="decision-note"
            ref={textareaRef}
            className="form-input dialog-textarea"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={noteRequired ? 'Explain this decision…' : 'Optional note…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="form-button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className={action === 'approve' ? 'form-button-primary' : 'form-button-danger'}
            onClick={submit}
            disabled={submitting}
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? 'Saving…' : `Confirm ${actionLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
};
