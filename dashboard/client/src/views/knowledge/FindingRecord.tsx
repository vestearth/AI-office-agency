import { useState } from 'react';
import type { KnowledgeReviewChange, KnowledgeReviewFinding } from '../../../../shared/types';
import { humanizeLabel } from './format';

export function FindingRecord({ finding }: { finding: KnowledgeReviewFinding }) {
  return (
    <article className="knowledge-record">
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
  );
}

export function ChangeRecord({ change }: { change: KnowledgeReviewChange }) {
  return (
    <article className="knowledge-record">
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
  );
}

export function ExpandableText({ text }: { text: string }) {
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

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="knowledge-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function shortPath(value: string): string {
  const parts = value.split('/');
  if (parts.length <= 3) return value;
  return `…/${parts.slice(-3).join('/')}`;
}
