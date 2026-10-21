import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewModelResponse, RunSummary } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { summarizeZones } from '../commandZones';
import { OfficeDetail, OfficeRoomList } from './OfficeSelectionPanel';
import { OfficeScene } from './OfficeScene';
import {
  commitOfficeKey,
  deskSelectionForTask,
  followTaskSelection,
  officeTasksFromApi,
  type OfficeSelection,
  type OfficeTask,
} from './officeSelection';

const STYLE = `
.o3d { height: 100%; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px;
  background: #0a0e14; color: #c9d4e3; font-family: ui-monospace, 'SF Mono', monospace; }
.o3d-rooms, .o3d-detail { min-height: 0; overflow: auto; border-color: #1e2733; background: #0d131b; }
.o3d-rooms { border-right: 1px solid #1e2733; padding: 10px; }
.o3d-detail { border-left: 1px solid #1e2733; padding: 12px; }
.o3d-help { margin: 0 0 10px; color: #7f8da0; font-size: 11px; line-height: 1.4; }
.o3d-zone { margin-bottom: 8px; }
.o3d-rooms button, .o3d-detail { font: inherit; }
.o3d-rooms button { width: 100%; display: flex; align-items: center; gap: 6px; text-align: left;
  background: #0f1620; color: #c9d4e3; border: 1px solid #1e2733; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.o3d-rooms button.on { border-color: #22d3ee; background: #11212e; }
.o3d-rooms button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
.o3d-desks { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0 12px; }
.o3d-desks button { font-size: 10px; color: #9aa8b8; }
.o3d-swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; display: block; }
.o3d-count, .o3d-mini { margin-left: auto; color: #7f8da0; font-size: 10px; }
.o3d-stage { position: relative; min-width: 0; min-height: 0; }
.o3d-stage canvas { display: block; }
.o3d-banner { position: absolute; left: 8px; bottom: 8px; margin: 0; padding: 4px 8px;
  background: rgba(5, 8, 13, 0.86); border: 1px solid #1e2733; border-radius: 6px; font-size: 11px; color: #9aa8b8; }
.o3d-detail h2 { margin: 0 0 4px; font-size: 14px; letter-spacing: 0.4px; color: #e6edf5; }
.o3d-kind, .o3d-empty { margin: 0 0 10px; color: #7f8da0; font-size: 11px; }
.o3d-detail ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.o3d-detail li { display: flex; flex-direction: column; gap: 2px; padding: 8px; background: #0f1620; border: 1px solid #1e2733; border-radius: 6px; }
.o3d-detail strong { color: #e6edf5; font-size: 12px; }
.o3d-title { color: #9aa8b8; font-size: 11px; }
.o3d-status { color: #22d3ee; font-size: 11px; }
.o3d-phase { color: #6b7888; font-size: 10px; }
.o3d-fallback { margin: 12px; color: #f59e0b; font-size: 12px; }
@media (max-width: 900px) {
  .o3d { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 26%) minmax(240px, 1fr) minmax(140px, 30%); }
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const selectionRef = useRef(selection);
  const tasksRef = useRef(tasks);
  const appliedRun = useRef<string | null>(null);
  selectionRef.current = selection;
  tasksRef.current = tasks;
  const stats = useMemo(() => summarizeZones(tasks), [tasks]);

  useEffect(() => {
    let active = true;
    const load = () => {
      Promise.all([
        apiFetchJson<ReviewModelResponse>('/api/review'),
        apiFetchJson<RunSummary[]>('/api/runs'),
      ]).then(([review, runs]) => {
        if (!active) return;
        setTasks(officeTasksFromApi(review.reviews, runs));
        setError(null);
        setLoading(false);
      }).catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Failed to load office tasks');
        setLoading(false);
      });
    };
    load();
    window.addEventListener('dashboard:refresh', load);
    return () => {
      active = false;
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
      <div className="o3d-stage">
        <SceneBoundary>
          <OfficeScene tasks={tasks} stats={stats} selection={selection} onSelect={setSelection} reducedMotion={reducedMotion} />
        </SceneBoundary>
        {loading && <p className="o3d-banner" role="status">Loading tasks…</p>}
        {error && <p className="o3d-banner" role="alert">{error}</p>}
      </div>
      <aside className="o3d-detail">
        <OfficeDetail tasks={tasks} stats={stats} selection={selection} />
      </aside>
    </div>
  );
}
