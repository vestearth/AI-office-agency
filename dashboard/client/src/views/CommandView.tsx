import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReviewModelResponse, ReviewSummary, RunSummary, AgentName,
  FlowDay, FlowInsights, WatcherUpdate,
  TimelineActor,
} from '../../../shared/types';
import { apiFetchJson, syncIdentity, type IdentityResponse } from '../api';
import { formatLiveLogStamp } from './commandLogTime';
import { sparkPolylinePoints } from './spark';
import { AGENT_EMOJI, agentGlyph, ROLE_NAMES, OPERATOR_NAMES } from './agentDisplay';
import { ACTOR_KEY } from './DecisionDialog';
import { QuickDecisionPanel } from './QuickDecisionPanel';
import { ActorDialog } from './ActorDialog';
import { navigateTo } from '../navigation';
import { distinctTitle } from './runTitle';
import { countRuns, isActiveStatus } from '../../../shared/runCounts';
import {
  OFFICE_ASPECT, PHASE_TO_ZONE, ZONES, ZONE_BY_ID, ZONE_COLORS, summarizeZones, zoneNeedsEye, zonePreview, zoneTone,
} from './commandZones';
import { formatAge } from './formatAge';
import { isAssignedOnly, runStatusLabel } from '../../../shared/statusLabels';

// "Command Center": an AI-generated isometric office (public/office-bg.webp) as a
// live map with phase-zone status pins, data-lit rooms + animated flow lines, plus a data-rich
// sidebar (queue, agents) and bottom panels (health, live logs, workflow chart),
// all driven by the existing API contracts.

// AGENT_EMOJI now lives in ./agentDisplay (shared with MonitorView, operator-aware).
const C = ZONE_COLORS;
const WORKSTREAM_LABELS: Record<NonNullable<RunSummary['workstream']>, string> = {
  frontend: 'FE',
  backend: 'BE',
  devops: 'DO',
  framework: 'FW',
  docs: 'DOC',
  general: 'GEN',
};

interface Task extends ReviewSummary {
  title: string;
  status: RunSummary['status'];
  updatedAt?: string;
  currentAgent?: AgentName;
  currentConductor?: TimelineActor;
  workstream?: RunSummary['workstream'];
}
interface Flow { id: number; from: string; to: string; }
interface LogLine { id: number; time: string; text: string; color: string; }
type Filter = 'actionable' | 'needs' | 'running' | 'failed' | 'done' | 'unreadable' | 'all';

// Queue ordering: a human should see what needs action first; finished work sinks.
function priority(t: { status: RunSummary['status']; needsReview: boolean }): number {
  if (t.status === 'failed') return 0;       // validation failed
  if (t.needsReview) return 1;
  if (t.status === 'running' || t.status === 'waiting_review') return 2;
  if (t.status === 'blocked') return 3;
  if (t.status === 'queued') return 4;
  if (t.status === 'cancelled') return 5;    // aborted
  return 6;                                   // completed / unknown
}

const STYLE = `
.cc { display: grid; grid-template-columns: minmax(360px, 430px) minmax(0, 1fr); grid-template-areas: 'side main'; gap: 12px; height: 100%; padding: 12px;
  background: #0a0e14; color: #c9d4e3; font-family: ui-monospace, 'SF Mono', monospace; overflow: hidden; }
.cc-main { grid-area: main; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cc-top { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.cc-map { position: relative; flex: 1; border: 1px solid #1e2733; border-radius: 6px; overflow: hidden;
  background: #020204; min-height: 220px; container-type: size; display: grid; place-items: center; }
/* The stage is the image's own box (contain-fit), so % positions land on the same room at any window size. */
.stage { position: relative; width: min(100cqw, calc(100cqh * 1672 / 941)); }
.office { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; user-select: none; }
.rooms { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.room { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; transition: opacity 0.6s, background 0.6s; }
.room.dim { background: radial-gradient(closest-side, rgba(2,3,7,0.7), rgba(2,3,7,0.48) 55%, transparent); }
.room.rest { background: radial-gradient(closest-side, rgba(2,3,7,0.34), rgba(2,3,7,0.2) 55%, transparent); }
.room.lit { mix-blend-mode: screen;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--tone) 34%, transparent), color-mix(in srgb, var(--tone) 12%, transparent) 60%, transparent); }
.room.breathe { animation: breathe 2.6s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.55; } }
.flow { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; }
.flowpath { fill: none; stroke: #22d3ee; stroke-width: 2; vector-effect: non-scaling-stroke;
  stroke-dasharray: 4 5; animation: dash 0.5s linear infinite; filter: drop-shadow(0 0 3px #22d3ee); opacity: 0.9; }
@keyframes dash { to { stroke-dashoffset: -9; } }
.pin-wrap { position: absolute; z-index: 5; transform: translate(-50%, -50%); }
.pin-wrap:hover, .pin-wrap:focus-within { z-index: 8; }
.pin { display: flex; align-items: center; gap: 5px;
  background: rgba(6,10,16,0.94); border: 1px solid #38465a; border-radius: 12px; padding: 4px 8px;
  color: inherit; font: inherit; font-size: 10px; white-space: nowrap; cursor: pointer; backdrop-filter: blur(3px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.55); transition: box-shadow 0.15s, border-color 0.15s, transform 0.1s; }
.pin:hover { border-color: #22d3ee; transform: scale(1.07);
  box-shadow: 0 0 16px 2px rgba(34,211,238,0.6), 0 2px 8px rgba(0,0,0,0.6); }
.pin:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
.pin.sel { outline: 1px solid #22d3ee; }
.pin.terminal { font-size: 9px; padding: 3px 7px; background: rgba(6,10,16,0.8); border-color: #2a3442; color: #8a97a8; }
.dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 6px currentColor; flex: none; }
.pin .cnt { color: #8a97a8; }
.pin .age { color: #6b7888; }
.pulse { animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 12px 3px currentColor; opacity: 0.7; } }
.zone-tip { display: none; position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%);
  width: 290px; padding: 6px; background: rgba(8,13,20,0.97); border: 1px solid #2a3a4c; border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0,0,0,0.7); backdrop-filter: blur(4px); font-size: 10px; }
.zone-tip::before { content: ''; position: absolute; left: 0; right: 0; top: -10px; height: 10px; }
.pin-wrap:hover .zone-tip, .pin-wrap:focus-within .zone-tip { display: block; }
.pin-wrap.up .zone-tip { top: auto; bottom: calc(100% + 8px); }
.pin-wrap.up .zone-tip::before { top: auto; bottom: -10px; }
.pin-wrap.right .zone-tip { left: auto; right: 0; transform: none; }
.tip-head { display: flex; align-items: center; gap: 6px; padding: 3px 5px 6px; color: #7f8da0; border-bottom: 1px solid #1a2432; margin-bottom: 3px; }
.tip-head strong { color: #e6edf5; }
.tip-row, .tip-more { width: 100%; display: flex; align-items: center; gap: 7px; padding: 5px; border: 0; border-radius: 4px;
  background: transparent; color: #c9d4e3; font: inherit; font-size: 10px; text-align: left; cursor: pointer; }
.tip-row:hover, .tip-more:hover, .tip-row:focus-visible, .tip-more:focus-visible { background: #12202d; outline: none; }
.tip-row strong { color: #e6edf5; flex: none; }
.tip-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa8b8; }
.tip-age { flex: none; color: #6b7888; }
.tip-more { color: #7dd3fc; justify-content: center; }
.legend { position: absolute; left: 8px; bottom: 8px; z-index: 6; display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: calc(100% - 16px);
  padding: 5px 9px; background: rgba(5,8,13,0.82); border: 1px solid #1e2733; border-radius: 6px; font-size: 9px; color: #7f8da0; pointer-events: none; }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { width: 6px; height: 6px; border-radius: 50%; }
.legend-note { color: #566475; }
@media (prefers-reduced-motion: reduce) {
  .pulse, .room.breathe, .flowpath { animation: none; }
}
.panel { background: #0d131b; border: 1px solid #1e2733; border-radius: 6px; display: flex; flex-direction: column; min-height: 0; }
.panel h3 { margin: 0; padding: 8px 10px; font-size: 11px; letter-spacing: 1px; color: #7f8da0;
  border-bottom: 1px solid #1e2733; display: flex; align-items: center; gap: 6px; }
.chips { display: flex; gap: 4px; padding: 6px 8px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 10px; padding: 2px 7px; border-radius: 10px; border: 1px solid #243; cursor: pointer; background: #0f1620; color: #8a97a8; }
.chip.on { color: #06121a; font-weight: 700; }
.queue { overflow: auto; flex: 1; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border-bottom: 1px solid #141b24; font-size: 11px; }
.row:hover { background: #101a25; }
.row.sel { background: #11212e; }
.row-main { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 7px 6px 7px 10px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
.row-main:focus-visible { outline: 2px solid #22d3ee; outline-offset: -2px; }
.badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.row-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.open-mon { margin-right: 6px; cursor: pointer; color: #5b6776; font: inherit; font-size: 12px; line-height: 1; padding: 5px 6px; border: 0; background: transparent; border-radius: 3px; flex: none; }
.open-mon:hover { color: #22d3ee; }
.open-mon:focus-visible { outline: 2px solid #22d3ee; outline-offset: 1px; color: #22d3ee; }
.queue-filter-clear { margin-left: 6px; padding: 0 3px; border: 0; background: transparent; color: #7dd3fc; cursor: pointer; font: inherit; }
.queue-filter-clear:focus-visible { outline: 2px solid #22d3ee; outline-offset: 1px; }
.cc-side { grid-area: side; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.agents { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; }
.ag { display: flex; align-items: center; gap: 4px; font-size: 11px; background: #0f1620; border: 1px solid #1e2733; border-radius: 12px; padding: 3px 8px; }
.dec button { font: inherit; font-size: 10px; padding: 3px 7px; margin: 2px; cursor: pointer; border: 1px solid #2a3744; background: #16212e; color: #c9d4e3; border-radius: 4px; }
.cc-bottom { display: grid; grid-template-columns: 1.1fr 1.5fr 1fr; gap: 10px; height: 150px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 10px; overflow: auto; }
.stat { background: #0f1620; border: 1px solid #1a2330; border-radius: 4px; padding: 5px 7px; }
.stat .v { font-size: 15px; font-weight: 700; }
.stat .k { font-size: 9px; color: #6b7888; letter-spacing: 0.5px; }
.logs { overflow: auto; flex: 1; padding: 4px 8px; font-size: 10px; line-height: 1.7; }
.logs .lg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spark { padding: 8px 10px; flex: 1; display: flex; flex-direction: column; }
@media (max-width: 900px) {
  .cc { display: flex; flex-direction: column; overflow-y: auto; }
  .cc-main { order: 1; flex: none; margin-top: 12px; }
  .cc-map { flex: none; min-height: 360px; }
  .cc-bottom { grid-template-columns: 1fr 1fr; height: auto; }
  .cc-bottom .panel { min-height: 140px; }
  .cc-side { order: 0; flex: none; display: grid; grid-template-rows: min(52vh, 420px) auto auto; min-height: 0; }
  .cc-side .panel { flex: none !important; }
  .cc-side .panel:first-child { height: auto; min-height: 280px; }
}
@media (max-width: 640px) {
  .cc { padding: 8px; gap: 8px; }
  .cc-top { flex-wrap: wrap; }
  .cc-map { min-height: 320px; }
  .cc-bottom { grid-template-columns: 1fr; }
  .pin { font-size: 9px; padding: 3px 6px; }
  .row { gap: 5px; padding: 6px 8px; }
}
`;

// Label from the shared vocabulary; color still says what needs a human
// (amber = a decision is due), the "needs decision" badge names it.
function statusOf(t: Task): { label: string; color: string } {
  const label = runStatusLabel(t.status, t.phase);
  if (t.needsReview) return { label, color: C.amber };
  if (isAssignedOnly(t.status, t.phase)) return { label, color: C.gray };
  switch (t.status) {
    case 'running': return { label, color: C.green };
    case 'waiting_review': return { label, color: C.cyan };
    case 'failed': return { label, color: C.red };
    case 'blocked': return { label, color: C.amber };
    default: return { label, color: C.gray };
  }
}
function hhmmss(iso?: string): string {
  return formatLiveLogStamp(iso, 'time');
}
function pathTail(p: string): string {
  const m = p.match(/(TASK-?[A-Za-z0-9_-]+[\/\\][^\/\\]+)$/);
  return m ? m[1].replace(/\\/g, '/') : p.split(/[\/\\]/).slice(-2).join('/');
}

export const CommandView: React.FC<{ selectedTaskId?: string | null }> = ({ selectedTaskId = null }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [flow, setFlow] = useState<FlowInsights | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('actionable');
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [actor, setActor] = useState(() => localStorage.getItem(ACTOR_KEY) || '');
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  // In-app actor editor (replaces window.prompt for "Your name").
  const [actorEditing, setActorEditing] = useState(false);
  const prevZone = useRef<Map<string, string>>(new Map());

  const selectTask = (taskId: string | null) => {
    setSelected(taskId);
    navigateTo('command', taskId, 'operations');
  };

  // App owns URL state; this makes ?tab=command&run=<TASK_ID> open the same
  // evidence modal used by the Command queue.
  useEffect(() => {
    setSelected(selectedTaskId);
  }, [selectedTaskId]);

  // Surface this machine's intake namespace (TASK-<PREFIX>-NNN); the server
  // derives/claims a prefix from the name (multi-user git mode) and reports
  // a conflict when the configured prefix belongs to someone else.
  useEffect(() => {
    let active = true;
    syncIdentity(localStorage.getItem(ACTOR_KEY) || '').then((id) => { if (active && id) setIdentity(id); });
    return () => { active = false; };
  }, []);
  const seq = useRef(0);

  const load = async (detail?: WatcherUpdate) => {
    try {
      const [review, runs, an] = await Promise.all([
        apiFetchJson<ReviewModelResponse>('/api/review'),
        apiFetchJson<RunSummary[]>('/api/runs'),
        apiFetchJson<FlowInsights>('/api/analytics/flow').catch(() => null),
      ]);
      const runById = new Map(runs.map((r) => [r.id, r]));
      const next: Task[] = review.reviews.map((rv) => ({
        ...rv, title: runById.get(rv.taskId)?.title || rv.taskId,
        status: runById.get(rv.taskId)?.status || 'unknown',
        updatedAt: runById.get(rv.taskId)?.updatedAt,
        currentAgent: runById.get(rv.taskId)?.currentAgent,
        currentConductor: runById.get(rv.taskId)?.currentConductor,
        workstream: runById.get(rv.taskId)?.workstream || 'general',
      }));

      // Diff zones → spawn transient flow lines for tasks that changed phase.
      const nextZone = new Map<string, string>();
      const newFlows: Flow[] = [];
      for (const t of next) {
        const z = (t.phase && PHASE_TO_ZONE.get(t.phase)) || '';
        if (z) nextZone.set(t.taskId, z);
        const was = prevZone.current.get(t.taskId);
        if (was && z && was !== z && ZONE_BY_ID.has(was) && ZONE_BY_ID.has(z)) {
          newFlows.push({ id: ++seq.current, from: was, to: z });
        }
      }
      prevZone.current = nextZone;
      if (newFlows.length) {
        setFlows((f) => [...f, ...newFlows]);
        const ids = new Set(newFlows.map((f) => f.id));
        setTimeout(() => setFlows((f) => f.filter((x) => !ids.has(x.id))), 4500);
      }

      // Live logs: real SSE file events when present; else seed from recent runs.
      if (detail && Array.isArray(detail.paths) && detail.paths.length) {
        const lines: LogLine[] = detail.paths.slice(0, 6).map((p, i) => ({
          id: ++seq.current + i, time: hhmmss(detail.timestamp),
          text: `● ${detail.events?.[0] ?? 'change'}  ${pathTail(p)}`, color: C.cyan,
        }));
        setLogs((l) => [...lines.reverse(), ...l].slice(0, 40));
      } else {
        setLogs((prevLogs) => {
          if (prevLogs.length) return prevLogs;
          return [...next]
            .filter((t) => t.updatedAt)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
            .slice(0, 10)
            .map((t) => ({
              id: ++seq.current, time: formatLiveLogStamp(t.updatedAt, 'date'),
              // A finished run's current_agent is "done", which the scanner reports as unknown.
              text: `${agentGlyph(t.phase === 'done' ? 'done' : t.currentAgent)} ${t.taskId} → ${t.phase ?? '—'}${t.currentConductor ? `  ·  ${agentGlyph(t.currentConductor)} ${t.currentConductor}` : ''}`,
              color: statusOf(t).color,
            }));
        });
      }

      setTasks(next); setFlow(an); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    let active = true;
    const onRefresh = (e: Event) => { if (active) load((e as CustomEvent).detail as WatcherUpdate | undefined); };
    load();
    window.addEventListener('dashboard:refresh', onRefresh);
    return () => { active = false; window.removeEventListener('dashboard:refresh', onRefresh); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoneStats = useMemo(() => summarizeZones(tasks), [tasks]);

  const agentStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.currentAgent && t.currentAgent !== 'unknown' && t.status !== 'completed' && t.status !== 'cancelled') {
        m.set(t.currentAgent, (m.get(t.currentAgent) || 0) + 1);
      }
    }
    return m;
  }, [tasks]);

  // Conductors active = tasks grouped by derived currentConductor (the operator
  // running each task). Distinct from agentStats (role/current_agent).
  const conductorStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.currentConductor && t.status !== 'completed' && t.status !== 'cancelled') {
        m.set(t.currentConductor, (m.get(t.currentConductor) || 0) + 1);
      }
    }
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    let list = tasks;
    if (zoneFilter) list = list.filter((t) => (t.phase && PHASE_TO_ZONE.get(t.phase)) === zoneFilter);
    if (filter === 'actionable') list = list.filter((t) => isActiveStatus(t.status));
    else if (filter === 'needs') list = list.filter((t) => t.needsReview);
    else if (filter === 'running') list = list.filter((t) => t.status === 'running' || t.status === 'waiting_review');
    else if (filter === 'failed') list = list.filter((t) => t.status === 'failed');
    else if (filter === 'done') list = list.filter((t) => t.status === 'completed');
    else if (filter === 'unreadable') list = list.filter((t) => t.status === 'unknown');
    // Always order actionable-first; Done/aborted sink to the bottom.
    return [...list].sort((a, b) => priority(a) - priority(b) || b.taskId.localeCompare(a.taskId));
  }, [tasks, filter, zoneFilter]);

  // Counts come from the shared definition so Command and Insights agree.
  // Unreadable runs (status 'unknown') are neither actionable nor done.
  const runCounts = useMemo(() => countRuns(tasks), [tasks]);
  const needs = useMemo(() => tasks.filter((t) => t.needsReview).length, [tasks]);

  // Zone pin toggle, shared by click + keyboard. Selecting a zone focuses it
  // (show everything in it); clicking the active zone clears back to actionable.
  const toggleZone = (id: string) => {
    if (zoneFilter === id) { setZoneFilter(null); setFilter('actionable'); }
    else { setZoneFilter(id); setFilter('all'); }
  };

  const openActorEditor = () => setActorEditing(true);
  const saveActor = (name: string) => {
    setActor(name);
    localStorage.setItem(ACTOR_KEY, name);
    syncIdentity(name).then((id) => { if (id) setIdentity(id); });
    setActorEditing(false);
  };

  if (loading) return <div className="view-state">Loading command center…</div>;
  const selTask = tasks.find((t) => t.taskId === selected) || null;
  const health = flow?.health;
  const CHIPS: { id: Filter; label: string; color: string }[] = [
    { id: 'actionable', label: `Actionable ${runCounts.active}`, color: C.cyan },
    { id: 'needs', label: `Review ${needs}`, color: C.amber },
    { id: 'failed', label: `Validation ${runCounts.failed}`, color: C.red },
    { id: 'done', label: `Done ${runCounts.completed}`, color: C.gray },
    ...(runCounts.unreadable > 0
      ? [{ id: 'unreadable' as const, label: `Unreadable ${runCounts.unreadable}`, color: C.red }]
      : []),
    { id: 'all', label: `All ${runCounts.total}`, color: '#8a97a8' },
  ];

  return (
    <div className="cc">
      <style>{STYLE}</style>

      <div className="cc-main">
        <div className="cc-top">
          <strong style={{ color: '#e6edf5', letterSpacing: 1 }}>◢ AI WORKFORCE COMMAND CENTER</strong>
          <span className="dot pulse" style={{ color: C.green, background: C.green }} />
          <span style={{ color: '#5b6776' }}>live</span>
          <button
            onClick={openActorEditor}
            title={identity?.conflict
              ? `Prefix ${identity.conflict.prefix} is registered to ${identity.conflict.owner} in office.team.yaml`
              : 'Set your name for decisions'}
            style={{ marginLeft: 'auto', font: 'inherit', fontSize: 11, padding: '4px 9px', cursor: 'pointer',
              background: '#0d131b', color: actor ? '#c9d4e3' : '#5b6776',
              border: `1px solid ${identity?.conflict ? '#ef4444' : '#1e2733'}`, borderRadius: 14 }}>
            👤 {actor || 'set name'}{identity?.taskPrefix ? ` · ${identity.taskPrefix}${identity.conflict ? ' ⚠' : ''}` : ''}
          </button>
          {error && <span style={{ color: C.red }}>{error}</span>}
        </div>

        <div className="cc-map">
          <div className="stage" style={{ aspectRatio: `${OFFICE_ASPECT}` }}>
            <img className="office" src="/office-bg.webp" alt="" draggable={false} />
            {/* Rooms light up in their zone's tone when they hold open work; empty
                rooms (and finished ones) dim so the art never out-shouts the data. */}
            <div className="rooms" aria-hidden="true">
              {ZONES.map((z) => {
                const st = zoneStats.get(z.id) || { count: 0, attention: false, active: false };
                const state = !st.count ? 'dim' : z.kind === 'terminal' ? 'rest' : 'lit';
                return (
                  <span key={z.id} className={`room ${state} ${zoneNeedsEye(z, st) ? 'breathe' : ''}`}
                    style={{ left: `${z.room.x}%`, top: `${z.room.y}%`, width: `${z.room.w}%`, height: `${z.room.h}%`,
                      ['--tone' as string]: zoneTone(z, st) }} />
                );
              })}
            </div>
            <svg className="flow" viewBox="0 0 100 100" preserveAspectRatio="none">
              {flows.map((f) => {
                const a = ZONE_BY_ID.get(f.from)!, b = ZONE_BY_ID.get(f.to)!;
                return <path key={f.id} className="flowpath" d={`M ${a.left} ${a.top} L ${b.left} ${b.top}`} />;
              })}
            </svg>
            {ZONES.map((z) => {
              const st = zoneStats.get(z.id) || { count: 0, attention: false, active: false, tasks: [] };
              // Empty zones keep their pin (count 0, dimmed) so the map always shows every room.
              const hasTasks = st.count > 0;
              const color = zoneTone(z, st);
              const age = hasTasks && z.kind !== 'terminal' && st.oldest ? formatAge(st.oldest) : null;
              const preview = zonePreview(z, st.tasks);
              const tipId = `zone-tip-${z.id}`;
              return (
                <div key={z.id} className={`pin-wrap ${z.left > 72 ? 'right' : ''} ${z.top > 58 ? 'up' : ''}`}
                  style={{ left: `${z.left}%`, top: `${z.top}%` }}>
                  <button type="button" className={`pin ${zoneFilter === z.id ? 'sel' : ''} ${z.kind === 'terminal' ? 'terminal' : ''}`}
                    aria-pressed={zoneFilter === z.id}
                    aria-describedby={hasTasks ? tipId : undefined}
                    style={{ opacity: hasTasks ? 1 : 0.68 }}
                    onClick={() => toggleZone(z.id)}
                    title={hasTasks ? undefined : `${z.label}: 0 tasks`}>
                    <span className={`dot ${zoneNeedsEye(z, st) ? 'pulse' : ''}`} style={{ color, background: color }} />
                    {z.agent && <span>{AGENT_EMOJI[z.agent]}</span>}
                    <span>{z.label}</span><span className="cnt">{st.count}</span>
                    {age && <span className="age">· {age}</span>}
                  </button>
                  {hasTasks && (
                    <div className="zone-tip" id={tipId} role="tooltip">
                      <div className="tip-head">
                        <span className="dot" style={{ color, background: color }} />
                        <strong>{z.label}</strong>
                        <span>{st.count} task{st.count === 1 ? '' : 's'}{age ? ` · stalest ${age}` : ''}</span>
                      </div>
                      {preview.map((t) => (
                        <button type="button" key={t.taskId} className="tip-row" onClick={() => selectTask(t.taskId)}>
                          <strong>{t.taskId.replace(/^TASK-?/, '#')}</strong>
                          <span className="tip-title">{distinctTitle(t.taskId, t.title) ?? ''}</span>
                          <span className="tip-age">{t.updatedAt ? formatAge(t.updatedAt) : ''}</span>
                        </button>
                      ))}
                      {st.count > preview.length && (
                        <button type="button" className="tip-more" onClick={() => toggleZone(z.id)}>
                          {zoneFilter === z.id ? 'Clear zone filter' : `+${st.count - preview.length} more · show in queue`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="legend" aria-label="Map legend">
            <span><i style={{ background: C.amber }} />needs you</span>
            <span><i style={{ background: C.cyan }} />agent on it</span>
            <span><i style={{ background: C.green }} />queued</span>
            <span><i style={{ background: C.red }} />failed</span>
            <span><i style={{ background: C.gray }} />empty · finished</span>
            <span className="legend-note">· age = stalest update</span>
          </div>
        </div>

        <div className="cc-bottom">
          <div className="panel">
            <h3>♥ SYSTEM HEALTH {health && <span title={health.factors.filter((f) => f.count).map((f) => `${f.impact} ${f.detail}`).join('\n') || 'No deductions'}
              style={{ marginLeft: 'auto', color: health.status === 'ok' ? C.green : health.status === 'warning' ? C.amber : C.red }}>{health.score}</span>}</h3>
            <div className="stats">
              <div className="stat"><div className="v" style={{ color: C.green }}>{`${Math.round(runCounts.successRate * 100)}%`}</div><div className="k">SUCCESS</div></div>
              <div className="stat"><div className="v" style={{ color: C.red }}>{runCounts.failed}</div><div className="k">FAILED</div></div>
              <div className="stat"><div className="v" style={{ color: C.amber }}>{runCounts.blocked}</div><div className="k">BLOCKED</div></div>
              <div className="stat"><div className="v" style={{ color: C.cyan }}>{runCounts.active}</div><div className="k">ACTIVE</div></div>
            </div>
          </div>

          <div className="panel">
            <h3>≡ LIVE LOGS</h3>
            <div className="logs">
              {logs.length === 0 && <div style={{ color: '#5b6776' }}>waiting for activity…</div>}
              {logs.map((l) => (
                <div key={l.id} className="lg"><span style={{ color: '#566' }}>{l.time}</span> <span style={{ color: l.color }}>{l.text}</span></div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>📈 WORKFLOW ACTIVITY
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 7, fontSize: 8, letterSpacing: 0 }}>
                <span style={{ color: '#22d3ee' }}>● opened</span>
                <span style={{ color: '#22c55e' }}>● closed</span>
              </span>
            </h3>
            <div className="spark"><Spark days={flow?.throughput.days ?? []} /></div>
          </div>
        </div>
      </div>

      <div className="cc-side">
        <div className="panel" style={{ flex: 2 }}>
          <h3>▣ QUEUE {zoneFilter && <span style={{ color: C.cyan }}>· {ZONE_BY_ID.get(zoneFilter)?.label}
            <button type="button" className="queue-filter-clear" aria-label="Clear zone filter" onClick={() => { setZoneFilter(null); setFilter('actionable'); }}>✕</button></span>}</h3>
          <div className="chips">
            {CHIPS.map((c) => (
              <button key={c.id} type="button" className={`chip ${filter === c.id ? 'on' : ''}`}
                aria-pressed={filter === c.id}
                style={filter === c.id ? { background: c.color, borderColor: c.color } : {}}
                onClick={() => setFilter(c.id)}>{c.label}</button>
            ))}
          </div>
          <div className="queue">
            {filtered.map((t) => {
              const st = statusOf(t);
              return (
                <div key={t.taskId} className={`row ${selected === t.taskId ? 'sel' : ''}`}>
                  <button
                    type="button"
                    className="row-main"
                    aria-pressed={selected === t.taskId}
                    onClick={() => selectTask(t.taskId === selected ? null : t.taskId)}
                  >
                    <span className="dot" style={{ color: st.color, background: st.color }} />
                    <span className="row-title" title={distinctTitle(t.taskId, t.title) ?? undefined}>
                      <strong>{t.taskId.replace(/^TASK-?/, '#')}</strong> {distinctTitle(t.taskId, t.title)}
                    </span>
                    <span className="badge" style={{ background: '#16212e', color: '#9fb3c8', border: '1px solid #2a3744' }}>
                      {WORKSTREAM_LABELS[t.workstream || 'general']}
                    </span>
                    <span className="badge" style={{ background: `${st.color}22`, color: st.color, border: `1px solid ${st.color}55` }}>{st.label}</span>
                    {t.needsReview && <span className="badge" style={{ color: C.amber, border: `1px solid ${C.amber}55` }}>needs decision</span>}
                  </button>
                  <button
                    type="button"
                    className="open-mon"
                    title="Open in Monitor"
                    aria-label={`Open ${t.taskId} in Monitor`}
                    onClick={() => navigateTo('monitor', t.taskId)}
                  >↗</button>
                </div>
              );
            })}
            {filtered.length === 0 && <div style={{ padding: 12, color: '#5b6776', fontSize: 11 }}>No tasks.</div>}
          </div>
        </div>

        <div className="panel">
          <h3>◉ AGENT STATUS</h3>
          <div className="agents">
            {ROLE_NAMES.map((a) => {
              const n = agentStats.get(a) || 0;
              return (
                <span key={a} className="ag" style={{ opacity: n ? 1 : 0.4 }}>
                  {AGENT_EMOJI[a]} {a}
                  <span className="dot" style={{ color: n ? C.green : C.gray, background: n ? C.green : C.gray }} />
                  {n > 0 && <span style={{ color: C.green }}>{n}</span>}
                </span>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h3>◉ CONDUCTORS ACTIVE</h3>
          <div className="agents">
            {OPERATOR_NAMES.map((a) => {
              const n = conductorStats.get(a) || 0;
              return (
                <span key={a} className="ag" style={{ opacity: n ? 1 : 0.4 }}>
                  {AGENT_EMOJI[a]} {a}
                  <span className="dot" style={{ color: n ? C.cyan : C.gray, background: n ? C.cyan : C.gray }} />
                  {n > 0 && <span style={{ color: C.cyan }}>{n}</span>}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {selTask && (
        <QuickDecisionPanel review={selTask} status={statusOf(selTask)} onClose={() => selectTask(null)} onDecided={() => load()} />
      )}

      {actorEditing && (
        <ActorDialog
          value={actor}
          conflict={identity?.conflict}
          onSave={saveActor}
          onCancel={() => setActorEditing(false)}
        />
      )}
    </div>
  );
};

// Opened vs closed per day (Flow throughput, last 7 days).
function Spark({ days }: { days: FlowDay[] }) {
  if (!days.length) return <div style={{ color: '#5b6776', fontSize: 10 }}>no trend data</div>;
  const W = 100, H = 34;
  const max = Math.max(...days.map((d) => Math.max(d.opened, d.closed)));
  const line = (key: 'opened' | 'closed', color: string) => {
    const pts = sparkPolylinePoints(days, key, max, W, H);
    return <polyline points={pts} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: 1 }}>
      {line('opened', '#22d3ee')}
      {line('closed', '#22c55e')}
    </svg>
  );
}
