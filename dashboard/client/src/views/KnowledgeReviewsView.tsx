import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpenCheck, CheckCircle2, FileWarning, Loader2, RefreshCw, Search } from 'lucide-react';
import type { KnowledgeReviewDetail, KnowledgeReviewsResponse, KnowledgeReviewSummary } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';

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
        reviewTitle(review),
      ].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [data, query]);

  useEffect(() => {
    if (!data || filteredReviews.length === 0) return;
    if (selectedId && filteredReviews.some((review) => review.reviewId === selectedId)) return;
    setSelectedId(filteredReviews[0].reviewId);
  }, [data, filteredReviews, selectedId]);

  if (loading && !data) return <ViewState icon={<Loader2 className="animate-spin" />} title="Loading knowledge reviews" />;
  if (error && !data) return <ViewState icon={<AlertCircle />} title="Knowledge reviews unavailable" detail={error} error />;

  return (
    <div className="knowledge-page">
      <div className="knowledge-page-heading">
        <div>
          <p className="knowledge-page-kicker">Knowledge base</p>
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

function ReviewListItem({ review, selected, onSelect }: { review: KnowledgeReviewSummary; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className={`knowledge-review-item ${selected ? 'active' : ''}`}
      onClick={() => onSelect(review.reviewId)}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="knowledge-review-item-top">
        <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
        <time dateTime={review.generatedAt}>{formatRelativeTime(review.generatedAt)}</time>
      </div>
      <strong className="knowledge-review-item-title">{reviewTitle(review)}</strong>
      <div className="knowledge-review-item-footer">
        <span className="knowledge-count-chip">{review.findingsCount} findings</span>
        <span className="knowledge-count-chip">{review.changesCount} changes</span>
        <span className={`knowledge-mode-chip ${review.writeMode === 'approved_scope_auto_write' ? 'mode-auto' : 'mode-proposal'}`}>
          {review.writeMode === 'approved_scope_auto_write' ? 'auto-write' : 'proposal'}
        </span>
      </div>
    </button>
  );
}

function ReviewDetail({ review }: { review: KnowledgeReviewDetail }) {
  return (
    <div className="knowledge-detail-stack">
      <section className="card knowledge-summary-card">
        <div className="knowledge-detail-title-row">
          <div className="knowledge-detail-heading">
            <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
            <h2>{reviewTitle(review)}</h2>
            <code className="knowledge-review-id">{review.reviewId}</code>
          </div>
          <span className={`status-badge ${review.writeMode === 'approved_scope_auto_write' ? 'status-running' : 'status-queued'}`}>
            {review.writeMode === 'approved_scope_auto_write' ? 'approved auto-write' : 'proposal only'}
          </span>
        </div>
        <p className="knowledge-summary-text">{review.summary}</p>
        <div className="knowledge-fact-grid">
          <Fact label="Generated" value={new Date(review.generatedAt).toLocaleString()} />
          <Fact label="Review mode" value={humanizeLabel(review.reviewMode)} />
          <Fact label="Notes reviewed" value={String(review.notesReviewedCount)} />
          <Fact label="Applied changes" value={String(review.appliedChangesCount)} />
        </div>
        {review.scope.paths.length > 0 && (
          <div className="knowledge-paths-block">
            <span className="knowledge-paths-label">Scope paths</span>
            <div className="knowledge-paths">
              {review.scope.paths.map((scopePath) => (
                <code key={scopePath} title={scopePath}>{shortPath(scopePath)}</code>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card knowledge-section-card">
        <div className="knowledge-section-heading">
          <h3>Findings</h3>
          <span>{review.findings.length}</span>
        </div>
        {review.findings.length === 0 ? (
          <EmptyLine label="No findings recorded." />
        ) : (
          review.findings.map((finding) => (
            <article key={finding.fingerprint} className="knowledge-record">
              <div className="knowledge-record-heading">
                <strong>{finding.question}</strong>
                <span className={`knowledge-priority priority-${finding.priority}`}>{finding.priority}</span>
              </div>
              <dl className="knowledge-record-facts">
                <div><dt>Status</dt><dd>{humanizeLabel(finding.status)}</dd></div>
                <div><dt>Evidence</dt><dd>{humanizeLabel(finding.evidenceState)}</dd></div>
                <div><dt>Scope</dt><dd>{humanizeLabel(finding.verificationScope)}</dd></div>
                <div><dt>Action</dt><dd>{humanizeLabel(finding.recommendedAction)}</dd></div>
              </dl>
              <code className="knowledge-note-path" title={finding.notePath}>{shortPath(finding.notePath)}</code>
              {finding.answer && <ExpandableText text={finding.answer} />}
            </article>
          ))
        )}
      </section>

      <section className="card knowledge-section-card">
        <div className="knowledge-section-heading">
          <h3>Changes</h3>
          <span>{review.changes.length}</span>
        </div>
        {review.changes.length === 0 ? (
          <EmptyLine label="No changes proposed or applied." />
        ) : (
          review.changes.map((change, index) => (
            <article key={`${change.findingFingerprint}-${index}`} className="knowledge-record">
              <div className="knowledge-record-heading">
                <strong>{change.summary}</strong>
                <span className={`status-badge ${change.disposition === 'applied' ? 'status-completed' : 'status-queued'}`}>
                  {change.disposition}
                </span>
              </div>
              <dl className="knowledge-record-facts">
                <div><dt>Target</dt><dd>{humanizeLabel(change.targetClass)}</dd></div>
                <div><dt>Action</dt><dd>{humanizeLabel(change.action)}</dd></div>
              </dl>
              <code className="knowledge-note-path" title={change.notePath}>{shortPath(change.notePath)}</code>
            </article>
          ))
        )}
      </section>

      <div className="knowledge-review-boundary">
        <CheckCircle2 size={14} /> Human review remains required; this dashboard does not apply changes.
      </div>
    </div>
  );
}

function ExpandableText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const needsClamp = text.length > 280;
  return (
    <div className="knowledge-expandable">
      <p className={!open && needsClamp ? 'is-clamped' : undefined}>{text}</p>
      {needsClamp && (
        <button type="button" className="knowledge-expand-button" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="knowledge-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <div className="knowledge-empty-line"><CheckCircle2 size={14} /> {label}</div>;
}

function ViewState({ icon, title, detail, error = false }: { icon: React.ReactNode; title: string; detail?: string; error?: boolean }) {
  return (
    <div className={`card knowledge-view-state ${error ? 'state-panel-error' : ''}`}>
      {icon}
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function reviewTitle(review: Pick<KnowledgeReviewSummary, 'reviewId' | 'scope'>): string {
  const slug = review.reviewId.replace(/^KLR-[0-9]{8}T[0-9]{6}Z-/, '');
  return humanizeLabel(slug || review.scope.product);
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortPath(value: string): string {
  const parts = value.split('/');
  if (parts.length <= 3) return value;
  return `…/${parts.slice(-3).join('/')}`;
}

function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return iso;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 14) return `${elapsedDays}d ago`;
  return new Date(iso).toLocaleDateString();
}
