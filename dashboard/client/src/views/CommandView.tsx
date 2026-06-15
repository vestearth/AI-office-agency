import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReviewModelResponse, ReviewSummary, RunSummary, RunPhase, AgentName, DecisionAction,
  AnalyticsResponse, HealthStatus, RunsTrendPoint, WatcherUpdate, RunDetail, RunFileResponse,
} from '../../../shared/types';
import { apiFetch, apiFetchJson, syncIdentity, type IdentityResponse } from '../api';
import { formatLiveLogStamp } from './commandLogTime';

// "Command Center": an AI-generated isometric office (public/office-bg.png) as a
// live map with phase-zone status pins + animated flow lines, plus a data-rich
// sidebar (queue, agents) and bottom panels (health, live logs, workflow chart),
// all driven by the existing API contracts.

const ACTOR_KEY = 'dashboard_actor';

interface Zone { id: string; label: string; phases: RunPhase[]; agent: AgentName | null; left: number; top: number; }
const ZONES: Zone[] = [
  { id: 'inbox', label: 'Inbox', phases: ['pending'], agent: 'pm', left: 13, top: 31 },
  { id: 'review', label: 'Review', phases: ['review', 'in_review'], agent: 'reviewer', left: 34, top: 30 },
  { id: 'escalation', label: 'Escalation', phases: ['escalated', 'free_roam_complete'], agent: 'free-roam', left: 54, top: 26 },
  { id: 'devops', label: 'DevOps', phases: ['devops_needed', 'devops_complete'], agent: 'devops', left: 78, top: 26 },
  { id: 'dev', label: 'Dev Bay', phases: ['assigned', 'assigned_parallel'], agent: 'dev', left: 23, top: 56 },
  { id: 'done', label: 'Done', phases: ['done'], agent: null, left: 48, top: 46 },
  { id: 'debug', label: 'Debug Lab', phases: ['debugging', 'debugging_complete'], agent: 'debugger', left: 85, top: 49 },
  { id: 'blocked', label: 'Blocked', phases: ['blocked'], agent: null, left: 18, top: 61 },
  { id: 'rejected', label: 'Val.Failed', phases: ['validation_failed'], agent: null, left: 69, top: 59 },
  { id: 'aborted', label: 'Aborted', phases: ['aborted'], agent: null, left: 48, top: 80 },
];
const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));
const PHASE_TO_ZONE = new Map<string, string>();
for (const z of ZONES) for (const p of z.phases) PHASE_TO_ZONE.set(p, z.id);

const AGENT_EMOJI: Record<string, string> = {
  pm: '🧑‍💼', dev: '👷', 'dev-2': '👩‍🔧', reviewer: '🕵️', debugger: '🐛',
  devops: '🛠️', 'free-roam': '🦸', unknown: '❔',
};
const C = { cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444', gray: '#5b6776' };
const DECISION_ACTIONS: { action: DecisionAction; label: string }[] = [
  { action: 'approve', label: 'Approve' }, { action: 'request_changes', label: 'Changes' },
  { action: 'escalate', label: 'Escalate' }, { action: 'reject', label: 'Reject' },
];
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
  workstream?: RunSummary['workstream'];
}
interface Flow { id: number; from: string; to: string; }
interface LogLine { id: number; time: string; text: string; color: string; }
type Filter = 'actionable' | 'needs' | 'running' | 'failed' | 'done' | 'all';

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
function isActionable(t: { status: RunSummary['status'] }): boolean {
  return t.status !== 'completed' && t.status !== 'cancelled';
}

const STYLE = `
.cc { display: grid; grid-template-columns: 1fr 340px; gap: 12px; height: 100%; padding: 12px;
  background: #0a0e14; color: #c9d4e3; font-family: ui-monospace, 'SF Mono', monospace; overflow: hidden; }
.cc-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cc-top { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.cc-map { position: relative; flex: 1; border: 1px solid #1e2733; border-radius: 6px; overflow: hidden;
  background: #05070b center/cover no-repeat; min-height: 220px; }
.flow { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
.flowpath { fill: none; stroke: #22d3ee; stroke-width: 2; vector-effect: non-scaling-stroke;
  stroke-dasharray: 4 5; animation: dash 0.5s linear infinite; filter: drop-shadow(0 0 3px #22d3ee); opacity: 0.9; }
@keyframes dash { to { stroke-dashoffset: -9; } }
.pin { position: absolute; z-index: 5; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 5px;
  background: rgba(6,10,16,0.94); border: 1px solid #38465a; border-radius: 12px; padding: 4px 8px;
  font-size: 10px; white-space: nowrap; cursor: pointer; backdrop-filter: blur(3px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.55); transition: box-shadow 0.15s, border-color 0.15s, transform 0.1s; }
.pin:hover { z-index: 6; border-color: #22d3ee; transform: translate(-50%, -50%) scale(1.07);
  box-shadow: 0 0 16px 2px rgba(34,211,238,0.6), 0 2px 8px rgba(0,0,0,0.6); }
.pin.sel { outline: 1px solid #22d3ee; }
.dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 6px currentColor; flex: none; }
.pin .cnt { color: #8a97a8; }
.pulse { animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 12px 3px currentColor; opacity: 0.7; } }
.panel { background: #0d131b; border: 1px solid #1e2733; border-radius: 6px; display: flex; flex-direction: column; min-height: 0; }
.panel h3 { margin: 0; padding: 8px 10px; font-size: 11px; letter-spacing: 1px; color: #7f8da0;
  border-bottom: 1px solid #1e2733; display: flex; align-items: center; gap: 6px; }
.chips { display: flex; gap: 4px; padding: 6px 8px; flex-wrap: wrap; }
.chip { font-size: 10px; padding: 2px 7px; border-radius: 10px; border: 1px solid #243; cursor: pointer; background: #0f1620; color: #8a97a8; }
.chip.on { color: #06121a; font-weight: 700; }
.queue { overflow: auto; flex: 1; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #141b24; cursor: pointer; font-size: 11px; }
.row:hover { background: #101a25; }
.row.sel { background: #11212e; }
.badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; margin-left: auto; white-space: nowrap; }
.cc-side { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
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
.modal-bg { position: fixed; inset: 0; background: rgba(3,6,10,0.66); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 24px; backdrop-filter: blur(2px); }
.modal { width: min(720px, 92vw); max-height: 86vh; background: #0d131b; border: 1px solid #2a3744; border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 14px 44px rgba(0,0,0,0.6); }
.modal > header { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid #1e2733; font-size: 13px; }
.modal .x { margin-left: auto; cursor: pointer; background: none; border: none; color: #8a97a8; font-size: 16px; }
.modal .body { overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
.modal h4 { margin: 0 0 6px; font-size: 9px; letter-spacing: 1px; color: #7f8da0; }
.modal pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.55; color: #c9d4e3; background: #0a0e14; border: 1px solid #1a2330; border-radius: 4px; padding: 9px; max-height: 240px; overflow: auto; }
.modal .tl > div { font-size: 11px; line-height: 1.7; border-left: 2px solid #243; padding-left: 8px; margin-bottom: 4px; }
.modal .arts { display: flex; flex-wrap: wrap; gap: 5px; }
.modal .art { font-size: 10px; padding: 2px 7px; border-radius: 4px; background: #0f1620; border: 1px solid #1e2733; color: #9aa0b4; }
.modal > footer { display: flex; gap: 6px; padding: 10px 14px; border-top: 1px solid #1e2733; flex-wrap: wrap; }
.modal > footer button { font: inherit; font-size: 11px; padding: 5px 12px; cursor: pointer; border: 1px solid #2a3744; background: #16212e; color: #c9d4e3; border-radius: 5px; }
`;

function statusOf(t: Task): { label: string; color: string } {
  if (t.needsReview) return { label: 'Needs Review', color: C.amber };
  switch (t.status) {
    case 'running': return { label: 'Running', color: C.green };
    case 'waiting_review': return { label: 'Waiting', color: C.cyan };
    case 'failed': return { label: 'Validation', color: C.red };
    case 'blocked': return { label: 'Blocked', color: C.amber };
    case 'completed': return { label: 'Done', color: C.gray };
    case 'cancelled': return { label: 'Aborted', color: C.gray };
    default: return { label: t.status || 'queued', color: C.gray };
  }
}
function hhmmss(iso?: string): string {
  return formatLiveLogStamp(iso, 'time');
}
function pathTail(p: string): string {
  const m = p.match(/(TASK-?[A-Za-z0-9_-]+[\/\\][^\/\\]+)$/);
  return m ? m[1].replace(/\\/g, '/') : p.split(/[\/\\]/).slice(-2).join('/');
}

export const CommandView: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('actionable');
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileView, setFileView] = useState<RunFileResponse | null>(null);
  const [actor, setActor] = useState(() => localStorage.getItem(ACTOR_KEY) || '');
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  const prevZone = useRef<Map<string, string>>(new Map());

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
      const [review, runs, an, hp] = await Promise.all([
        apiFetchJson<ReviewModelResponse>('/api/review'),
        apiFetchJson<RunSummary[]>('/api/runs'),
        apiFetchJson<AnalyticsResponse>('/api/analytics').catch(() => null),
        apiFetchJson<HealthStatus>('/api/health').catch(() => null),
      ]);
      const runById = new Map(runs.map((r) => [r.id, r]));
      const next: Task[] = review.reviews.map((rv) => ({
        ...rv, title: runById.get(rv.taskId)?.title || rv.taskId,
        status: runById.get(rv.taskId)?.status || 'unknown',
        updatedAt: runById.get(rv.taskId)?.updatedAt,
        currentAgent: runById.get(rv.taskId)?.currentAgent,
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
              text: `${AGENT_EMOJI[t.currentAgent || 'unknown']} ${t.taskId} → ${t.phase ?? '—'}`,
              color: statusOf(t).color,
            }));
        });
      }

      setTasks(next); setAnalytics(an); setHealth(hp); setError(null);
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

  // Fetch full detail (task.md / timeline / artifacts) for the selected task.
  useEffect(() => {
    if (!selected) { setDetail(null); setFileView(null); return; }
    let active = true;
    setDetailLoading(true); setFileView(null);
    apiFetchJson<RunDetail>(`/api/runs/${selected}`)
      .then((d) => { if (active) setDetail(d); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selected]);

  // Esc closes the detail panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const zoneStats = useMemo(() => {
    const m = new Map<string, { count: number; attention: boolean; active: boolean }>();
    for (const t of tasks) {
      const z = (t.phase && PHASE_TO_ZONE.get(t.phase)) || null;
      if (!z) continue;
      const cur = m.get(z) || { count: 0, attention: false, active: false };
      cur.count++;
      if (t.needsReview || t.status === 'failed') cur.attention = true;
      if (ZONE_BY_ID.get(z)?.agent && t.currentAgent === ZONE_BY_ID.get(z)?.agent) cur.active = true;
      m.set(z, cur);
    }
    return m;
  }, [tasks]);

  const agentStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.currentAgent && t.currentAgent !== 'unknown' && t.status !== 'completed' && t.status !== 'cancelled') {
        m.set(t.currentAgent, (m.get(t.currentAgent) || 0) + 1);
      }
    }
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    let list = tasks;
    if (zoneFilter) list = list.filter((t) => (t.phase && PHASE_TO_ZONE.get(t.phase)) === zoneFilter);
    if (filter === 'actionable') list = list.filter(isActionable);
    else if (filter === 'needs') list = list.filter((t) => t.needsReview);
    else if (filter === 'running') list = list.filter((t) => t.status === 'running' || t.status === 'waiting_review');
    else if (filter === 'failed') list = list.filter((t) => t.status === 'failed');
    else if (filter === 'done') list = list.filter((t) => t.status === 'completed');
    // Always order actionable-first; Done/aborted sink to the bottom.
    return [...list].sort((a, b) => priority(a) - priority(b) || b.taskId.localeCompare(a.taskId));
  }, [tasks, filter, zoneFilter]);

  const counts = useMemo(() => ({
    all: tasks.length,
    actionable: tasks.filter(isActionable).length,
    running: tasks.filter((t) => t.status === 'running' || t.status === 'waiting_review').length,
    needs: tasks.filter((t) => t.needsReview).length,
    done: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  }), [tasks]);

  // Health computed from the live task set (not the windowed analytics summary).
  // SUCCESS = of FINISHED work, the fraction that succeeded — in-progress tasks
  // are not counted as failures, so the number reflects quality, not backlog.
  const healthStats = useMemo(() => {
    let completed = 0, failed = 0, blocked = 0, running = 0, cancelled = 0;
    for (const t of tasks) {
      if (t.status === 'completed') completed++;
      else if (t.status === 'failed') failed++;
      else if (t.status === 'blocked') blocked++;
      else if (t.status === 'running' || t.status === 'waiting_review') running++;
      else if (t.status === 'cancelled') cancelled++;
    }
    const finished = completed + failed + cancelled;
    return { completed, failed, blocked, running, successPct: finished ? Math.round((completed / finished) * 100) : 0 };
  }, [tasks]);

  const decide = async (taskId: string, action: DecisionAction) => {
    const noteRequired = action !== 'approve';
    const note = window.prompt(`Note for "${action}" on ${taskId}${noteRequired ? ' (required):' : ' (optional):'}`) ?? undefined;
    if (noteRequired && !note?.trim()) { setError(`A note is required for "${action}".`); return; }
    setError(null);
    try {
      const res = await apiFetch(`/api/decisions/${taskId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: action, actor: actor.trim() || undefined, note }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `Failed (${res.status})`); }
      else { await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
  };

  const openFile = async (name: string) => {
    if (!selected) return;
    setFileView({ name, content: 'Loading…', truncated: false });
    try {
      setFileView(await apiFetchJson<RunFileResponse>(`/api/runs/${selected}/file/${encodeURIComponent(name)}`));
    } catch {
      setFileView({ name, content: '(failed to load file)', truncated: false });
    }
  };

  if (loading) return <div className="view-state">Loading command center…</div>;
  const selTask = tasks.find((t) => t.taskId === selected) || null;
  const s = analytics?.summary;
  const CHIPS: { id: Filter; label: string; color: string }[] = [
    { id: 'actionable', label: `Actionable ${counts.actionable}`, color: C.cyan },
    { id: 'needs', label: `Needs ${counts.needs}`, color: C.amber },
    { id: 'failed', label: `Validation ${counts.failed}`, color: C.red },
    { id: 'done', label: `Done ${counts.done}`, color: C.gray },
    { id: 'all', label: `All ${counts.all}`, color: '#8a97a8' },
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
            onClick={() => {
              const n = (window.prompt('Your name (used on decisions):', actor) ?? actor).trim();
              setActor(n); localStorage.setItem(ACTOR_KEY, n);
              syncIdentity(n).then((id) => { if (id) setIdentity(id); });
            }}
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

        <div className="cc-map" style={{ backgroundImage: 'url(/office-bg.png)', imageRendering: 'pixelated' }}>
          <svg className="flow" viewBox="0 0 100 100" preserveAspectRatio="none">
            {flows.map((f) => {
              const a = ZONE_BY_ID.get(f.from)!, b = ZONE_BY_ID.get(f.to)!;
              return <path key={f.id} className="flowpath" d={`M ${a.left} ${a.top} L ${b.left} ${b.top}`} />;
            })}
          </svg>
          {ZONES.map((z) => {
            const st = zoneStats.get(z.id) || { count: 0, attention: false, active: false };
            const hasTasks = st.count > 0;
            const color = !hasTasks ? C.gray : st.attention ? C.amber : st.active ? C.cyan : C.green;
            return (
              <div key={z.id} className={`pin ${zoneFilter === z.id ? 'sel' : ''}`}
                style={{ left: `${z.left}%`, top: `${z.top}%`, opacity: hasTasks ? 1 : 0.68 }}
                onClick={() => {
                  if (zoneFilter === z.id) { setZoneFilter(null); setFilter('actionable'); }
                  else { setZoneFilter(z.id); setFilter('all'); } // focus the zone → show everything in it
                }}
                title={`${z.label}: ${st.count} task(s)`}>
                <span className={`dot ${st.attention ? 'pulse' : ''}`} style={{ color, background: color }} />
                {z.agent && <span>{AGENT_EMOJI[z.agent]}</span>}
                <span>{z.label}</span><span className="cnt">{st.count}</span>
              </div>
            );
          })}
        </div>

        <div className="cc-bottom">
          <div className="panel">
            <h3>♥ SYSTEM HEALTH {s && <span style={{ marginLeft: 'auto', color: s.healthScore.status === 'ok' ? C.green : s.healthScore.status === 'warning' ? C.amber : C.red }}>{s.healthScore.score}</span>}</h3>
            <div className="stats">
              <div className="stat"><div className="v" style={{ color: C.green }}>{`${healthStats.successPct}%`}</div><div className="k">SUCCESS</div></div>
              <div className="stat"><div className="v" style={{ color: C.red }}>{healthStats.failed}</div><div className="k">FAILED</div></div>
              <div className="stat"><div className="v" style={{ color: C.amber }}>{healthStats.blocked}</div><div className="k">BLOCKED</div></div>
              <div className="stat"><div className="v" style={{ color: C.cyan }}>{healthStats.running}</div><div className="k">RUNNING</div></div>
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
                <span style={{ color: '#22d3ee' }}>● total</span>
                <span style={{ color: '#22c55e' }}>● done</span>
                <span style={{ color: '#ef4444' }}>● fail</span>
              </span>
            </h3>
            <div className="spark"><Spark trends={analytics?.trends ?? []} /></div>
          </div>
        </div>
      </div>

      <div className="cc-side">
        <div className="panel" style={{ flex: 2 }}>
          <h3>▣ QUEUE {zoneFilter && <span style={{ color: C.cyan }}>· {ZONE_BY_ID.get(zoneFilter)?.label}
            <span style={{ cursor: 'pointer', marginLeft: 6 }} onClick={() => { setZoneFilter(null); setFilter('actionable'); }}>✕</span></span>}</h3>
          <div className="chips">
            {CHIPS.map((c) => (
              <span key={c.id} className={`chip ${filter === c.id ? 'on' : ''}`}
                style={filter === c.id ? { background: c.color, borderColor: c.color } : {}}
                onClick={() => setFilter(c.id)}>{c.label}</span>
            ))}
          </div>
          <div className="queue">
            {filtered.map((t) => {
              const st = statusOf(t);
              return (
                <div key={t.taskId} className={`row ${selected === t.taskId ? 'sel' : ''}`}
                  onClick={() => setSelected(t.taskId === selected ? null : t.taskId)}>
                  <span className="dot" style={{ color: st.color, background: st.color }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{t.taskId.replace(/^TASK-?/, '#')}</strong> {t.title}
                  </span>
                  <span className="badge" style={{ background: '#16212e', color: '#9fb3c8', border: '1px solid #2a3744' }}>
                    {WORKSTREAM_LABELS[t.workstream || 'general']}
                  </span>
                  <span className="badge" style={{ background: `${st.color}22`, color: st.color, border: `1px solid ${st.color}55` }}>{st.label}</span>
                </div>
              );
            })}
            {filtered.length === 0 && <div style={{ padding: 12, color: '#5b6776', fontSize: 11 }}>No tasks.</div>}
          </div>
        </div>

        <div className="panel">
          <h3>◉ AGENT STATUS</h3>
          <div className="agents">
            {Object.keys(AGENT_EMOJI).filter((a) => a !== 'unknown').map((a) => {
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
      </div>

      {selTask && (
        <div className="modal-bg" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>{selTask.taskId}</strong>
              <span style={{ color: '#9aa0b4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{selTask.title}</span>
              <button className="x" onClick={() => setSelected(null)}>✕</button>
            </header>
            <div className="body">
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
                <span style={{ color: statusOf(selTask).color }}>● {statusOf(selTask).label}</span>
                <span>phase: {selTask.phase ?? '—'}</span>
                <span>verdict: {selTask.verdict ?? '—'}</span>
                <span style={{ color: selTask.riskLevel === 'high' ? C.red : selTask.riskLevel === 'medium' ? C.amber : selTask.riskLevel === 'low' ? C.green : C.gray }}>
                  risk: {selTask.riskLevel} (e{selTask.issueCounts.error}/w{selTask.issueCounts.warning}/s{selTask.issueCounts.suggestion})
                </span>
                <span>confidence: {selTask.confidence ?? '—'}</span>
                {selTask.latestDecision && <span style={{ color: C.green }}>decided: {selTask.latestDecision.decision} · {selTask.latestDecision.actor}</span>}
              </div>
              {detail?.reviewIssues?.length ? (
                <div><h4>REVIEWER ISSUES ({detail.reviewIssues.length})</h4>
                  <div className="tl">
                    {detail.reviewIssues.map((iss, i) => {
                      const c = iss.severity === 'error' ? C.red : iss.severity === 'warning' ? C.amber : '#8a97a8';
                      return (
                        <div key={i} style={{ borderLeftColor: c }}>
                          <span style={{ color: c }}>[{iss.severity}]</span>
                          {iss.file ? <span style={{ color: '#7f8da0' }}> {iss.file}</span> : null} — {iss.description}
                        </div>);
                    })}
                  </div>
                </div>
              ) : null}
              <div><h4>TASK</h4><pre>{detail?.taskMarkdown || (detailLoading ? 'Loading…' : 'No task.md found.')}</pre></div>
              <div><h4>TIMELINE</h4>
                <div className="tl">
                  {detail?.timeline?.length
                    ? detail.timeline.map((ev) => (
                        <div key={ev.id}><span style={{ color: C.cyan }}>{ev.agent}</span> · {ev.action}{ev.message ? <span style={{ color: '#8a97a8' }}> — {ev.message}</span> : null}</div>))
                    : <span style={{ color: '#5b6776', fontSize: 11 }}>{detailLoading ? 'Loading…' : 'No history.'}</span>}
                </div>
              </div>
              <div><h4>ARTIFACTS <span style={{ color: '#5b6776', fontWeight: 400 }}>(click to view)</span></h4>
                <div className="arts">
                  {detail?.artifacts?.length
                    ? detail.artifacts.map((a) => (
                        <span className="art" key={a.name} onClick={() => openFile(a.name)}
                          style={{ cursor: 'pointer', color: fileView?.name === a.name ? '#22d3ee' : '#9aa0b4' }}>{a.name}</span>))
                    : <span style={{ color: '#5b6776', fontSize: 11 }}>none</span>}
                </div>
              </div>
              {fileView && (
                <div><h4 style={{ display: 'flex' }}>FILE · {fileView.name}
                  <span style={{ marginLeft: 'auto', cursor: 'pointer', color: '#8a97a8' }} onClick={() => setFileView(null)}>✕</span>
                </h4>
                  <pre>{fileView.content}{fileView.truncated ? '\n\n… (truncated)' : ''}</pre>
                </div>
              )}
            </div>
            <footer>
              {DECISION_ACTIONS.map(({ action, label }) => (
                <button key={action} onClick={() => decide(selTask.taskId, action)}>{label}</button>
              ))}
            </footer>
          </div>
        </div>
      )}
    </div>
  );
};

function Spark({ trends }: { trends: RunsTrendPoint[] }) {
  if (!trends.length) return <div style={{ color: '#5b6776', fontSize: 10 }}>no trend data</div>;
  const W = 100, H = 34;
  const max = Math.max(1, ...trends.map((t) => t.total));
  const line = (key: keyof RunsTrendPoint, color: string) => {
    const pts = trends.map((t, i) => {
      const x = (i / Math.max(1, trends.length - 1)) * W;
      const y = H - (Number(t[key]) / max) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return <polyline points={pts} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', flex: 1 }}>
      {line('total', '#22d3ee')}
      {line('completed', '#22c55e')}
      {line('failed', '#ef4444')}
    </svg>
  );
}
