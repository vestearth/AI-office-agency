import type { TaskChainView } from '../../../shared/types';
import { chainHeadline, chainStepLine, chainTone, pairingLineShort } from './chain';

/**
 * A role chain's timeline (D7, D12) in the Launch card and the Run panel: each step with
 * its role, CLI, model, status, verification result and the dashboard's commit, then why
 * the chain stopped. Stop ends the chain: it cancels a waiting step and stops a running one.
 */
export function ChainTimeline({ chain, busy, onStop }: { chain: TaskChainView; busy?: boolean; onStop?: () => void }) {
  return (
    <div className={`launch-status chain-timeline ${chainTone(chain)}`}>
      <div className="launch-status-head">
        <strong role="status">{chainHeadline(chain)}</strong>
        <span className="flow-scope" title={chain.id}>{pairingLineShort(chain.pairing)}</span>
        {chain.active && onStop && <button type="button" className="form-button-danger" disabled={busy} onClick={onStop}>Stop chain</button>}
      </div>
      <ol className="chain-steps">
        {chain.steps.map((s) => (
          <li key={s.n} className={`chain-step chain-${s.status.replace(' ', '-')}`} title={s.launchId ?? s.itemId}>
            {chainStepLine(s)}
            {s.commits.length > 0 && <span className="flow-scope"> · {s.commits.map((c) => `${c.branch} ${c.sha.slice(0, 10)}`).join(', ')}</span>}
          </li>
        ))}
      </ol>
      {chain.ended && (
        <p className={chain.ended.kind === 'done' ? 'handoff-help' : 'dialog-error'} role="status">
          Stopped: {chain.ended.reason}
        </p>
      )}
    </div>
  );
}
