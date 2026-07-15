import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReviewModelResponse, ReviewSummary, RunSummary, RunPhase, AgentName, DecisionAction,
  AnalyticsResponse, HealthStatus, RunsTrendPoint, WatcherUpdate, RunDetail, RunFileResponse,
  TimelineActor, ModelRoutingPreview, NextActionPreview, TaskActionRole,
} from '../../../shared/types';
import { apiFetchJson, syncIdentity, type IdentityResponse } from '../api';
import { formatLiveLogStamp } from './commandLogTime';
import { sparkPolylinePoints } from './spark';
import { AGENT_EMOJI, agentGlyph, ROLE_NAMES, OPERATOR_NAMES } from './agentDisplay';
import { DecisionDialog } from './DecisionDialog';
import { ActorDialog } from './ActorDialog';
import { navigateTo } from '../navigation';

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

// AGENT_EMOJI now lives in ./agentDisplay (shared with MonitorView, operator-aware).
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
  currentConductor?: TimelineActor;
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
.badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.row .badge:nth-of-type(1) { margin-left: auto; }
.open-mon { cursor: pointer; color: #5b6776; font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 3px; flex: none; }
.open-mon:hover { color: #22d3ee; }
.open-mon:focus-visible { outline: 2px solid #22d3ee; outline-offset: 1px; color: #22d3ee; }
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
.modal-bg { position: fixed; inset: 0; background: rgba(3,6,10,0.72); z-index: 100; display: flex; align-items: center; justify-content: center; padding: clamp(12px, 2.5vw, 32px); backdrop-filter: blur(3px); }
.modal { width: min(1040px, calc(100vw - 32px)); max-height: min(900px, calc(100vh - 32px)); background: #0d131b; border: 1px solid #2a3744; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 64px rgba(0,0,0,0.68); }
.modal > header { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 12px 18px; border-bottom: 1px solid #24303d; background: #0b1119; }
.modal-title-id { flex: none; color: #e6edf5; font-size: 13px; letter-spacing: 0.02em; }
.modal-title-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8fa0b4; font-size: 13px; }
.modal .x { margin-left: auto; width: 34px; height: 34px; display: grid; place-items: center; flex: none; cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: 7px; color: #8a97a8; font-size: 17px; }
.modal .x:hover { color: #e6edf5; border-color: #334155; background: #131d28; }
.modal .x:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
.modal .body { overflow: auto; padding: 16px 18px 20px; display: flex; flex-direction: column; gap: 18px; }
.task-facts { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.task-fact { min-height: 26px; display: inline-flex; align-items: center; padding: 4px 8px; border: 1px solid #243140; border-radius: 999px; background: #101822; color: #93a4b8; font-size: 11px; line-height: 1; }
.command-preview-grid { display: grid; grid-template-columns: minmax(280px, 0.85fr) minmax(460px, 1.35fr); gap: 12px; align-items: start; }
.command-preview-grid > * { min-width: 0; }
.modal h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em; color: #8998aa; }
.modal pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; color: #c9d4e3; background: #0a0e14; border: 1px solid #1a2330; border-radius: 7px; padding: 12px; max-height: 280px; overflow: auto; }
.modal .tl > div { font-size: 12px; line-height: 1.65; border-left: 2px solid #243647; padding: 2px 0 2px 10px; margin-bottom: 6px; }
.modal .arts { display: flex; flex-wrap: wrap; gap: 5px; }
.modal .art { font-size: 11px; padding: 4px 8px; border-radius: 5px; background: #0f1620; border: 1px solid #253343; color: #9aa0b4; }
.modal > footer { display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-top: 1px solid #24303d; background: #0b1119; flex-wrap: wrap; }
.decision-context { margin-right: auto; display: grid; gap: 2px; }
.decision-context strong { color: #dbe7f2; font-size: 12px; letter-spacing: 0.04em; }
.decision-context span { color: #65778a; font-size: 10px; }
.decision-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.decision-button { min-height: 34px; padding: 6px 12px; cursor: pointer; border: 1px solid #334155; background: #141f2b; color: #c9d4e3; border-radius: 7px; font: inherit; font-size: 11px; font-weight: 600; transition: border-color 0.15s, background-color 0.15s, color 0.15s; }
.decision-button:hover { background: #1a2836; color: #f0f6fc; }
.decision-button[data-action="approve"] { border-color: #2e6f42; color: #7ee787; }
.decision-button[data-action="request_changes"] { border-color: #7a5b20; color: #e3b341; }
.decision-button[data-action="escalate"] { border-color: #6550a2; color: #c6a7ff; }
.decision-button[data-action="reject"] { border-color: #7b3434; color: #ff7b72; }
.decision-button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
.model-route { flex: none; border: 1px solid #294152; border-radius: 9px; background: #0a1119; overflow: hidden; }
.model-route > summary { list-style: none; cursor: pointer;
  padding: 12px; color: #dce7f1; font-size: 12px; border-bottom: 1px solid transparent; }
.model-route[open] > summary { border-bottom-color: #1e3443; }
.model-route > summary::-webkit-details-marker { display: none; }
.model-route-summary { display: flex; align-items: center; gap: 8px; }
.model-route .route-pill { margin-left: auto; border: 1px solid #22667a; border-radius: 12px; padding: 2px 7px;
  color: #67e8f9; background: #0c2530; font-size: 9px; font-weight: 700; white-space: nowrap; }
.model-route-body { padding: 12px; display: grid; gap: 10px; }
.model-route-row { display: grid; grid-template-columns: minmax(110px, 1fr) auto; align-items: center; gap: 12px;
  min-height: 34px; padding: 0 10px; border: 1px solid #1b2b39; border-radius: 6px; background: #0d1721; font-size: 11px; }
.model-route-row strong { color: #e6edf5; font-weight: 600; }
.model-route-row .route-value { color: #9ccbd8; text-align: right; }
.model-route-auto { border-color: #22667a; background: #0d202a; }
.model-route-auto .route-check { color: #67e8f9; font-size: 14px; }
.model-route-help { margin-top: 3px; color: #6f8496; font-size: 10px; line-height: 1.4; }
.routing-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.routing-metric { min-width: 0; display: grid; gap: 4px; padding: 9px 10px; border: 1px solid #1b2b39; border-radius: 6px; background: #0d1721; }
.routing-metric span { color: #6f8496; font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; }
.routing-metric strong { overflow: hidden; text-overflow: ellipsis; color: #b8d9e4; font-size: 12px; font-weight: 600; white-space: nowrap; }
.model-route-meta { display: flex; flex-wrap: wrap; gap: 5px; }
.model-route-meta span { border: 1px solid #25394a; border-radius: 10px; padding: 2px 7px; color: #7f9aab; font-size: 9px; }
.manual-override { display: grid; gap: 9px; padding: 10px; border: 1px solid #243647; border-radius: 7px; background: #0c141d; }
.manual-override-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.manual-override-head strong { color: #a8c6d2; font-size: 11px; }
.manual-override-head span { color: #6f8496; font-size: 10px; text-align: right; }
.override-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.override-field { min-width: 0; display: grid; gap: 5px; color: #8394a8; font-size: 10px; }
.command-select { min-width: 0; height: 36px; padding: 6px 9px; border-radius: 6px; color-scheme: dark; text-align: left; font-size: 11px; }
.command-select option { background: #0d1117; color: #c9d1d9; }
.model-route-reasons { display: grid; gap: 6px; padding-top: 2px; }
.routing-explanation-title { color: #8295a8; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.model-route-reason { display: grid; grid-template-columns: minmax(130px, auto) 1fr; gap: 10px; font-size: 11px; line-height: 1.5; }
.model-route-reason strong { color: #a8c6d2; font-weight: 600; }
.model-route-reason span { color: #71869a; }
.next-action-card { height: 100%; }
.next-action-card .model-route-body { height: 100%; align-content: start; }
.next-action-target .route-value { color: #dce7f1; font-size: 13px; font-weight: 700; }
.preview-launch { width: 100%; min-height: 36px; border: 1px dashed #344556; border-radius: 6px; background: #111a24; color: #708296; font: inherit; font-size: 10px; }
@media (max-width: 900px) {
  .cc { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .cc-map { flex: none; min-height: 360px; }
  .cc-bottom { grid-template-columns: 1fr 1fr; height: auto; }
  .cc-bottom .panel { min-height: 140px; }
  .cc-side { min-height: 390px; }
  .cc-side .panel { flex: none !important; }
  .cc-side .panel:first-child { min-height: 280px; }
  .command-preview-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .cc { padding: 8px; gap: 8px; }
  .cc-top { flex-wrap: wrap; }
  .cc-map { min-height: 320px; }
  .cc-bottom { grid-template-columns: 1fr; }
  .pin { font-size: 9px; padding: 3px 6px; }
  .row { gap: 5px; padding: 6px 8px; }
  .modal-bg { padding: 8px; }
  .modal { width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
  .modal > header { padding: 10px 12px; }
  .modal .body { padding: 12px; }
  .modal > footer { align-items: stretch; padding: 10px 12px; }
  .decision-context { width: 100%; }
  .decision-actions { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
  .override-grid, .routing-summary-grid { grid-template-columns: 1fr; }
  .manual-override-head { align-items: flex-start; flex-direction: column; gap: 3px; }
  .manual-override-head span { text-align: left; }
  .model-route-row { grid-template-columns: 1fr auto; }
  .model-route-reason { grid-template-columns: 1fr; gap: 1px; }
}
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
  // In-app decision capture (replaces window.prompt). Holds the action targeting
  // the currently selected task; the DecisionDialog owns the POST + note rules.
  const [decision, setDecision] = useState<{ action: DecisionAction; label: string } | null>(null);
  // In-app actor editor (replaces window.prompt for "Your name").
  const [actorEditing, setActorEditing] = useState(false);
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
              text: `${AGENT_EMOJI[t.currentAgent || 'unknown']} ${t.taskId} → ${t.phase ?? '—'}${t.currentConductor ? `  ·  ${agentGlyph(t.currentConductor)} ${t.currentConductor}` : ''}`,
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

  // Esc closes the detail panel — but defer to an open dialog (decision/actor),
  // which owns its own Esc-to-close so the task modal stays put underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !decision && !actorEditing) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decision, actorEditing]);

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
                role="button" tabIndex={0} aria-pressed={zoneFilter === z.id}
                style={{ left: `${z.left}%`, top: `${z.top}%`, opacity: hasTasks ? 1 : 0.68 }}
                onClick={() => toggleZone(z.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleZone(z.id); } }}
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
                role="button" tabIndex={0} aria-pressed={filter === c.id}
                style={filter === c.id ? { background: c.color, borderColor: c.color } : {}}
                onClick={() => setFilter(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(c.id); } }}>{c.label}</span>
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
                  <span className="open-mon" role="button" tabIndex={0} title="Open in Monitor"
                    onClick={(e) => { e.stopPropagation(); navigateTo('monitor', t.taskId); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); navigateTo('monitor', t.taskId); } }}>↗</span>
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
        <div className="modal-bg" onClick={() => setSelected(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="task-command-title" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong className="modal-title-id" id="task-command-title">{selTask.taskId}</strong>
              <span className="modal-title-name">{selTask.title}</span>
              <button className="x" type="button" aria-label="Close task detail" onClick={() => setSelected(null)}>✕</button>
            </header>
            <div className="body">
              <div className="task-facts" aria-label="Task status summary">
                <span className="task-fact" style={{ color: statusOf(selTask).color }}>● {statusOf(selTask).label}</span>
                <span className="task-fact">phase: {selTask.phase ?? '—'}</span>
                <span className="task-fact">verdict: {selTask.verdict ?? '—'}</span>
                <span className="task-fact" style={{ color: selTask.riskLevel === 'high' ? C.red : selTask.riskLevel === 'medium' ? C.amber : selTask.riskLevel === 'low' ? C.green : C.gray }}>
                  risk: {selTask.riskLevel} (e{selTask.issueCounts.error}/w{selTask.issueCounts.warning}/s{selTask.issueCounts.suggestion})
                </span>
                <span className="task-fact">confidence: {selTask.confidence ?? '—'}</span>
                {selTask.latestDecision && <span className="task-fact" style={{ color: C.green }}>decided: {selTask.latestDecision.decision} · {selTask.latestDecision.actor}</span>}
              </div>
              <div className="command-preview-grid">
                {detail?.nextActionPreview && <NextActionPreviewCard preview={detail.nextActionPreview} />}
                {detail?.modelRoutingPreview && <ModelRoutingPreviewCard preview={detail.modelRoutingPreview} action={detail.nextActionPreview} />}
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
              <div className="decision-context">
                <strong>Decision</strong>
                <span>Recorded to decision.yaml; status changes on driver reconcile.</span>
              </div>
              <div className="decision-actions">
                {DECISION_ACTIONS.map(({ action, label }) => (
                  <button className="decision-button" data-action={action} type="button" key={action} onClick={() => setDecision({ action, label })}>{label}</button>
                ))}
              </div>
            </footer>
          </div>
        </div>
      )}

      {decision && selTask && (
        <DecisionDialog
          taskId={selTask.taskId}
          action={decision.action}
          actionLabel={decision.label}
          actor={actor}
          onCancel={() => setDecision(null)}
          onDone={() => { setDecision(null); load(); }}
        />
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

function NextActionPreviewCard({ preview }: { preview: NextActionPreview }) {
  return (
    <section className="model-route next-action-card" aria-labelledby="next-action-heading">
      <div className="model-route-body">
        <div className="model-route-summary">
          <span style={{ color: C.cyan }}>➜</span>
          <strong id="next-action-heading">Recommended next action</strong>
          <span className="route-pill">PREVIEW ONLY</span>
        </div>
        <div className="model-route-row next-action-target">
          <span>Target role</span><span className="route-value">{preview.targetRole ?? 'No launch target'}</span>
        </div>
        <div className="model-route-reason"><strong>Why</strong><span>{preview.reason}</span></div>
        {preview.targetRole && preview.targetRole !== 'done' && (
          <button className="preview-launch" disabled title="Role launch is not enabled in this preview-control MVP">Launch {preview.targetRole} · Preview only</button>
        )}
        <div className="model-route-meta"><span>source: {preview.source}</span><span>no role is launched</span></div>
      </div>
    </section>
  );
}

function ModelRoutingPreviewCard({ preview, action }: { preview: ModelRoutingPreview; action?: NextActionPreview }) {
  const initialRole: TaskActionRole = action?.targetRole && action.targetRole !== 'done'
    ? action.targetRole
    : preview.role === 'unknown' ? 'dev' : preview.role;
  const [role, setRole] = useState<TaskActionRole>(initialRole);
  const [model, setModel] = useState(preview.model);
  const [reasoning, setReasoning] = useState(preview.reasoningEffort);
  const roles: TaskActionRole[] = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam'];
  return (
    <details className="model-route routing-card" open>
      <summary>
        <span className="model-route-summary">
          <span style={{ color: C.cyan }}>✦</span>
          <strong>Auto · {preview.modelLabel} {preview.reasoningEffort}</strong>
          <span className="route-pill">PREVIEW ONLY</span>
        </span>
      </summary>
      <div className="model-route-body">
        <div className="model-route-row model-route-auto">
          <div>
            <strong>Auto</strong>
            <div className="model-route-help">Selects again for each role invocation</div>
          </div>
          <span className="route-check" aria-label="Auto selected">✓</span>
        </div>
        <div className="routing-summary-grid">
          <div className="routing-metric"><span>Model</span><strong>{preview.modelLabel}</strong></div>
          <div className="routing-metric"><span>Reasoning</span><strong>{preview.reasoningEffort}</strong></div>
          <div className="routing-metric"><span>Speed</span><strong>{preview.speed}</strong></div>
        </div>
        <div className="model-route-meta">
          <span>role: {preview.role}</span>
          <span>tier: {preview.tier}</span>
          <span>source: {preview.source}</span>
        </div>
        <div className="manual-override" aria-label="Manual override preview">
          <div className="manual-override-head"><strong>Manual override</strong><span>Local preview only; not saved or launched.</span></div>
          <div className="override-grid">
            <label className="override-field" htmlFor="command-role"><span>Role</span>
              <select id="command-role" className="form-input command-select" value={role} onChange={(event) => setRole(event.target.value as TaskActionRole)}>
                {roles.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
              </select>
            </label>
            <label className="override-field" htmlFor="command-model"><span>Model</span>
              <select id="command-model" className="form-input command-select" value={model} onChange={(event) => setModel(event.target.value as typeof model)}>
                <option value="gpt-5.6-luna">5.6 Luna</option><option value="gpt-5.6-terra">5.6 Terra</option><option value="gpt-5.6-sol">5.6 Sol</option>
              </select>
            </label>
            <label className="override-field" htmlFor="command-reasoning"><span>Reasoning</span>
              <select id="command-reasoning" className="form-input command-select" value={reasoning} onChange={(event) => setReasoning(event.target.value as typeof reasoning)}>
                <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
              </select>
            </label>
          </div>
          <div className="model-route-meta"><span>proposed: {role} · {model} · {reasoning}</span><span>not persisted</span></div>
        </div>
        <div className="model-route-reasons" aria-label="Routing explanation">
          <div className="routing-explanation-title">Why this route</div>
          {preview.reasons.map((reason) => (
            <div className="model-route-reason" key={reason.code}>
              <strong>{reason.label}</strong>
              <span>{reason.evidence}</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function Spark({ trends }: { trends: RunsTrendPoint[] }) {
  if (!trends.length) return <div style={{ color: '#5b6776', fontSize: 10 }}>no trend data</div>;
  const W = 100, H = 34;
  const line = (key: keyof RunsTrendPoint, color: string) => {
    const pts = sparkPolylinePoints(trends, key, W, H);
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
