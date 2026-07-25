import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpenCheck, FileWarning, Loader2, RefreshCw, Search } from 'lucide-react';
import type { KnowledgeReviewDetail, KnowledgeReviewsResponse } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { useDashboardRefresh } from '../../hooks/useDashboardRefresh';
import { reviewTitle } from './format';
import { ReviewListItem } from './ReviewListItem';
import { ReviewDetail } from './ReviewDetail';
import { ViewState } from './ViewState';

export function KnowledgeReviewsView() {
  const [data, setData] = useState<KnowledgeReviewsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  const listRequestRef = useRef(0);

  const loadReviews = useCallback(() => {
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(null);
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
  useDashboardRefresh(loadReviews);

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
    if (!needle) return data.reviews;
    return data.reviews.filter((review) => {
      const haystack = [
        review.reviewId,
        review.scope.product,
        review.summary,
        reviewTitle(review.reviewId, review.scope.product),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [data, query]);

  useEffect(() => {
    if (!data || filteredReviews.length === 0) return;
    if (selectedId && filteredReviews.some((review) => review.reviewId === selectedId)) return;
    setSelectedId(filteredReviews[0].reviewId);
  }, [data, filteredReviews, selectedId]);

  if (loading && !data) {
    return (
      <div className="knowledge-page">
        <div className="knowledge-page-heading"><div><h1>Knowledge Reviews</h1></div></div>
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
          <h1>Knowledge Reviews</h1>
          <p>Validated Librarian audits — read-only. Human review still required before apply.</p>
        </div>
        <div className="knowledge-page-meta">
          <div className="knowledge-stat-pill">
            <strong>{data?.total ?? 0}</strong>
            <span>valid</span>
          </div>
          {(data?.invalidCount ?? 0) > 0 && (
            <div className="knowledge-stat-pill knowledge-stat-pill-warn">
              <FileWarning size={13} />
              <strong>{data?.invalidCount}</strong>
              <span>invalid</span>
            </div>
          )}
          <button type="button" className="knowledge-refresh-button" onClick={loadReviews} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {error && data && (
        <div className="knowledge-inline-error" role="alert">
          <AlertCircle size={14} /> Refresh failed; showing the last loaded reviews. {error}
        </div>
      )}

      {!data || data.reviews.length === 0 ? (
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
            </div>
            <div className="knowledge-review-list-scroll">
              {filteredReviews.length === 0 ? (
                <div className="knowledge-list-empty">No reviews match “{query.trim()}”.</div>
              ) : (
                filteredReviews.map((review) => (
                  <ReviewListItem
                    key={review.reviewId}
                    review={review}
                    selected={review.reviewId === selectedId}
                    onSelect={setSelectedId}
                  />
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
