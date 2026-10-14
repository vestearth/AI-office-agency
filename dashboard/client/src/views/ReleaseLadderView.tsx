import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, ExternalLink, Loader2, Rocket } from 'lucide-react';
import type { ReleaseLadderProduct, ReleaseLadderResponse, ReleaseLadderTask, ReleaseRung } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';
import { navigateTo } from '../navigation';
import { distinctTitle } from './runTitle';
import { formatUpdated } from './monitorList';

// Insights › Readiness: the release ladder. Each cell is a completion gate as
// CompletionGuard reports it; nothing here is inferred from phase or branches.

const CELL: Record<string, { glyph: string; cls: string; title: string }> = {
  pass: { glyph: '●', cls: 'pass', title: 'pass' },
  pending: { glyph: '○', cls: 'pending', title: 'pending' },
  na: { glyph: '–', cls: 'na', title: 'not applicable' },
  absent: { glyph: '', cls: 'absent', title: 'no such gate on this task' },
};

export function ReleaseLadderView() {
  const [data, setData] = useState<ReleaseLadderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    apiFetchJson<ReleaseLadderResponse>('/api/reports/release-ladder')
      .then((next) => { setData(next); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);
  useDashboardRefresh(load);

  if (!data) {
    return error
      ? <div className="view-state" role="alert"><AlertCircle color="var(--status-error)" /> Could not load the release ladder: {error}</div>
      : <div className="view-state"><Loader2 className="animate-spin" /> Loading release ladder…</div>;
  }

  return (
    <div className="ladder">
      <div className="flow-head">
        <div>
          <h1>Readiness</h1>
          <p className="flow-sub">How far each task has been proven, from completion gates. Done is not a rung: only a passed gate counts.</p>
        </div>
        {error && <span className="flow-stale" role="status">Refresh failed: {error}</span>}
      </div>
      {data.products.map((product) => <ProductLadder key={product.id} product={product} ladder={data.ladder} />)}
    </div>
  );
}

function ProductLadder({ product, ladder }: { product: ReleaseLadderProduct; ladder: ReleaseLadderResponse['ladder'] }) {
  const [showNoGates, setShowNoGates] = useState(false);
  const [showProvable, setShowProvable] = useState(true);
  const provable = product.tasks.filter((t) => t.waitingOnProd);
  const total = product.tasks.length;

  return (
    <section className="card ladder-product" aria-labelledby={`ladder-${product.id}`}>
      <div className="flow-card-head">
        <h2 id={`ladder-${product.id}`}>{product.name} <span className="flow-scope">{product.taskPrefix === 'TASK' ? 'TASK-*' : `TASK-${product.taskPrefix}-*`}</span></h2>
        <span className="flow-scope">{total} gated task{total === 1 ? '' : 's'} · {product.counts.noGates} without gates{product.counts.unreadable ? ` · ${product.counts.unreadable} unreadable` : ''}</span>
      </div>

      {/* Rung tally: how many tasks top out at each rung. */}
      {total > 0 && <div className="ladder-tally" role="list" aria-label={`${product.name} tasks by highest proven rung`}>
        {ladder.map(({ rung, label }) => (
          <div key={rung} role="listitem" className={`ladder-tally-cell ${product.counts.byHighest[rung] ? 'has' : ''}`}>
            <strong>{product.counts.byHighest[rung]}</strong><span>{label}</span>
          </div>
        ))}
        <div role="listitem" className={`ladder-tally-cell none ${product.counts.byHighest.none ? 'has' : ''}`}>
          <strong>{product.counts.byHighest.none}</strong><span>no rung yet</span>
        </div>
      </div>}

      {product.counts.noProdGates > 0 && (
        <div className="ladder-note">
          <strong>{product.counts.noProdGates}</strong> staging-accepted task{product.counts.noProdGates === 1 ? '' : 's'} declare no production gate, so a production run proves nothing for them under the contract; add deploy_production / production_acceptance gates to make them count.
        </div>
      )}

      {provable.length > 0 && (
        <div className="ladder-provable">
          <button type="button" className="ladder-toggle" aria-expanded={showProvable} onClick={() => setShowProvable((v) => !v)}>
            {showProvable ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Rocket size={14} /> <strong>{provable.length} task{provable.length === 1 ? '' : 's'}</strong> would be proven by one production run
            <span className="flow-scope">next open rung is a prod gate</span>
          </button>
          {showProvable && (
            <ul className="ladder-provable-list">
              {provable.map((t) => {
                const next = ladder.find(({ rung }) => t.rungs[rung].status === 'pending');
                return (
                  <li key={t.id}>
                    <button type="button" className="ladder-link" onClick={() => navigateTo('monitor', t.id)}>
                      <strong>{t.id}</strong> <span>{distinctTitle(t.id, t.title) ?? ''}</span>
                    </button>
                    <span className="flow-scope">waits for {next?.label ?? 'a prod gate'}{t.rungs.deploy_production.grant === 'missing' ? ' · grant missing' : ''}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="ladder-table-wrap">
          <table className="ladder-table">
            <thead>
              <tr>
                <th>Task</th>
                {ladder.map(({ rung, label }) => <th key={rung} className="ladder-th">{label}</th>)}
                <th>Other gates</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {product.tasks.map((t) => <TaskRow key={t.id} task={t} rungs={ladder.map((l) => l.rung)} />)}
            </tbody>
          </table>
        </div>
      )}

      {product.noGates.length > 0 && (
        <div className="ladder-nogates">
          <button type="button" className="ladder-toggle" aria-expanded={showNoGates} onClick={() => setShowNoGates((v) => !v)}>
            {showNoGates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            No gates recorded · {product.noGates.length} run{product.noGates.length === 1 ? '' : 's'}
            <span className="flow-scope">before the gate contract (2026-10-07) or opened without gates — readiness unknown, not assumed</span>
          </button>
          {showNoGates && (
            <ul className="ladder-nogates-list">
              {product.noGates.map((r) => (
                <li key={r.id}>
                  <button type="button" className="ladder-link" onClick={() => navigateTo('monitor', r.id)}>
                    <strong>{r.id}</strong> <span>{distinctTitle(r.id, r.title) ?? ''}</span>
                  </button>
                  <span className={`status-badge status-${r.status}`}>{r.status}</span>
                  <span className="flow-scope">{formatUpdated(r.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function TaskRow({ task, rungs }: { task: ReleaseLadderTask; rungs: ReleaseRung[] }) {
  return (
    <tr className={task.unreadable ? 'ladder-row-unreadable' : ''}>
      <td className="ladder-task">
        <button type="button" className="ladder-link" onClick={() => navigateTo('monitor', task.id)} title={task.title}>
          <strong>{task.id}</strong> <span>{distinctTitle(task.id, task.title) ?? ''}</span>
        </button>
        {task.unreadable && <small className="ladder-unreadable"><AlertCircle size={11} /> {task.unreadable}</small>}
      </td>
      {rungs.map((rung) => {
        const cell = task.rungs[rung];
        const meta = CELL[cell.status] ?? { glyph: cell.status, cls: 'other', title: cell.status };
        const ran = cell.ran ? Object.entries(cell.ran).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
        const title = `${rung}: ${meta.title}${ran ? ` — ${ran}` : ''}${cell.grant ? ` — grant ${cell.grant}` : ''}`;
        return (
          <td key={rung} className={`ladder-cell ladder-${meta.cls}`} title={title}>
            {cell.ran?.url
              ? <a href={cell.ran.url} target="_blank" rel="noreferrer" aria-label={title}>{meta.glyph} <ExternalLink size={10} /></a>
              : <span aria-label={title}>{meta.glyph}</span>}
          </td>
        );
      })}
      <td className="ladder-extra">
        {task.extra.map((g) => (
          <span key={g.name} className={`ladder-chip ladder-chip-${g.status}`} title={`${g.name}: ${g.status}`}>{g.name.replace(/_/g, ' ')}</span>
        ))}
      </td>
      <td className="flow-scope ladder-updated">{formatUpdated(task.updatedAt)}</td>
    </tr>
  );
}
