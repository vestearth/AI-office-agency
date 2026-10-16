import { useEffect, useState } from 'react';
import type { KnowledgeDecisionAnswer, KnowledgeHumanDecision, KnowledgeOpenFinding, KnowledgeOpenFindingsResponse, RunSummary } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { useToast } from '../../components/Toast';
import { ACTOR_KEY } from '../DecisionDialog';
import { formatReviewDate } from './format';
import { navigateTo } from '../../navigation';
import { ANSWER_LABEL, ASKS_FOR_NOTE, BULK_ANSWER, KIND_META, NOTE_REQUIRED, decisionState, groupByKind, refLabel, taskRefs } from './decisionQueue';

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

function DecisionCard({ f, actor, runs, onAnswered, onOpenAudit }: {
  f: KnowledgeOpenFinding; actor: string; runs: Map<string, RunSummary> | null; onAnswered: () => void; onOpenAudit: (reviewId: string) => void;
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
      {runs && taskRefs(f.question).length > 0 && (
        <p className="decision-refs" aria-label="Referenced tasks now">
          {taskRefs(f.question).map((id) => (
            <button key={id} type="button" className="decision-ref" onClick={() => navigateTo('monitor', id)} title="Open in Monitor">
              {id} · {refLabel(runs.get(id))}
            </button>
          ))}
        </p>
      )}
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
  const toast = useToast();
  // Current run states for the task ids questions mention (null until loaded or on error).
  const [runs, setRuns] = useState<Map<string, RunSummary> | null>(null);
  const [bulkKind, setBulkKind] = useState<string | null>(null);
  useEffect(() => {
    apiFetchJson<RunSummary[]>('/api/runs').then((list) => setRuns(new Map(list.map((r) => [r.id, r])))).catch(() => setRuns(null));
  }, []);
  // One answer for every unanswered question of a kind; each is still recorded on its own.
  const answerAll = async (items: KnowledgeOpenFinding[], answer: KnowledgeDecisionAnswer) => {
    if (!actor.trim()) { toast.show('Enter who is answering first', 'error'); return; }
    const open = items.filter((f) => decisionState(f) === 'unanswered');
    if (!window.confirm(`Record "${ANSWER_LABEL[answer]}" for ${open.length} unanswered question${open.length === 1 ? '' : 's'} as ${actor.trim()}?`)) return;
    setBulkKind(items[0]?.decisionKind ?? null);
    let done = 0;
    try {
      for (const f of open) {
        await apiFetchJson('/api/knowledge-reviews/findings/decisions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: f.fingerprint, answer, actor: actor.trim() }),
        });
        done++;
      }
      toast.show(`${done} answers recorded for the Friday re-check`);
    } catch (err) {
      toast.show(`${done} recorded, then: ${err instanceof Error ? err.message : 'failed'}`, 'error');
    } finally {
      setBulkKind(null);
      onAnswered();
    }
  };
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
          {BULK_ANSWER[g.kind] && g.items.some((f) => decisionState(f) === 'unanswered') && (
            <button type="button" className="form-button decision-bulk" disabled={bulkKind !== null}
              onClick={() => void answerAll(g.items, BULK_ANSWER[g.kind]!)}>
              {bulkKind === g.kind ? 'Recording…' : `Answer all ${g.items.filter((f) => decisionState(f) === 'unanswered').length} unanswered: ${ANSWER_LABEL[BULK_ANSWER[g.kind]!]}`}
            </button>
          )}
          <ul className="decision-list">
            {g.items.map((f) => <DecisionCard key={f.fingerprint} f={f} actor={actor} runs={runs} onAnswered={onAnswered} onOpenAudit={onOpenAudit} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
