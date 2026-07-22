import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, BookOpenCheck, CheckCircle2, FileWarning, Loader2, RefreshCw } from 'lucide-react';
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

  if (loading && !data) return <ViewState icon={<Loader2 className="animate-spin" />} title="Loading knowledge reviews" />;
  if (error && !data) return <ViewState icon={<AlertCircle />} title="Knowledge reviews unavailable" detail={error} error />;

  return (
    <div>
      <div className="knowledge-page-heading">
        <div>
          <h1>Knowledge Reviews</h1>
          <p>Read-only visibility into validated Knowledge Librarian audit artifacts.</p>
        </div>
        <div className="knowledge-page-meta">
          <strong>{data?.total ?? 0}</strong> valid reviews
          {(data?.invalidCount ?? 0) > 0 && <span><FileWarning size={13} /> {data?.invalidCount} invalid</span>}
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
            {data.reviews.map((review) => (
              <ReviewListItem key={review.reviewId} review={review} selected={review.reviewId === selectedId} onSelect={setSelectedId} />
            ))}
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
    <button type="button" className={`knowledge-review-item ${selected ? 'active' : ''}`} onClick={() => onSelect(review.reviewId)} aria-current={selected ? 'true' : undefined}>
      <span className="knowledge-review-product">{review.scope.product}</span>
      <strong>{review.reviewId.replace(/^KLR-[0-9]{8}T[0-9]{6}Z-/, '')}</strong>
      <span>{new Date(review.generatedAt).toLocaleString()}</span>
      <span className="knowledge-review-counts">
        {review.findingsCount} {review.findingsCount === 1 ? 'finding' : 'findings'} · {review.changesCount} {review.changesCount === 1 ? 'change' : 'changes'}
      </span>
    </button>
  );
}

function ReviewDetail({ review }: { review: KnowledgeReviewDetail }) {
  return (
    <div className="knowledge-detail-stack">
      <section className="card knowledge-summary-card">
        <div className="knowledge-detail-title-row">
          <div>
            <span className="knowledge-review-product">{review.scope.product}</span>
            <h2>{review.reviewId}</h2>
          </div>
          <span className={`status-badge ${review.writeMode === 'approved_scope_auto_write' ? 'status-running' : 'status-queued'}`}>
            {review.writeMode === 'approved_scope_auto_write' ? 'approved auto-write' : 'proposal only'}
          </span>
        </div>
        <p>{review.summary}</p>
        <div className="knowledge-fact-grid">
          <Fact label="Generated" value={new Date(review.generatedAt).toLocaleString()} />
          <Fact label="Review mode" value={review.reviewMode.replace('_', ' ')} />
          <Fact label="Notes reviewed" value={String(review.notesReviewedCount)} />
          <Fact label="Applied changes" value={String(review.appliedChangesCount)} />
        </div>
        <div className="knowledge-paths">
          {review.scope.paths.map((scopePath) => <code key={scopePath}>{scopePath}</code>)}
        </div>
      </section>

      <section className="card">
        <div className="knowledge-section-heading"><h3>Findings</h3><span>{review.findings.length}</span></div>
        {review.findings.length === 0 ? <EmptyLine label="No findings recorded." /> : review.findings.map((finding) => (
          <article key={finding.fingerprint} className="knowledge-record">
            <div className="knowledge-record-heading">
              <strong>{finding.question}</strong>
              <span className={`knowledge-priority priority-${finding.priority}`}>{finding.priority}</span>
            </div>
            <div className="knowledge-record-meta">
              <span>{finding.status}</span><span>{finding.evidenceState}</span><span>{finding.verificationScope}</span><span>{finding.recommendedAction}</span>
            </div>
            <code>{finding.notePath}</code>
            {finding.answer && <p>{finding.answer}</p>}
          </article>
        ))}
      </section>

      <section className="card">
        <div className="knowledge-section-heading"><h3>Changes</h3><span>{review.changes.length}</span></div>
        {review.changes.length === 0 ? <EmptyLine label="No changes proposed or applied." /> : review.changes.map((change, index) => (
          <article key={`${change.findingFingerprint}-${index}`} className="knowledge-record">
            <div className="knowledge-record-heading">
              <strong>{change.summary}</strong>
              <span className={`status-badge ${change.disposition === 'applied' ? 'status-completed' : 'status-queued'}`}>{change.disposition}</span>
            </div>
            <div className="knowledge-record-meta"><span>{change.targetClass}</span><span>{change.action}</span></div>
            <code>{change.notePath}</code>
          </article>
        ))}
      </section>

      <div className="knowledge-review-boundary"><CheckCircle2 size={14} /> Human review remains required; this dashboard does not apply changes.</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function EmptyLine({ label }: { label: string }) {
  return <div className="knowledge-empty-line"><CheckCircle2 size={14} /> {label}</div>;
}

function ViewState({ icon, title, detail, error = false }: { icon: React.ReactNode; title: string; detail?: string; error?: boolean }) {
  return <div className={`card knowledge-view-state ${error ? 'state-panel-error' : ''}`}>{icon}<strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}
