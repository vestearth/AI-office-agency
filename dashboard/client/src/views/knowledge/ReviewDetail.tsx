import { CheckCircle2 } from 'lucide-react';
import type { KnowledgeReviewDetail } from '../../../../shared/types';
import { humanizeLabel, reviewTitle } from './format';
import { ScopePaths } from './ScopePaths';
import { ChangeRecord, Fact, FindingRecord } from './FindingRecord';
import { EmptyLine } from './ViewState';

export function ReviewDetail({ review }: { review: KnowledgeReviewDetail }) {
  return (
    <div className="knowledge-detail-stack">
      <section className="card knowledge-summary-card">
        <div className="knowledge-detail-title-row">
          <div className="knowledge-detail-heading">
            <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
            <h2>{reviewTitle(review.reviewId, review.scope.product)}</h2>
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
        <ScopePaths paths={review.scope.paths} />
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
            <FindingRecord key={finding.fingerprint} finding={finding} />
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
            <ChangeRecord key={`${change.findingFingerprint}-${index}`} change={change} />
          ))
        )}
      </section>

      <div className="knowledge-review-boundary">
        <CheckCircle2 size={14} /> Human review remains required; this dashboard does not apply changes.
      </div>
    </div>
  );
}
