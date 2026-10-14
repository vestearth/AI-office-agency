import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardCopy, ExternalLink, Search } from 'lucide-react';
import type { KnowledgeFindingPriority, KnowledgeFindingStatus, KnowledgeOpenFindingsResponse } from '../../../../shared/types';
import { formatReviewDate, humanizeLabel, PRIORITY_ORDER } from './format';
import { buildRecheckBrief, daysSinceAudit, groupOpenFindings, STALE_RECHECK_DAYS } from './openFindings';
import { useToast } from '../../components/Toast';

const AUTO_EXPAND = 3;

export function OpenFindingsView({ data, onOpenAudit }: {
  data: KnowledgeOpenFindingsResponse;
  onOpenAudit: (reviewId: string) => void;
}) {
  const [priorities, setPriorities] = useState<Set<KnowledgeFindingPriority>>(new Set());
  const [status, setStatus] = useState<KnowledgeFindingStatus | null>(null);
  // no_change = still open but the librarian expects no vault edit (it waits on its closure criteria).
  const [edit, setEdit] = useState<'edit' | 'watch' | null>(null);
  const [staleOnly, setStaleOnly] = useState(false);
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Set<string>>(new Set());

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.items.filter((f) => (priorities.size === 0 || priorities.has(f.priority))
      && (status === null || f.status === status)
      && (edit === null || (edit === 'watch') === (f.recommendedAction === 'no_change'))
      && (!staleOnly || daysSinceAudit(f.lastReportedAt) > STALE_RECHECK_DAYS)
      && (!needle || `${f.notePath} ${f.question}`.toLowerCase().includes(needle)));
  }, [data.items, priorities, status, edit, staleOnly, query]);
  const staleCount = data.items.filter((f) => daysSinceAudit(f.lastReportedAt) > STALE_RECHECK_DAYS).length;

  // Closing happens only when a later audit re-checks a fingerprint; this hands the
  // Librarian its next batch (the current filter's worst, stalest notes).
  const copyBrief = async () => {
    try {
      await navigator.clipboard.writeText(buildRecheckBrief(items, data.totals.open));
      toast.show('Re-check brief copied — run the Librarian with it');
    } catch {
      toast.show('Clipboard not available', 'error');
    }
  };
  const groups = useMemo(() => groupOpenFindings(items), [items]);

  const counts = (key: 'priority' | 'status', value: string) => data.items.filter((f) => f[key] === value).length;
  const notes = new Set(data.items.map((f) => f.notePath)).size;
  const togglePriority = (p: KnowledgeFindingPriority) => setPriorities((current) => {
    const next = new Set(current);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  // The first few groups open by default; a click flips whichever state a group is in.
  const isOpen = (folder: string, index: number) => (index < AUTO_EXPAND) !== toggled.has(folder);
  const toggleGroup = (folder: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(folder)) next.delete(folder); else next.add(folder);
    return next;
  });

  return (
    <div className="knowledge-open">
      <div className="knowledge-open-summary">
        <span><strong>{data.totals.open}</strong> open findings in <strong>{notes}</strong> notes</span>
        {counts('priority', 'critical') > 0 && <span className="priority-critical-text"><strong>{counts('priority', 'critical')}</strong> critical</span>}
        <span><strong>{counts('priority', 'high')}</strong> high</span>
        <span className="knowledge-open-muted">{data.totals.resolved} resolved · {data.totals.suppressed} suppressed of {data.totals.fingerprints} distinct findings</span>
      </div>
      <p className="knowledge-open-caveat">
        Open = the latest audit that reported it still says new or recurring. A note fixed since then stays open until a later audit re-checks it.
      </p>

      <div className="knowledge-open-filters">
        <div className="knowledge-chip-row" role="group" aria-label="Filter by priority">
          {PRIORITY_ORDER.map((p) => (
            <button key={p} type="button" className={`knowledge-chip priority-chip-${p} ${priorities.has(p) ? 'active' : ''}`}
              aria-pressed={priorities.has(p)} onClick={() => togglePriority(p)}>
              {p} {counts('priority', p)}
            </button>
          ))}
        </div>
        <div className="knowledge-chip-row" role="group" aria-label="Filter by status">
          {(['new', 'recurring'] as const).map((s) => (
            <button key={s} type="button" className={`knowledge-chip ${status === s ? 'active' : ''}`}
              aria-pressed={status === s} onClick={() => setStatus(status === s ? null : s)}>
              {s} {counts('status', s)}
            </button>
          ))}
        </div>
        <div className="knowledge-chip-row" role="group" aria-label="Filter by recommended action">
          {([['edit', 'needs edit'], ['watch', 'no change']] as const).map(([key, label]) => (
            <button key={key} type="button" className={`knowledge-chip ${edit === key ? 'active' : ''}`}
              aria-pressed={edit === key} onClick={() => setEdit(edit === key ? null : key)}>
              {label} {data.items.filter((f) => (key === 'watch') === (f.recommendedAction === 'no_change')).length}
            </button>
          ))}
        </div>
        <button type="button" className={`knowledge-chip knowledge-chip-stale ${staleOnly ? 'active' : ''}`} aria-pressed={staleOnly}
          onClick={() => setStaleOnly(!staleOnly)}>
          not re-checked &gt;{STALE_RECHECK_DAYS}d {staleCount}
        </button>
        <label className="knowledge-search-shell knowledge-open-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by note or question" aria-label="Filter open findings" />
        </label>
        <button type="button" className="knowledge-refresh-button knowledge-brief-button" onClick={copyBrief} disabled={items.length === 0}
          title="Up to 5 notes from the current filter: worst priority first, then longest since an audit">
          <ClipboardCopy size={13} /> Copy re-check brief
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="knowledge-list-empty">No open findings match these filters.</div>
      ) : groups.map((group, index) => {
        const open = isOpen(group.folder, index);
        return (
          <section key={group.folder} className={`card knowledge-folder priority-edge-${group.maxPriority}`}>
            <button type="button" className="knowledge-folder-head" aria-expanded={open} onClick={() => toggleGroup(group.folder)}>
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <strong>{group.folder}</strong>
              <span className="knowledge-open-muted">{group.open} open</span>
              {PRIORITY_ORDER.filter((p) => group.counts[p]).map((p) => (
                <span key={p} className={`knowledge-priority priority-${p}`}>{group.counts[p]} {p}</span>
              ))}
            </button>
            {open && group.notes.map((note) => (
              <div key={note.notePath} className="knowledge-open-note">
                <div className="knowledge-open-note-head">
                  <strong title={note.notePath}>{note.name}</strong>
                  <span className="knowledge-open-muted">{note.findings.length} open</span>
                </div>
                {note.findings.map((f) => (
                  <article key={f.fingerprint} className={`knowledge-record priority-edge-${f.priority}`}>
                    <div className="knowledge-record-meta">
                      <span className={`knowledge-priority priority-${f.priority}`}>{f.priority}</span>
                      <span>{f.status}{f.timesReported > 1 ? ` ×${f.timesReported}` : ''}</span>
                      <span>evidence {humanizeLabel(f.evidenceState).toLowerCase()}</span>
                      <span>last audited {formatReviewDate(f.lastReportedAt)}</span>
                      {daysSinceAudit(f.lastReportedAt) > STALE_RECHECK_DAYS && (
                        <span className="knowledge-stale-badge">not re-checked {daysSinceAudit(f.lastReportedAt)}d</span>
                      )}
                    </div>
                    <strong className="knowledge-record-title">{f.question}</strong>
                    <div className="knowledge-open-action">
                      <span>→ {humanizeLabel(f.recommendedAction).toLowerCase()}</span>
                      <button type="button" className="knowledge-open-audit" onClick={() => onOpenAudit(f.reviewId)}>
                        open audit <ExternalLink size={12} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
