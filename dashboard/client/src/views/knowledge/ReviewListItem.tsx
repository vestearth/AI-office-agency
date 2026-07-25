import type { KnowledgeReviewSummary } from '../../../../shared/types';
import { formatReviewDate, humanizeLabel, reviewTitle } from './format';

export function ReviewListItem({ review, selected, onSelect }: { review: KnowledgeReviewSummary; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className={`knowledge-review-item ${selected ? 'active' : ''}`}
      onClick={() => onSelect(review.reviewId)}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="knowledge-review-item-top">
        <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
        <time dateTime={review.generatedAt}>{formatReviewDate(review.generatedAt)}</time>
      </div>
      <strong className="knowledge-review-item-title">{reviewTitle(review.reviewId, review.scope.product)}</strong>
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
