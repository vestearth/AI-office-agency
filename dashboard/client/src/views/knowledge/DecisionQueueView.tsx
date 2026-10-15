import { useState } from 'react';
import type { KnowledgeDecisionAnswer, KnowledgeHumanDecision, KnowledgeOpenFinding, KnowledgeOpenFindingsResponse } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { useToast } from '../../components/Toast';
import { ACTOR_KEY } from '../DecisionDialog';
import { formatReviewDate } from './format';
import { ANSWER_LABEL, ASKS_FOR_NOTE, KIND_META, NOTE_REQUIRED, decisionState, groupByKind } from './decisionQueue';

// Knowledge › Decisions. Answers go to an input ledger the Friday re-check reads;
// the finding closes only when that audit records it (closure spec D4, amended 2026-10-15).

function readActor(): string {
  try { return localStorage.getItem(ACTOR_KEY) || ''; } catch { return ''; }
}
function saveActor(value: string) {
  try { localStorage.setItem(ACTOR_KEY, value); } catch { /* private window: keep it in memory */ }
}

const STATE_TEXT = {
  pending: 'waiting for the Friday re-check',
  kept_open: 'a re-check after this answer kept it open — see the latest audit',
  deferred: 'deferred',
} as const;

function AnsweredLine({ decision, state }: { decision: KnowledgeHumanDecision; state: keyof typeof STATE_TEXT }) {
  return (
    <p className={`decision-answered ${state}`}>
      <strong>{ANSWER_LABEL[decision.answer].replace('…', '')}</strong> by {decision.actor} · {formatReviewDate(decision.decidedAt)} · {STATE_TEXT[state]}
      {decision.note && <span className="decision-answered-note">“{decision.note}”</span>}
    </p>
  );
}

function DecisionCard({ f, actor, onAnswered, onOpenAudit }: {
  f: KnowledgeOpenFinding; actor: string; onAnswered: () => void; onOpenAudit: (reviewId: string) => void;
}) {
  const toast = useToast();
  const [noteFor, setNoteFor] = useState<KnowledgeDecisionAnswer | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const state = decisionState(f);
  const kind = f.decisionKind ?? 'product';

  const submit = async (answer: KnowledgeDecisionAnswer, withNote?: string) => {
    if (!actor.trim()) { toast.show('Enter who is answering first', 'error'); return; }
    setSaving(true);
    try {
      await apiFetchJson('/api/knowledge-reviews/findings/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: f.fingerprint, answer, actor: actor.trim(), ...(withNote?.trim() ? { note: withNote.trim() } : {}) }),
      });
      toast.show(answer === 'defer' ? 'Deferred' : 'Answer recorded for the Friday re-check');
      setNoteFor(null);
      setNote('');
      onAnswered();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not record the answer', 'error');
    } finally {
      setSaving(false);
    }
  };
  const choose = (answer: KnowledgeDecisionAnswer) => (ASKS_FOR_NOTE.has(answer) ? setNoteFor(answer) : void submit(answer));
  const answers: KnowledgeDecisionAnswer[] = [...KIND_META[kind].answers, ...(KIND_META[kind].answers.includes('answer') ? [] : ['answer' as const]), 'defer'];

  return (
    <li className={`decision-card ${state}`}>
      <div className="decision-card-head">
        <span className={`knowledge-priority priority-${f.priority}`}>{f.priority}</span>
        <code className="decision-note-path" title={f.notePath}>{f.notePath}</code>
        <button type="button" className="decision-audit-link" onClick={() => onOpenAudit(f.reviewId)} title="Open the latest audit that reported it">
          audited {formatReviewDate(f.lastReportedAt)} · ×{f.timesReported} · evidence {f.evidenceState}
        </button>
      </div>
      <p className="decision-question">{f.question}</p>
      {f.closureCriteria && <p className="decision-closure"><span>Closes when:</span> {f.closureCriteria}</p>}
      {f.humanDecision && state !== 'unanswered' && <AnsweredLine decision={f.humanDecision} state={state} />}
      <div className="decision-actions-row" role="group" aria-label="Answer">
        {answers.map((a) => (
          <button key={a} type="button" disabled={saving}
            className={`knowledge-chip decision-answer ${a === 'defer' ? 'decision-defer' : ''} ${noteFor === a ? 'active' : ''}`}
            onClick={() => choose(a)}>
            {ANSWER_LABEL[a]}
          </button>
        ))}
      </div>
      {noteFor && (
        <form className="decision-note-form" onSubmit={(e) => { e.preventDefault(); void submit(noteFor, note); }}>
          <label>
            <span>{noteFor === 'no_longer_true' ? 'What changed?' : noteFor === 'reject' ? 'Why (optional)' : 'Your answer'}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} autoFocus />
          </label>
          <div className="decision-note-buttons">
            <button type="submit" className="form-button" disabled={saving || (NOTE_REQUIRED.has(noteFor) && !note.trim())}>
              Record {ANSWER_LABEL[noteFor].replace('…', '').toLowerCase()}
            </button>
            <button type="button" className="form-button decision-cancel" onClick={() => { setNoteFor(null); setNote(''); }}>Cancel</button>
          </div>
        </form>
      )}
    </li>
  );
}

export function DecisionQueueView({ data, onAnswered, onOpenAudit }: {
  data: KnowledgeOpenFindingsResponse; onAnswered: () => void; onOpenAudit: (reviewId: string) => void;
}) {
  const [actor, setActor] = useState(readActor);
  const groups = groupByKind(data.items);
  const all = groups.flatMap((g) => g.items);
  const count = (s: ReturnType<typeof decisionState>) => all.filter((f) => decisionState(f) === s).length;

  return (
    <div className="decision-queue">
      <div className="decision-queue-intro">
        <p>
          <strong>{count('unanswered')}</strong> waiting for your answer · {count('pending')} answered, waiting for the Friday re-check
          {count('kept_open') > 0 && <> · {count('kept_open')} kept open by a later re-check</>}
          {count('deferred') > 0 && <> · {count('deferred')} deferred</>}
        </p>
        <p className="decision-queue-how">
          Answers are recorded to <code>knowledge-reviews/decisions/human-decisions.yaml</code>. The Friday re-check (18:02) records
          each finding as resolved and cites your answer; nothing closes here. A new answer replaces your earlier one.
        </p>
        <label className="decision-actor">
          <span>Answering as</span>
          <input value={actor} onChange={(e) => { setActor(e.target.value); saveActor(e.target.value); }} placeholder="your name" maxLength={120} />
        </label>
      </div>
      {groups.length === 0 ? (
        <p className="decision-queue-empty">No open finding needs a human decision.</p>
      ) : groups.map((g) => (
        <section key={g.kind} className="decision-group" aria-label={KIND_META[g.kind].title}>
          <h3>{KIND_META[g.kind].title} <span>{g.items.length}</span></h3>
          <p className="decision-group-hint">{KIND_META[g.kind].hint}</p>
          <ul className="decision-list">
            {g.items.map((f) => <DecisionCard key={f.fingerprint} f={f} actor={actor} onAnswered={onAnswered} onOpenAudit={onOpenAudit} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
