import { phaseLabel } from '../../../shared/statusLabels';
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ActionKind, FlowHealthStatus, FlowInsights, FlowMover } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';
import { agentGlyph } from './agentDisplay';
import { navigateTo } from '../navigation';

// Insights "Flow": where open work is stuck (current state) and how fast work
// closes (windowed). The window only changes Throughput and Who moved work.

// Window choice persists per session so a refresh keeps it. API: days=7|14|30.
export const ANALYTICS_DAYS_KEY = 'dashboard_analytics_days';
const DAYS_OPTIONS = [7, 14, 30];
function readDays(): number {
  try {
    const v = Number(sessionStorage.getItem(ANALYTICS_DAYS_KEY));
    return DAYS_OPTIONS.includes(v) ? v : 7;
  } catch {
    return 7;
  }
}

export const FLOW_STATUS_LABEL: Record<FlowHealthStatus, string> = { ok: 'OK', warning: 'Attention', error: 'Stuck' };
const STATUS_COLOR: Record<FlowHealthStatus, string> = {
  ok: 'var(--status-success)', warning: 'var(--status-warning)', error: 'var(--status-error)',
};
const kindLabel = (kind: ActionKind) => kind.replace(/_/g, ' ');

export function FlowView() {
  const [days, setDays] = useState<number>(readDays);
  const [data, setData] = useState<FlowInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetchJson<FlowInsights>(`/api/analytics/flow?days=${days}`)
      .then((next) => { setData(next); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useDashboardRefresh(load);

  const changeDays = (d: number) => {
    setDays(d);
    try { sessionStorage.setItem(ANALYTICS_DAYS_KEY, String(d)); } catch { /* storage optional */ }
  };

  if (!data) {
    return error
      ? <div className="card flow-error" role="alert">Could not load flow insights: {error}</div>
      : <div className="view-state"><Loader2 className="animate-spin" /> Loading flow…</div>;
  }

  const { stuck, waits, health, throughput, movers } = data;
  const maxWait = Math.max(1, ...waits.map((w) => w.count));
  const maxDay = Math.max(1, ...throughput.days.map((d) => Math.max(d.opened, d.closed)));

  return (
    <div className="flow">
      <div className="flow-head">
        <div>
          <h1>Flow</h1>
          <p className="flow-sub">Where open work is stuck right now, and how fast work closes.</p>
        </div>
        {error && <span className="flow-stale" role="status">Refresh failed: {error}</span>}
      </div>

      <section className="card flow-card" aria-labelledby="flow-stuck">
        <div className="flow-card-head">
          <h2 id="flow-stuck">Stuck now</h2>
          <span className="flow-scope">current · all open runs</span>
        </div>
        <div className="flow-stats">
          <span><strong>{stuck.open}</strong> open</span>
          <span className="flow-warn" title={stuck.needsYouClosed ? `${stuck.needsYouClosed} of them on a closed run (Attention lists them too)` : undefined}><strong>{stuck.needsYou}</strong> need you{stuck.needsYouClosed > 0 && <small className="flow-scope"> ({stuck.needsYouClosed} closed)</small>}</span>
          <span><strong>{stuck.idle}</strong> idle past threshold</span>
          <span><strong>{stuck.blocked}</strong> blocked</span>
          <span>oldest wait <strong>{stuck.oldestDays ?? '—'}{stuck.oldestDays !== null ? 'd' : ''}</strong></span>
        </div>
        {/* The list itself is Attention's: each reason opens it filtered (Flow observes, Attention acts). */}
        {stuck.byKind.length > 0 ? (
          <div className="flow-chips" role="group" aria-label="Open Attention filtered by reason">
            {stuck.byKind.map(({ kind, count }) => (
              <button type="button" key={kind} className="flow-chip" onClick={() => navigateTo('command', null, 'attention', kind)}>
                {kindLabel(kind)} {count} <span aria-hidden="true">↗</span>
              </button>
            ))}
            <button type="button" className="flow-chip flow-chip-all" onClick={() => navigateTo('command', null, 'attention')}>
              Open Attention ↗
            </button>
          </div>
        ) : (
          <div className="flow-empty">Nothing is stuck.</div>
        )}
      </section>

      <div className="flow-grid">
        <section className="card flow-card" aria-labelledby="flow-waits">
          <div className="flow-card-head">
            <h2 id="flow-waits">Where it waits</h2>
            <span className="flow-scope">current · by phase</span>
          </div>
          {waits.length === 0 ? <div className="flow-empty">No open runs.</div> : (
            <div className="flow-bars">
              {waits.map((w) => (
                <div key={w.phase} className="flow-bar-row">
                  <span className="flow-bar-label" title={`phase ${w.phase}`}>{phaseLabel(w.phase)}</span>
                  <span className="flow-bar-track"><span className="flow-bar-fill" style={{ width: `${(w.count / maxWait) * 100}%` }} /></span>
                  <span className="flow-bar-value">{w.count}</span>
                  <span className="flow-bar-note">{w.oldestDays !== null ? `oldest ${w.oldestDays}d` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card flow-card" aria-labelledby="flow-health">
          <div className="flow-card-head">
            <h2 id="flow-health">Flow health</h2>
            <span className="flow-scope">current</span>
          </div>
          <div className="flow-health-score" style={{ color: STATUS_COLOR[health.status] }}>
            <span>{health.score}</span><small>/ 100</small>
            <em>{FLOW_STATUS_LABEL[health.status]}</em>
          </div>
          <ul className="flow-factors">
            {health.factors.map((f) => (
              <li key={f.label} className={f.count ? '' : 'muted'}>
                <span className="flow-factor-impact">{f.impact === 0 ? '0' : f.impact}</span>
                <span>{f.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card flow-card" aria-labelledby="flow-throughput">
        <div className="flow-card-head">
          <h2 id="flow-throughput">Throughput</h2>
          <div className="seg" role="group" aria-label="Window (days)">
            {DAYS_OPTIONS.map((d) => (
              <button key={d} type="button" className={`seg-btn ${days === d ? 'active' : ''}`}
                aria-pressed={days === d} onClick={() => changeDays(d)}>{d}d</button>
            ))}
          </div>
        </div>
        <div className="flow-stats">
          <span><strong>{throughput.closed}</strong> closed</span>
          <span><strong>{throughput.opened}</strong> opened</span>
          <span>cycle time median <strong>{throughput.cycleDays.median ?? '—'}{throughput.cycleDays.median !== null ? 'd' : ''}</strong></span>
          <span>p90 <strong>{throughput.cycleDays.p90 ?? '—'}{throughput.cycleDays.p90 !== null ? 'd' : ''}</strong></span>
          <span className="flow-scope">from {throughput.cycleDays.sample} closed runs with a start date</span>
        </div>
        <div className="flow-days" role="img"
          aria-label={`Opened and closed per day over the last ${data.windowDays} days`}>
          {throughput.days.map((d, i) => (
            <div key={d.date} className="flow-day" title={`${d.date}: opened ${d.opened}, closed ${d.closed}`}>
              <div className="flow-day-bars">
                <span className="flow-day-opened" style={{ height: `${(d.opened / maxDay) * 100}%` }} />
                <span className="flow-day-closed" style={{ height: `${(d.closed / maxDay) * 100}%` }} />
              </div>
              {/* Long windows label every 5th day (and the last) so the axis never forces the card wider. */}
              <span className="flow-day-label">
                {throughput.days.length <= 14 || i % 5 === 0 || i === throughput.days.length - 1 ? d.date.slice(5) : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flow-legend">
          <span><i className="flow-day-opened" />opened (by start date)</span>
          <span><i className="flow-day-closed" />closed (by completion date)</span>
        </div>
      </section>

      <section className="card flow-card" aria-labelledby="flow-movers">
        <div className="flow-card-head">
          <h2 id="flow-movers">Who moved work</h2>
          <span className="flow-scope">last {data.windowDays}d · phase transitions in history</span>
        </div>
        <div className="flow-movers">
          <MoverList title="Roles" movers={movers.roles} />
          <MoverList title="Conductors" movers={movers.conductors} />
        </div>
        <p className="flow-note">
          Conductor recorded on {movers.runsWithConductor} of {movers.runsWithTransitions} runs that moved in this window;
          gate updates are not counted.
        </p>
      </section>
    </div>
  );
}

function MoverList({ title, movers }: { title: string; movers: FlowMover[] }) {
  const max = Math.max(1, ...movers.map((m) => m.transitions));
  return (
    <div>
      <h3 className="flow-mover-title">{title}</h3>
      {movers.length === 0 ? <div className="flow-empty">None recorded.</div> : (
        <div className="flow-bars">
          {movers.map((m) => (
            <div key={m.actor} className="flow-bar-row">
              <span className="flow-bar-label">{agentGlyph(m.actor)} {m.actor}</span>
              <span className="flow-bar-track"><span className="flow-bar-fill" style={{ width: `${(m.transitions / max) * 100}%` }} /></span>
              <span className="flow-bar-value">{m.transitions}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
