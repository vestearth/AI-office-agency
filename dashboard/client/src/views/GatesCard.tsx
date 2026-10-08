import React from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { GateView } from '../../../shared/types';
import { gateTone, safeRunUrl, type GateTone } from './gateDisplay';

const TONE_COLOR: Record<GateTone, string> = {
  resolved: 'var(--status-success)',
  na: 'var(--status-queued)',
  pending: 'var(--status-warning)',
  unresolved: 'var(--status-error)',
};

/**
 * Issue #28 Phase 2F: a task's completion gates in Monitor, with the same text as
 * `run-agent.sh status`. Read-only: no buttons; the Action Center names the
 * command when a human has to act.
 */
export function GatesCard({ view }: { view: GateView }) {
  return (
    <div className="card monitor-section-card gates-card">
      <div className="panel-heading">
        <ShieldCheck size={14} /> <span>Completion Gates</span>
        {view.readable && (
          <span className="gates-card-count">{view.summary.resolved}/{view.summary.total} resolved</span>
        )}
      </div>
      {!view.readable ? (
        <div className="gates-card-unreadable" role="alert">
          Gate state unreadable: {view.problem ?? 'unknown problem'}
        </div>
      ) : (
        <ul className="gate-list">
          {view.gates.map((gate) => {
            const color = TONE_COLOR[gateTone(gate)];
            const runUrl = safeRunUrl(gate.ran?.url);
            return (
              <li key={gate.name} className="gate-item">
                <div className="gate-row">
                  <span className="gate-name">{gate.name}</span>
                  <span className="gate-pill" style={{ color, borderColor: color }}>{gate.status}</span>
                </div>
                {gate.detail && <div className="gate-detail">{gate.detail}</div>}
                {runUrl && (
                  <a className="gate-run-link" href={runUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={11} /> open run
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
