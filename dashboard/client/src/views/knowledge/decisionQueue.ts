import type { KnowledgeDecisionAnswer, KnowledgeDecisionKind, KnowledgeOpenFinding } from '../../../../shared/types';

// Knowledge › Decisions: how each kind of human-decision question is answered.
// The kind is a hint from the question text (server: classifyDecisionKind); every
// card can still be answered in words or deferred.

export const KIND_ORDER: KnowledgeDecisionKind[] = ['duplicate_proposal', 'status_check', 'approval', 'product'];

export const KIND_META: Record<KnowledgeDecisionKind, { title: string; hint: string; answers: KnowledgeDecisionAnswer[] }> = {
  duplicate_proposal: {
    title: 'Repeat a proposal?',
    hint: 'The Librarian asks whether to raise a proposal it already made. Usually the existing one is enough.',
    answers: ['existing_proposal_enough'],
  },
  status_check: {
    title: 'Is it still true?',
    hint: 'Confirm, say what changed, or hand the check to the Librarian.',
    answers: ['still_true', 'no_longer_true', 'check_it'],
  },
  approval: {
    title: 'Approve or reject',
    hint: 'Approving changes only the vault; anything outside it (a deploy, a TASK) stays yours to start.',
    answers: ['approve', 'reject'],
  },
  product: {
    title: 'Product or architecture choice',
    hint: 'Answer in words; the Librarian records your answer and proposes any vault or ADR change.',
    answers: ['answer'],
  },
};

export const ANSWER_LABEL: Record<KnowledgeDecisionAnswer, string> = {
  existing_proposal_enough: 'Existing proposal is enough',
  still_true: 'Still true',
  no_longer_true: 'No longer true…',
  check_it: 'Check it for me',
  approve: 'Approve',
  reject: 'Reject…',
  answer: 'Answer in words…',
  defer: 'Defer',
};

/** Answers that open the note box first (required for answer / no_longer_true; optional for reject). */
export const ASKS_FOR_NOTE: ReadonlySet<KnowledgeDecisionAnswer> = new Set(['no_longer_true', 'reject', 'answer']);
export const NOTE_REQUIRED: ReadonlySet<KnowledgeDecisionAnswer> = new Set(['no_longer_true', 'answer']);

export type DecisionState = 'unanswered' | 'pending' | 'deferred' | 'kept_open';

/** Where an answer stands: pending = waits for the next re-check; kept_open = a re-check ran after it and left the finding open. */
export function decisionState(f: KnowledgeOpenFinding): DecisionState {
  if (!f.humanDecision) return 'unanswered';
  if (f.humanDecision.answer === 'defer') return 'deferred';
  return f.decisionPending ? 'pending' : 'kept_open';
}

export function groupByKind(items: KnowledgeOpenFinding[]): { kind: KnowledgeDecisionKind; items: KnowledgeOpenFinding[] }[] {
  const rank = { unanswered: 0, kept_open: 1, deferred: 2, pending: 3 } as const;
  const priority = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((f) => f.needsHumanDecision && (f.decisionKind ?? 'product') === kind)
      .sort((a, b) => rank[decisionState(a)] - rank[decisionState(b)] || priority[a.priority] - priority[b.priority]
        || a.notePath.localeCompare(b.notePath)),
  })).filter((g) => g.items.length > 0);
}
