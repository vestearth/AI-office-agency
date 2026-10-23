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
    const controller = new AbortController();
    loadReleaseIndex(controller.signal)
      .then((i) => { if (active && !controller.signal.aborted) setIndex(i); })
      .catch(() => { /* Readiness down: the waits_on check still runs */ });
    return () => { active = false; controller.abort(); };
  }, [reviews]);

  const gaps = bookkeepingGaps(reviews, index);
  if (gaps.length === 0) {
    return <p className="action-zero-line">Bookkeeping: every blocked task records waits_on and every staging-accepted task is on a train or has its own production gate.</p>;
  }
  const kinds = (Object.keys(KIND_LABEL) as GapKind[]).filter((k) => gaps.some((g) => g.kind === k));
  return (
    <section className="action-waits bookkeeping" aria-label="Bookkeeping gaps">
      <strong><ClipboardList size={14} /> Bookkeeping</strong>
      <span className="bookkeeping-sub">{gaps.length} record{gaps.length === 1 ? '' : 's'} to keep so the dashboard can group and credit this work (not counted as needing attention)</span>
      {kinds.map((kind) => {
        const rows = gaps.filter((g) => g.kind === kind);
        return (
          <div key={kind} className="bookkeeping-kind-block">
            <p className="bookkeeping-detail"><b>{rows.length} {KIND_LABEL[kind]}</b> — {rows[0]!.detail}
              {rows[0]!.trains.length > 0 && <> Open trains: {rows[0]!.trains.map((t, i) => (
                <span key={t.id}>{i > 0 && ', '}<button type="button" className="action-waits-link" onClick={() => navigateTo('monitor', t.id)} title={t.title}>{t.id}</button></span>
              ))}.</>}
            </p>
            <ul>
              {rows.map((g) => (
                <li key={`${g.kind}|${g.taskId}`} className="bookkeeping-row">
                  <button type="button" className="action-waits-link bookkeeping-task" onClick={() => navigateTo('monitor', g.taskId)} title={g.title}>{g.taskId}</button>
                  <CommandCopy command={g.command} label={`Copy the fix for ${g.taskId}`} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
