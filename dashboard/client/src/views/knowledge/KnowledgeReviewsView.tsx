import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpenCheck, FileWarning, Loader2, RefreshCw, Search } from 'lucide-react';
import type {
  KnowledgeFindingPriority, KnowledgeOpenFindingsResponse, KnowledgeReviewDetail, KnowledgeReviewsResponse,
} from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { PRIORITY_ORDER, reviewTitle } from './format';
import { groupAudits } from './openFindings';
import { OpenFindingsView } from './OpenFindingsView';
import { DecisionQueueView } from './DecisionQueueView';
import { decisionCounts } from '../KnowledgeDecisionsLine';
import { ReviewListItem } from './ReviewListItem';
import { ReviewDetail } from './ReviewDetail';
import { ViewState } from './ViewState';
import type { DashboardPanel } from '../types';

type KnowledgeTab = 'findings' | 'decisions' | 'audits';

function readAuditParam(): string | null {
  try { return new URLSearchParams(window.location.search).get('audit'); } catch { return null; }
}

/** ?audit=<reviewId> for the Audits tab, so a link or a refresh lands on the same audit. */
function writeAuditParam(reviewId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (reviewId) params.set('audit', reviewId); else params.delete('audit');
  const qs = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
}

export function KnowledgeReviewsView({ panel = null, onPanelChange }: {
  /** The URL's ?view= for Knowledge (App owns URL state): decisions | audits | null = findings. */
  panel?: DashboardPanel;
  onPanelChange?: (panel: DashboardPanel) => void;
} = {}) {
  const [data, setData] = useState<KnowledgeReviewsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readAuditParam());
  const [detail, setDetail] = useState<KnowledgeReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  // Controlled by the URL when App passes it; standalone (tests) falls back to local state.
  const [localTab, setLocalTab] = useState<KnowledgeTab>('findings');
  const tab: KnowledgeTab = onPanelChange ? (panel === 'decisions' || panel === 'audits' ? panel : 'findings') : localTab;
  const setTab = (next: KnowledgeTab) => (onPanelChange ? onPanelChange(next === 'findings' ? null : next) : setLocalTab(next));
  const [showInvalid, setShowInvalid] = useState(false);
  const [findings, setFindings] = useState<KnowledgeOpenFindingsResponse | null>(null);
  const [findingsError, setFindingsError] = useState<string | null>(null);
  const [auditPriority, setAuditPriority] = useState<KnowledgeFindingPriority | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const listRequestRef = useRef(0);

  const loadReviews = useCallback(() => {
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(null);
    apiFetchJson<KnowledgeOpenFindingsResponse>('/api/knowledge-reviews/findings')
      .then((response) => { if (requestId === listRequestRef.current) { setFindings(response); setFindingsError(null); } })
      .catch((err) => { if (requestId === listRequestRef.current) setFindingsError(err.message); });
    apiFetchJson<KnowledgeReviewsResponse>('/api/knowledge-reviews')
      .then((response) => {
        if (requestId !== listRequestRef.current) return;
        setData(response);
        setSelectedId((current) => current && response.reviews.some((review) => review.reviewId === current)
          ? current
          : response.reviews[0]?.reviewId ?? null);
        setRefreshVersion((current) => current + 1);
      })
      .catch((err) => {
        if (requestId === listRequestRef.current) setError(err.message);
      })
      .finally(() => {
        if (requestId === listRequestRef.current) setLoading(false);
      });
  }, []);

  useEffect(loadReviews, [loadReviews]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    apiFetchJson<KnowledgeReviewDetail>(`/api/knowledge-reviews/${encodeURIComponent(selectedId)}`)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshVersion]);

  const filteredReviews = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    const byPriority = auditPriority
      ? data.reviews.filter((review) => (review.priorityCounts?.[auditPriority] ?? 0) > 0)
      : data.reviews;
    if (!needle) return byPriority;
    return byPriority.filter((review) => {
      const haystack = [
        review.reviewId,
        review.scope.product,
        review.summary,
        reviewTitle(review.reviewId, review.scope.product),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [data, query, auditPriority]);
  const auditGroups = useMemo(() => groupAudits(filteredReviews), [filteredReviews]);

  // From an open finding: show its source audit, clearing filters that could hide it.
  const openAudit = (reviewId: string) => {
    setQuery('');
    setAuditPriority(null);
    const group = groupAudits(data?.reviews ?? []).find((g) => g.earlier.some((r) => r.reviewId === reviewId));
    if (group) setExpandedGroups((current) => new Set(current).add(group.key));
    setSelectedId(reviewId);
    setTab('audits');
  };
  // Mirror the selected audit into ?audit= while the Audits tab is open.
  useEffect(() => {
    if (tab === 'audits') writeAuditParam(selectedId);
  }, [tab, selectedId]);
  // A deep link to an earlier audit opens its group once the list has loaded.
  useEffect(() => {
    if (!data || !selectedId) return;
    const group = groupAudits(data.reviews).find((g) => g.earlier.some((r) => r.reviewId === selectedId));
    if (group) setExpandedGroups((current) => (current.has(group.key) ? current : new Set(current).add(group.key)));
  }, [data, selectedId]);
  // Keep the selected audit in view (an open-finding jump can land deep in the list).
  useEffect(() => {
    if (tab === 'audits') document.querySelector('.knowledge-review-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [tab, selectedId, expandedGroups]);
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  useEffect(() => {
    if (!data || filteredReviews.length === 0) return;
    if (selectedId && filteredReviews.some((review) => review.reviewId === selectedId)) return;
    setSelectedId(filteredReviews[0].reviewId);
  }, [data, filteredReviews, selectedId]);

  if (loading && !data) {
    return (
      <div className="knowledge-page">
        <div className="knowledge-page-heading"><div>
          <h1>Knowledge Reviews</h1>
          <p>Loading audits. After a server restart without a validation cache, every audit is re-validated first (a few seconds).</p>
        </div></div>
        <div className="knowledge-layout">
          <aside className="knowledge-review-list" aria-busy="true" aria-label="Loading knowledge reviews">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="knowledge-skeleton-row" />)}
          </aside>
          <main className="knowledge-review-detail"><div className="card knowledge-skeleton-detail" /></main>
        </div>
      </div>
    );
  }
  if (error && !data) return <ViewState icon={<AlertCircle />} title="Knowledge reviews unavailable" detail={error} error />;

  return (
    <div className="knowledge-page">
      <div className="knowledge-page-heading">
        <div>
          <h1>Knowledge</h1>
          <p>Validated Librarian audits. Findings change only when an audit records them; answer human decisions in Decisions.</p>
          <div className="workspace-tabs knowledge-tabs" role="group" aria-label="Knowledge views">
            <button type="button" className={tab === 'findings' ? 'active' : ''} aria-pressed={tab === 'findings'} onClick={() => setTab('findings')}>
              Open findings{findings ? ` ${findings.totals.open}` : ''}
            </button>
            <button type="button" className={tab === 'decisions' ? 'active' : ''} aria-pressed={tab === 'decisions'} onClick={() => setTab('decisions')}>
              Decisions{findings ? ` ${decisionCounts(findings).waiting}` : ''}
            </button>
            <button type="button" className={tab === 'audits' ? 'active' : ''} aria-pressed={tab === 'audits'} onClick={() => setTab('audits')}>
              Audits
            </button>
          </div>
        </div>
        <div className="knowledge-page-meta">
          <div className="knowledge-stat-pill">
            <strong>{data?.total ?? 0}</strong>
            <span>valid</span>
          </div>
          {(data?.invalidCount ?? 0) > 0 && (
            <button type="button" className="knowledge-stat-pill knowledge-stat-pill-warn knowledge-invalid-toggle"
              aria-expanded={showInvalid} onClick={() => setShowInvalid((v) => !v)} title="Why these audits are not counted">
              <FileWarning size={13} />
              <strong>{data?.invalidCount}</strong>
              <span>invalid</span>
            </button>
          )}
          <button type="button" className="knowledge-refresh-button" onClick={loadReviews} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {showInvalid && data && data.invalid?.length > 0 && (
        <div className="knowledge-invalid-panel" role="region" aria-label="Invalid audits">
          <p>These audit files fail the Librarian contract, so their findings are <strong>not counted</strong> anywhere on this page.
            Audits are records: rather than editing them, have the Librarian re-check those notes.</p>
          <ul>
            {data.invalid.map((item) => (
              <li key={item.file}>
                <code>knowledge-reviews/{item.file}</code>
                <ul>{item.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && data && (
        <div className="knowledge-inline-error" role="alert">
          <AlertCircle size={14} /> Refresh failed; showing the last loaded reviews. {error}
        </div>
      )}

      {tab === 'findings' || tab === 'decisions' ? (
        findings ? (tab === 'findings'
          ? <OpenFindingsView data={findings} onOpenAudit={openAudit} />
          : <DecisionQueueView data={findings} onAnswered={loadReviews} onOpenAudit={openAudit} />)
          : findingsError ? <ViewState icon={<AlertCircle />} title="Open findings unavailable" detail={findingsError} error />
          : <ViewState icon={<Loader2 className="animate-spin" />} title="Loading open findings" />
      ) : !data || data.reviews.length === 0 ? (
        <ViewState icon={<BookOpenCheck />} title="No knowledge reviews yet" detail="Validated audits will appear here after a Librarian run." />
      ) : (
        <div className="knowledge-layout">
          <aside className="knowledge-review-list" aria-label="Knowledge reviews">
            <div className="knowledge-list-toolbar">
              <label className="knowledge-search-shell">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by product, title, or id"
                  aria-label="Filter knowledge reviews"
                />
              </label>
              <span className="knowledge-list-count">
                {filteredReviews.length === data.reviews.length
                  ? `${data.reviews.length} reviews`
                  : `${filteredReviews.length} of ${data.reviews.length}`}
              </span>
              <div className="knowledge-chip-row" role="group" aria-label="Audits with a finding of priority">
                {PRIORITY_ORDER.map((p) => (
                  <button key={p} type="button" className={`knowledge-chip priority-chip-${p} ${auditPriority === p ? 'active' : ''}`}
                    aria-pressed={auditPriority === p} onClick={() => setAuditPriority(auditPriority === p ? null : p)}>{p}</button>
                ))}
              </div>
            </div>
            <div className="knowledge-review-list-scroll">
              {filteredReviews.length === 0 ? (
                <div className="knowledge-list-empty">No reviews match “{query.trim()}”.</div>
              ) : (
                auditGroups.map((group) => (
                  <div key={group.key} className="knowledge-audit-group">
                    <ReviewListItem review={group.latest} selected={group.latest.reviewId === selectedId} onSelect={setSelectedId} />
                    {group.earlier.length > 0 && (
                      <button type="button" className="knowledge-earlier-toggle" aria-expanded={expandedGroups.has(group.key)}
                        onClick={() => toggleGroup(group.key)}>
                        {expandedGroups.has(group.key) ? 'Hide' : '+'} {group.earlier.length} earlier audit{group.earlier.length === 1 ? '' : 's'} of these notes
                      </button>
                    )}
                    {expandedGroups.has(group.key) && group.earlier.map((review) => (
                      <div key={review.reviewId} className="knowledge-earlier-item">
                        <ReviewListItem review={review} selected={review.reviewId === selectedId} onSelect={setSelectedId} />
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </aside>
          <main className="knowledge-review-detail">
            {detailError ? (
              <ViewState icon={<AlertCircle />} title="Review detail unavailable" detail={detailError} error />
            ) : detailLoading || !detail ? (
              <ViewState icon={<Loader2 className="animate-spin" />} title="Loading review detail" />
            ) : (
              <ReviewDetail review={detail} />
            )}
          </main>
        </div>
      )}
    </div>
  );
}
