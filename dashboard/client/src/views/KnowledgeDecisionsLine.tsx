import { useEffect, useState } from 'react';
import { BookOpenCheck } from 'lucide-react';
import type { KnowledgeOpenFindingsResponse } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { navigateTo } from '../navigation';

// Attention is the one inbox for acting, so it points at the knowledge findings only a
// human can close. They are not runs, so they stay out of "need attention".

export function decisionCounts(data: KnowledgeOpenFindingsResponse): { waiting: number; pending: number } {
  const human = data.items.filter((f) => f.needsHumanDecision);
  return {
    waiting: human.filter((f) => !f.humanDecision || (!f.decisionPending && f.humanDecision.answer !== 'defer')).length,
    pending: human.filter((f) => f.decisionPending).length,
  };
}

export function KnowledgeDecisionsLine() {
  const [counts, setCounts] = useState<{ waiting: number; pending: number } | null>(null);
  useEffect(() => {
    let active = true;
    apiFetchJson<KnowledgeOpenFindingsResponse>('/api/knowledge-reviews/findings')
      .then((d) => { if (active) setCounts(decisionCounts(d)); })
      .catch(() => { /* Knowledge unavailable: say nothing rather than "0" */ });
    return () => { active = false; };
  }, []);
  if (!counts || (counts.waiting === 0 && counts.pending === 0)) return null;
  return (
    <p className="knowledge-decisions-line">
      <BookOpenCheck size={14} />
      <span>
        <strong>{counts.waiting}</strong> knowledge finding{counts.waiting === 1 ? '' : 's'} wait for your decision
        {counts.pending > 0 && <> · {counts.pending} answered, waiting for the Friday re-check</>}
      </span>
      <button type="button" className="action-waits-link" onClick={() => navigateTo('knowledge', null, 'decisions')}>Answer in Knowledge › Decisions ↗</button>
    </p>
  );
}
