import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { ReleaseLadderTask, ReviewSummary } from '../../../shared/types';
import { navigateTo } from '../navigation';
import { loadReleaseIndex } from './ReleaseCard';
import { CommandCopy } from './CommandCopy';
import { bookkeepingGaps, type GapKind } from './bookkeeping';

const KIND_LABEL: Record<GapKind, string> = {
  no_waits_on: 'blocked, no waits_on',
  not_on_train: 'not on a release train',
};

export function BookkeepingPanel({ reviews }: { reviews: ReviewSummary[] }) {
  const [index, setIndex] = useState<Map<string, ReleaseLadderTask> | null>(null);
  useEffect(() => {
    let active = true;
    loadReleaseIndex().then((i) => { if (active) setIndex(i); }).catch(() => { /* Readiness down: the waits_on check still runs */ });
    return () => { active = false; };
  }, [reviews]);

  const gaps = bookkeepingGaps(reviews, index);
  if (gaps.length === 0) {
    return <p className="action-zero-line">Bookkeeping: every blocked task records waits_on and every staging-accepted task is on a train or has its own production gate.</p>;
  }
  return (
    <section className="action-waits bookkeeping" aria-label="Bookkeeping gaps">
      <strong><ClipboardList size={14} /> Bookkeeping</strong>
      <span className="bookkeeping-sub">{gaps.length} record{gaps.length === 1 ? '' : 's'} to keep so the dashboard can group and credit this work (not counted as needing attention)</span>
      <ul>
        {gaps.map((g) => (
          <li key={`${g.kind}|${g.taskId}`} className="bookkeeping-row">
            <span className="bookkeeping-head">
              <button type="button" className="action-waits-link" onClick={() => navigateTo('monitor', g.taskId)} title={g.title}>{g.taskId}</button>
              <span className="bookkeeping-kind">{KIND_LABEL[g.kind]}</span>
            </span>
            <span className="bookkeeping-detail">
              {g.detail}
              {g.trains.length > 0 && <> Open trains: {g.trains.map((t, i) => (
                <span key={t.id}>{i > 0 && ', '}<button type="button" className="action-waits-link" onClick={() => navigateTo('monitor', t.id)} title={t.title}>{t.id}</button></span>
              ))}.</>}
            </span>
            <CommandCopy command={g.command} label={`Copy the fix for ${g.taskId}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
