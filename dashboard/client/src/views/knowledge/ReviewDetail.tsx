import { CheckCircle2 } from 'lucide-react';
import type { KnowledgeReviewDetail } from '../../../../shared/types';
import { formatReviewDateTime, reviewTitle, sortFindingsByPriority } from './format';
import { ScopePaths } from './ScopePaths';
import { ChangeRecord, FindingRecord } from './FindingRecord';
import { EmptyLine } from './ViewState';

export function ReviewDetail({ review }: { review: KnowledgeReviewDetail }) {
  return (
    <div className="knowledge-detail-stack">
      <section className="card knowledge-summary-card">
        <div className="knowledge-summary-card-header">
          <div className="knowledge-detail-title-row">
            <div className="knowledge-detail-heading">
              <h2>{reviewTitle(review.reviewId, review.scope.product)}</h2>
              <code className="knowledge-review-id">{review.reviewId}</code>
            </div>
            <span className={`status-badge ${review.writeMode === 'approved_scope_auto_write' ? 'status-running' : 'status-queued'}`}>
              {review.writeMode === 'approved_scope_auto_write' ? 'auto-write approved' : 'proposal only'}
            </span>
          </div>

          <p className="knowledge-detail-meta">
            <span>{formatReviewDateTime(review.generatedAt)}</span>
            <span>{review.notesReviewedCount} notes reviewed</span>
            <span>{review.appliedChangesCount} applied</span>
          </p>
        </div>

        <p className="knowledge-summary-text">{review.summary}</p>

        <ScopePaths paths={review.scope.paths} />
      </section>

      <section className="card knowledge-section-card">
        <div className="knowledge-section-heading">
          <h3>Findings <span>{review.findings.length}</span></h3>
        </div>
        {review.findings.length === 0 ? (
          <EmptyLine label="No findings recorded." />
        ) : (
          sortFindingsByPriority(review.findings).map((finding) => (
            <FindingRecord key={finding.fingerprint} finding={finding} />
          ))
        )}
      </section>

      <section className="card knowledge-section-card">
        <div className="knowledge-section-heading">
          <h3>Changes <span>{review.changes.length}</span></h3>
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
