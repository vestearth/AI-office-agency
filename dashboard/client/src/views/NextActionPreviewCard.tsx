import React from 'react';
import type { NextActionPreview } from '../../../shared/types';

// The run's recommended next step (status.yaml next_action or the phase's
// current agent). Preview only: the operator opens the app/CLI and sends it.
export function NextActionPreviewCard({ preview, onOpen }: { preview: NextActionPreview; onOpen: () => void }) {
  return (
    <section className="model-route next-action-card" aria-labelledby="next-action-heading">
      <div className="model-route-body">
        <div className="model-route-summary">
          <span style={{ color: 'var(--accent-cyan)' }}>➜</span>
          <strong id="next-action-heading">Recommended next action</strong>
          <span className="route-pill">RECOMMENDATION</span>
        </div>
        <div className="model-route-row next-action-target">
          <span>Target role</span><span className="route-value">{preview.targetRole ?? 'No launch target'}</span>
        </div>
        <div className="model-route-reason"><strong>Why</strong><span>{preview.reason}</span></div>
        <button className="preview-launch" type="button" onClick={onOpen}>Start or open task ↗</button>
        <div className="model-route-meta"><span>source: {preview.source}</span><span>Start runs after you confirm</span></div>
      </div>
    </section>
  );
}
