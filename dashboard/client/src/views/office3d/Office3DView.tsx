import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowInsights, ReviewModelResponse, ReviewSummary, RunSummary } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { readDashboardStream, subscribeDashboardStream } from '../../dashboardStream';
import { ZONE_BY_ID, ZONES, summarizeZones, zonePreview } from '../commandZones';
import { sparkPolylinePoints } from '../spark';
import { navigateTo } from '../../navigation';
import { QuickDecisionPanel } from '../QuickDecisionPanel';
import { SCENE, type DeskRowMap } from './officeLook';
import { abortedBoard, boardReason } from './officeAborted';
import { READOUT_FADE_MS, chipValue } from './officeLabels';
import { loungeReadout, msUntilNextLocalMidnight } from './officeLounge';
import { initialCatchUp, onStreamPhase } from './officeCatchUp';
import { officeSnapshotSettled } from './officeMove';
import { OfficeLiveBadge } from './officeLive';
import { OfficeDetail, OfficeRoomList } from './OfficeSelectionPanel';
import { OfficeScene } from './OfficeScene';
import { reviewBoard, reviewClickIntent, reviewPanelStatus, reviewReadout, type ReviewVia } from './officeReview';
import {
  commitOfficeKey,
  describeOfficeSelection,
  deskSelectionForTask,
  followTaskSelection,
  officeTaskSummary,
  officeTasksFromApi,
  tasksInZone,
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
.o3d-chip { position: absolute; left: 100%; top: 50%; transform: translateY(-50%); box-sizing: border-box; min-width: 18px; height: 18px;
  margin-left: 2px; padding: 0 5px; border-radius: 9px; background: rgba(8, 12, 18, 0.86); border: 1px solid rgba(216, 218, 221, 0.4);
  color: #d8dadd; font-size: 10px; line-height: 16px; text-align: center; text-shadow: none; }
.o3d-readout { opacity: 0; visibility: hidden; transition: opacity ${READOUT_FADE_MS}ms ease, visibility 0s linear ${READOUT_FADE_MS}ms; }
.o3d-readout[data-show="1"] { opacity: 1; visibility: visible; transition: opacity ${READOUT_FADE_MS}ms ease; }
.o3d-tv { position: absolute; left: 0; top: 0; z-index: 1; box-sizing: border-box; width: 108px; margin: 0; padding: 3px 5px;
  background: rgba(8, 12, 18, 0.86); border: 1px solid rgba(243, 236, 223, 0.4); border-radius: 4px;
  color: #f3ecdf; pointer-events: none; font-size: 10px; line-height: 1.3; }
.o3d-tv p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.o3d-tv.on { border-color: #f3ecdf; box-shadow: 0 0 12px rgba(243, 236, 223, 0.45); }
.o3d-board { position: absolute; left: 0; top: 0; z-index: 1; box-sizing: border-box; width: 220px; max-width: 220px; margin: 0; padding: 3px 6px;
  background: rgba(8, 12, 18, 0.86); border: 1px solid rgba(216, 218, 221, 0.35); border-radius: 4px;
  color: #d8dadd; pointer-events: none; font-size: 10px; line-height: 1.3; }
.o3d-board p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.o3d-board .reason { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #aeb2b8; }
.o3d-card { position: absolute; left: 0; top: 0; z-index: 2; width: 220px; margin: 0; padding: 10px 12px;
  border-radius: 12px; color: #e6edf5; pointer-events: none;
  background: rgba(12, 18, 26, 0.72); border: 1px solid rgba(255,255,255,0.16);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
.o3d-rv { position: absolute; left: 0; top: 0; z-index: 1; box-sizing: border-box; width: 230px; max-height: 300px; overflow-y: auto; margin: 0; padding: 4px 6px;
  background: rgba(8, 12, 18, 0.9); border: 1px solid rgba(216, 218, 221, 0.35); border-radius: 4px; color: #d8dadd; font-size: 10px; line-height: 1.3; }
.o3d-rv p { margin: 0; }
.o3d-rv .rv-head { color: #f3ecdf; font-weight: 600; }
.o3d-rv .rv-sub { margin-top: 4px; color: #8e949c; }
.o3d-rv .rv-foot { margin-top: 4px; color: #8e949c; font-style: italic; }
.o3d-rv .rv-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; box-sizing: border-box; margin: 0; padding: 2px 3px;
  font: inherit; color: inherit; text-align: left; background: none; border: 0; border-radius: 3px; cursor: pointer; }
.o3d-rv .rv-line:hover, .o3d-rv .rv-line.on { background: rgba(243, 236, 223, 0.12); }
.o3d-rv .rv-line:focus-visible { outline: 2px solid #f3ecdf; outline-offset: -1px; }
.o3d-rv .rv-badge { flex: none; padding: 0 4px; border: 1px solid rgba(243, 236, 223, 0.55); border-radius: 3px; color: #f3ecdf; font-style: normal; }
.o3d-card strong { display: block; margin-bottom: 6px; font-size: 14px; }
.o3d-card-actions { margin-top: 6px; pointer-events: auto; }
.o3d-card-actions button { font: inherit; font-size: 12px; color: #e6edf5; background: rgba(243, 236, 223, 0.14); border: 1px solid rgba(243, 236, 223, 0.5);
  border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.o3d-card-actions button:hover { background: rgba(243, 236, 223, 0.24); }
.o3d-card-actions button:focus-visible { outline: 2px solid #f3ecdf; outline-offset: 2px; }
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
  .o3d-rooms button, .o3d-readout, .o3d-readout[data-show="1"] { transition: none; }
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

function useOfficeClock(visible: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (visible) setNow(new Date());
  }, [visible]);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(new Date()), msUntilNextLocalMidnight(now));
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
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
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [reviewNow, setReviewNow] = useState(() => new Date());
  const [panelTaskId, setPanelTaskId] = useState<string | null>(null);
  const [deskRows, setDeskRows] = useState<DeskRowMap | null>(null);
  const deskRowsRef = useRef<DeskRowMap | null>(null);
  deskRowsRef.current = deskRows;
  const reducedMotion = usePrefersReducedMotion();
  const visible = usePageVisible();
  const [streamOpen, setStreamOpen] = useState(() => readDashboardStream() === 'open');
  const [awaitingReload, setAwaitingReload] = useState(false);
  const catchRef = useRef(initialCatchUp(readDashboardStream() === 'open'));
  useEffect(() => subscribeDashboardStream((phase) => {
    const open = phase === 'open';
    setStreamOpen(open);
    const step = onStreamPhase(catchRef.current, open);
    catchRef.current = step.state;
    if (step.reload) {
      setAwaitingReload(true);
      window.dispatchEvent(new Event('dashboard:refresh'));
    }
  }), []);
  const now = useOfficeClock(visible);
  const stageRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(selection);
  const tasksRef = useRef(tasks);
  const appliedRun = useRef<string | null>(null);
  selectionRef.current = selection;
  tasksRef.current = tasks;
  const stats = useMemo(() => summarizeZones(tasks), [tasks]);
  const readout = useMemo(() => {
    const zone = ZONE_BY_ID.get('done');
    const inZone = tasksInZone('done', tasks, stats);
    const ordered = zone ? zonePreview(zone, inZone, inZone.length || 1) : [];
    return loungeReadout(flow, ordered.map((task) => task.taskId), now);
  }, [flow, tasks, stats, now]);
  const board = useMemo(() => abortedBoard(tasks), [tasks]);
  // Ages count from the moment the data was read, the way the server counted `idle`.
  const review = useMemo(() => reviewBoard(tasks, reviewNow), [tasks, reviewNow]);
  const reviewView = useMemo(() => reviewReadout(review, reviewNow), [review, reviewNow]);
  const detail = describeOfficeSelection(selection, tasks, stats);
  const tvHot = selection?.kind === 'desk'
    && selection.zoneId === 'done'
    && selection.taskId != null
    && selection.taskId !== readout.tableTaskId;
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
        setReviews(review.reviews);
        setReviewNow(new Date());
        setFlow(nextFlow);
        setLoadedAt(new Date().toISOString());
        setError(null);
        setLoading(false);
        setAwaitingReload(false);
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

  // A box or a readout line selects the task and, for one that waits on a decision, opens the panel.
  const pickReview = (taskId: string, via: ReviewVia) => {
    const task = tasksRef.current.find((item) => item.taskId === taskId);
    if (!task) return;
    const next: OfficeSelection = { kind: 'desk', zoneId: 'review', taskId };
    selectionRef.current = next;
    setSelection(next);
    if (reviewClickIntent(task, via) === 'panel') setPanelTaskId(taskId);
  };

  const cardTask = selection?.kind === 'desk' && selection.zoneId === 'review' && selection.taskId
    ? tasks.find((item) => item.taskId === selection.taskId) ?? null
    : null;
  const cardDecides = cardTask != null && reviewClickIntent(cardTask, 'card') === 'panel';
  const panelTask = panelTaskId ? tasks.find((item) => item.taskId === panelTaskId) ?? null : null;
  const panelReview = panelTaskId ? reviews.find((item) => item.taskId === panelTaskId) ?? null : null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const next = commitOfficeKey(selectionRef.current, event.key, tasksRef.current, event.currentTarget, deskRowsRef.current);
    if (!next) return;
    event.preventDefault();
    selectionRef.current = next;
    setSelection(next);
  };

  return (
    <div className="o3d">
      <style>{STYLE}</style>
      <aside className="o3d-rooms" onKeyDown={onKeyDown}>
        <OfficeRoomList tasks={tasks} stats={stats} selection={selection} onSelect={setSelection} deskRows={deskRows} />
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
            deskRows={deskRows}
            onDeskRows={setDeskRows}
            closedToday={readout.closed ?? 0}
            tvHot={tvHot}
            pile={readout.pile}
            tableTaskId={readout.tableTaskId}
            streamOpen={streamOpen}
            awaitingReload={awaitingReload}
            reviewBoard={review}
            onReviewPick={(taskId) => pickReview(taskId, 'box')}
          />
        </SceneBoundary>
        <OfficeLiveBadge failed={error != null} loadedAt={loadedAt} />
        {ZONES.map((zone) => {
          const chip = chipValue(zone.id, {
            stats, closedToday: readout.closed ?? 0, abortedTotal: board.count, reviewWaiting: review.waitingCount,
          });
          return (
            <p key={zone.id} className="o3d-label" data-label={zone.id} data-chip={chip ?? undefined} aria-hidden="true">
              {zone.label}
              {chip != null && <span className="o3d-chip">{chip}</span>}
            </p>
          );
        })}
        <div className={tvHot ? 'o3d-tv o3d-readout on' : 'o3d-tv o3d-readout'} data-lounge-tv data-readout="done">
          <p>closed today {readout.label}</p>
          {readout.recentIds.map((id) => <p key={id}>{id}</p>)}
        </div>
        <div className="o3d-board o3d-readout" data-aborted-board data-readout="aborted">
          <p>aborted {board.count}</p>
          {board.latestId && <p>{board.latestId}</p>}
          {board.reason && <p className="reason">{boardReason(board.reason)}</p>}
        </div>
        <div className="o3d-rv o3d-readout" data-review-readout data-readout="review">
          <p className="rv-head">{reviewView.header}</p>
          {[...reviewView.waiting, ...reviewView.decided].map((line) => (
            <button type="button" key={line.taskId} className={`rv-line${selection?.kind === 'desk' && selection.taskId === line.taskId ? ' on' : ''}`}
              data-task={line.taskId} onClick={() => pickReview(line.taskId, 'readout')}>
              <span>{line.text}</span>
              {line.badge && <em className="rv-badge">{line.badge}</em>}
            </button>
          ))}
          {reviewView.othersHeading && <p className="rv-sub">{reviewView.othersHeading}</p>}
          {reviewView.others.map((line) => (
            <button type="button" key={line.taskId} className={`rv-line${selection?.kind === 'desk' && selection.taskId === line.taskId ? ' on' : ''}`}
              data-task={line.taskId} onClick={() => pickReview(line.taskId, 'readout')}>
              <span>{line.text}</span>
            </button>
          ))}
          {reviewView.footer && <p className="rv-foot">{reviewView.footer}</p>}
        </div>
        {selection && (
          <div className="o3d-card" data-card role="region" aria-label={detail.heading}>
            <strong>{detail.heading}</strong>
            {detail.tasks.length === 0 ? <p>{detail.emptyLabel}</p> : detail.tasks.slice(0, 3).map((task) => (
              <p key={task.taskId}>{officeTaskSummary(task)}</p>
            ))}
            {detail.tasks.length > 3 && <p>+{detail.tasks.length - 3} more</p>}
            {cardTask && (
              <div className="o3d-card-actions">
                {cardDecides ? (
                  <button type="button" onClick={() => setPanelTaskId(cardTask.taskId)} aria-label={`Review and decide ${cardTask.taskId}`}>
                    Review &amp; decide
                  </button>
                ) : (
                  <button type="button" onClick={() => navigateTo('monitor', cardTask.taskId)} aria-label={`Open ${cardTask.taskId} in Monitor`}>
                    Open in Monitor
                  </button>
                )}
              </div>
            )}
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
        <OfficeDetail tasks={tasks} stats={stats} selection={selection} waits={flow?.waits ?? []} closedTodayLabel={readout.label} />
      </aside>
      {panelTask && panelReview && (
        <QuickDecisionPanel
          review={panelReview}
          status={reviewPanelStatus(panelTask)}
          onClose={() => setPanelTaskId(null)}
          onDecided={() => {
            setPanelTaskId(null);
            window.dispatchEvent(new Event('dashboard:refresh'));
          }}
        />
      )}
    </div>
  );
}
