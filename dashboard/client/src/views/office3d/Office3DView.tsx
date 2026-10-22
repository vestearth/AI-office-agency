import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowInsights, ReviewModelResponse, RunSummary } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { ZONES, summarizeZones } from '../commandZones';
import { sparkPolylinePoints } from '../spark';
import { SCENE } from './officeLook';
import { officeSnapshotSettled } from './officeMove';
import { OfficeLiveBadge } from './officeLive';
import { OfficeDetail, OfficeRoomList } from './OfficeSelectionPanel';
import { OfficeScene } from './OfficeScene';
import {
  commitOfficeKey,
  describeOfficeSelection,
  deskSelectionForTask,
  followTaskSelection,
  officeTaskSummary,
  officeTasksFromApi,
  type OfficeSelection,
  type OfficeTask,
} from './officeSelection';

const STYLE = `
.o3d { height: 100%; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) 320px;
  background: #0a0e14; color: #c9d4e3; font-family: ui-monospace, 'SF Mono', monospace; }
.o3d-rooms, .o3d-detail { min-height: 0; overflow: auto; border-color: #1e2733; background: #0d131b; }
.o3d-rooms { border-right: 1px solid #1e2733; padding: 10px; }
.o3d-detail { border-left: 1px solid #1e2733; padding: 12px; }
.o3d-help { margin: 0 0 10px; color: #7f8da0; font-size: 11px; line-height: 1.4; }
.o3d-zone { margin-bottom: 8px; }
.o3d-rooms button, .o3d-detail { font: inherit; }
.o3d-rooms button { width: 100%; display: flex; align-items: center; gap: 6px; text-align: left;
  background: #0f1620; color: #c9d4e3; border: 1px solid #1e2733; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.o3d-rooms button.on { border-color: #c9d4e3; background: #11212e; }
.o3d-rooms button:focus-visible { outline: 2px solid #c9d4e3; outline-offset: 2px; }
.o3d-desks { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0 12px; }
.o3d-desks button { font-size: 12px; color: #9aa8b8; }
.o3d-swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; display: block; }
.o3d-count, .o3d-mini { margin-left: auto; color: #7f8da0; font-size: 12px; }
.o3d-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.o3d-stage canvas { display: block; width: 100%; height: 100%; }
.o3d-banner { position: absolute; left: 8px; bottom: 8px; margin: 0; padding: 4px 8px; z-index: 2;
  background: rgba(5, 8, 13, 0.86); border: 1px solid #1e2733; border-radius: 6px; font-size: 12px; color: #9aa8b8; }
.o3d-live { position: absolute; top: 8px; left: 8px; z-index: 2; margin: 0; padding: 4px 8px;
  background: rgba(5, 8, 13, 0.86); border: 1px solid #1e2733; border-radius: 6px; font-size: 12px; }
.o3d-label { position: absolute; left: 0; top: 0; z-index: 1; margin: 0; padding: 1px 4px;
  font-size: 12px; letter-spacing: 0.3px; color: #e6edf5; text-shadow: 0 1px 2px #000; pointer-events: none; white-space: nowrap; }
.o3d-card { position: absolute; left: 0; top: 0; z-index: 2; width: 220px; margin: 0; padding: 10px 12px;
  border-radius: 12px; color: #e6edf5; pointer-events: none;
  background: rgba(12, 18, 26, 0.72); border: 1px solid rgba(255,255,255,0.16);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.o3d-card strong { display: block; margin-bottom: 6px; font-size: 14px; }
.o3d-card p { margin: 0 0 4px; font-size: 12px; color: #c9d4e3; }
.o3d-office { margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid #1e2733; color: #e6edf5; }
.o3d-office p { margin: 0 0 4px; font-size: 13px; }
.o3d-spark { width: 100%; height: 28px; display: block; }
.o3d-detail h2 { margin: 0 0 4px; font-size: 16px; letter-spacing: 0.4px; color: #e6edf5; }
.o3d-kind, .o3d-empty { margin: 0 0 10px; color: #7f8da0; font-size: 13px; }
.o3d-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
.o3d-stats div { background: #0f1620; border: 1px solid #1e2733; border-radius: 8px; padding: 8px; }
.o3d-stats dt { margin: 0; color: #9aa8b8; font-size: 12px; }
.o3d-stats dd { margin: 2px 0 0; font-size: 18px; font-weight: 650; }
.o3d-detail ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.o3d-detail li { display: flex; flex-direction: column; gap: 2px; padding: 8px; background: #0f1620; border: 1px solid #1e2733; border-radius: 6px; }
.o3d-detail strong { color: #e6edf5; font-size: 13px; }
.o3d-title { color: #9aa8b8; font-size: 13px; }
.o3d-status { color: #e6edf5; font-size: 13px; }
.o3d-phase { color: #6b7888; font-size: 12px; }
.o3d-fallback { margin: 12px; color: #e6edf5; font-size: 13px; }
@media (max-width: 900px) {
  .o3d { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 26%) minmax(240px, 1fr) minmax(180px, 34%); }
  .o3d-rooms { border-right: 0; border-bottom: 1px solid #1e2733; }
  .o3d-detail { border-left: 0; border-top: 1px solid #1e2733; }
}
@media (prefers-reduced-motion: reduce) {
  .o3d-rooms button { transition: none; }
}
`;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

class SceneBoundary extends React.Component<{ children: React.ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : '3D view failed' };
  }

  render() {
    if (this.state.message) {
      return <p className="o3d-fallback" role="alert">3D view unavailable. Rooms and desks stay selectable from the list. {this.state.message}</p>;
    }
    return this.props.children;
  }
}

export default function Office3DView({ selectedTaskId = null }: { selectedTaskId?: string | null }) {
  const [tasks, setTasks] = useState<OfficeTask[]>([]);
  const [selection, setSelection] = useState<OfficeSelection | null>(null);
  const [flow, setFlow] = useState<FlowInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const visible = usePageVisible();
  const stageRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(selection);
  const tasksRef = useRef(tasks);
  const appliedRun = useRef<string | null>(null);
  selectionRef.current = selection;
  tasksRef.current = tasks;
  const stats = useMemo(() => summarizeZones(tasks), [tasks]);
  const detail = describeOfficeSelection(selection, tasks, stats);
  const days = flow?.throughput.days ?? [];
  const sparkMax = Math.max(1, ...days.map((day) => day.closed));
  const spark = days.length > 1 ? sparkPolylinePoints(days, 'closed', sparkMax, 120, 28) : '';

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      Promise.all([
        apiFetchJson<ReviewModelResponse>('/api/review', { signal }),
        apiFetchJson<RunSummary[]>('/api/runs', { signal }),
        apiFetchJson<FlowInsights>('/api/analytics/flow?days=7', { signal }).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return null;
        }),
      ]).then(([review, runs, nextFlow]) => {
        if (!active || signal.aborted) return;
        setTasks(officeTasksFromApi(review.reviews, runs));
        setFlow(nextFlow);
        setLoadedAt(new Date().toISOString());
        setError(null);
        setLoading(false);
      }).catch((reason: unknown) => {
        if (!active || signal.aborted) return;
        setError(reason instanceof Error ? reason.message : 'Failed to load office tasks');
        setLoading(false);
      });
    };
    load();
    window.addEventListener('dashboard:refresh', load);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener('dashboard:refresh', load);
    };
  }, []);

  useEffect(() => {
    setSelection((current) => followTaskSelection(current, tasks));
  }, [tasks]);

  useEffect(() => {
    if (!selectedTaskId) {
      appliedRun.current = null;
      return;
    }
    if (appliedRun.current === selectedTaskId) return;
    const next = deskSelectionForTask(selectedTaskId, tasks);
    if (!next) return;
    appliedRun.current = selectedTaskId;
    selectionRef.current = next;
    setSelection(next);
  }, [selectedTaskId, tasks]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const next = commitOfficeKey(selectionRef.current, event.key, tasksRef.current, event.currentTarget);
    if (!next) return;
    event.preventDefault();
    selectionRef.current = next;
    setSelection(next);
  };

  return (
    <div className="o3d">
      <style>{STYLE}</style>
      <aside className="o3d-rooms" onKeyDown={onKeyDown}>
        <OfficeRoomList tasks={tasks} stats={stats} selection={selection} onSelect={setSelection} />
      </aside>
      <div className="o3d-stage" ref={stageRef}>
        <SceneBoundary>
          <OfficeScene
            tasks={tasks}
            stats={stats}
            selection={selection}
            onSelect={setSelection}
            reducedMotion={reducedMotion}
            animate={!reducedMotion && visible}
            settled={officeSnapshotSettled(loadedAt)}
            labelRoot={stageRef}
            devopsActive={(stats.get('devops')?.count ?? 0) > 0}
          />
        </SceneBoundary>
        <OfficeLiveBadge failed={error != null} loadedAt={loadedAt} />
        {ZONES.map((zone) => (
          <p key={zone.id} className="o3d-label" data-label={zone.id} aria-hidden="true">{zone.label}</p>
        ))}
        {selection && (
          <div className="o3d-card" data-card role="region" aria-label={detail.heading}>
            <strong>{detail.heading}</strong>
            {detail.tasks.length === 0 ? <p>{detail.emptyLabel}</p> : detail.tasks.slice(0, 3).map((task) => (
              <p key={task.taskId}>{officeTaskSummary(task)}</p>
            ))}
            {detail.tasks.length > 3 && <p>+{detail.tasks.length - 3} more</p>}
          </div>
        )}
        {loading && <p className="o3d-banner" role="status">Loading tasks…</p>}
        {error && <p className="o3d-banner" role="alert">{error}</p>}
      </div>
      <aside className="o3d-detail">
        <div className="o3d-office">
          <p>Health {flow ? `${flow.health.score} ${flow.health.status}` : '—'}</p>
          <p>Open {flow ? flow.stuck.open : '—'} · Blocked {flow ? flow.stuck.blocked : '—'}</p>
          <p>Closed, 7 days {flow ? flow.throughput.closed : '—'}</p>
          {spark && (
            <svg className="o3d-spark" viewBox="0 0 120 28" role="img" aria-label="Tasks closed on each of the last 7 days">
              <polyline points={spark} fill="none" stroke={SCENE.spark} strokeWidth="1.6" />
            </svg>
          )}
        </div>
        <OfficeDetail tasks={tasks} stats={stats} selection={selection} waits={flow?.waits ?? []} />
      </aside>
    </div>
  );
}
