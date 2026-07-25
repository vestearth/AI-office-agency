import { useState } from 'react';
import type { KnowledgeReviewChange, KnowledgeReviewFinding } from '../../../../shared/types';
import { humanizeLabel } from './format';

export function FindingRecord({ finding }: { finding: KnowledgeReviewFinding }) {
  return (
    <article className={`knowledge-record priority-edge-${finding.priority}`}>
      <strong className="knowledge-record-title">{finding.question}</strong>
      <div className="knowledge-record-meta">
        <span className={`knowledge-priority priority-${finding.priority}`}>{finding.priority}</span>
        <span>{humanizeLabel(finding.status)}</span>
        <span>evidence {humanizeLabel(finding.evidenceState).toLowerCase()}</span>
        <span>{humanizeLabel(finding.verificationScope).toLowerCase()} scope</span>
        <span>{humanizeLabel(finding.recommendedAction).toLowerCase()}</span>
      </div>
      {finding.answer && <ExpandableText text={finding.answer} />}
      <code className="knowledge-note-path" title={finding.notePath}>{finding.notePath}</code>
    </article>
  );
}

export function ChangeRecord({ change }: { change: KnowledgeReviewChange }) {
  return (
    <article className={`knowledge-record ${change.disposition === 'applied' ? 'change-applied' : ''}`}>
      <strong className="knowledge-record-title">{change.summary}</strong>
      <div className="knowledge-record-meta">
        <span className={`status-badge ${change.disposition === 'applied' ? 'status-completed' : 'status-queued'}`}>
          {change.disposition}
        </span>
        <span>{humanizeLabel(change.targetClass)}</span>
        <span>{humanizeLabel(change.action).toLowerCase()}</span>
      </div>
      <code className="knowledge-note-path" title={change.notePath}>{change.notePath}</code>
    </article>
  );
}

export function ExpandableText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const needsClamp = text.length > 420;
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
