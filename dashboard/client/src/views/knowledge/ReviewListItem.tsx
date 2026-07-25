import type { KnowledgeReviewSummary } from '../../../../shared/types';
import { formatReviewDate, humanizeLabel, maxPriority, reviewRepos, reviewTitle, shouldShowProduct } from './format';

export function ReviewListItem({ review, selected, onSelect }: {
  review: KnowledgeReviewSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const title = reviewTitle(review.reviewId, review.scope.product);
  const priority = maxPriority(review.priorityCounts);
  const repos = reviewRepos(review.scope.paths);
  const criticalCount = review.priorityCounts?.critical ?? 0;
  const highCount = review.priorityCounts?.high ?? 0;

  return (
    <button
      type="button"
      className={`knowledge-review-item ${selected ? 'active' : ''} priority-edge-${priority ?? 'none'}`}
      onClick={() => onSelect(review.reviewId)}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="knowledge-review-item-top">
        <strong className="knowledge-review-item-title">{title}</strong>
        <time dateTime={review.generatedAt}>{formatReviewDate(review.generatedAt)}</time>
      </div>

      {shouldShowProduct(review.scope.product, title) && (
        <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
      )}

      {repos.length > 0 && (
        <div className="knowledge-review-repos">
          {repos.slice(0, 2).join(' · ')}
          {repos.length > 2 && <span className="knowledge-review-repos-more"> +{repos.length - 2}</span>}
        </div>
      )}

      <div className="knowledge-review-item-footer">
        {criticalCount > 0 && <span className="knowledge-review-alarm priority-critical">{criticalCount} critical</span>}
        {highCount > 0 && <span className="knowledge-review-alarm priority-high">{highCount} high</span>}
        <span>{review.findingsCount} findings</span>
        <span>{review.changesCount} changes</span>
        {review.writeMode === 'approved_scope_auto_write' && <span className="knowledge-mode-chip mode-auto">auto-write</span>}
      </div>
    </button>
  );
}
