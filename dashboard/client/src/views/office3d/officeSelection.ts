import type { ReviewSummary, RunSummary } from '../../../../shared/types';
import { phaseLabel, runStatusLabel } from '../../../../shared/statusLabels';
import { PHASE_TO_ZONE, ZONE_BY_ID, ZONES, summarizeZones, zonePreview, type ZoneStat, type ZoneTask } from '../commandZones';
import type { DeskRowMap } from './officeLook';
import { characterOperator, lastOperatorLabel } from './officeOperator';
import { blockedSeating, buildWaitQueue, queueLines } from './officeBlocked';
import { escalationSeating } from './officeEscalation';
import { reviewOrder } from './officeReview';

/**
 * Desks drawn in the room and reachable from the keyboard.
 * The room detail still lists every task; anything past this limit is not a button.
 */
export const SCENE_DESK_LIMIT = 4;

export interface OfficeTask extends ZoneTask {
  title: string;
  /** Last history operator. Legacy `gemini` is stored as `antigravity`. */
  operator?: string;
  /** Read-model fields the Blocked room classifies by. Never parsed from text. */
  waitsOn?: ReviewSummary['waitsOn'];
  isReleaseTrain?: ReviewSummary['isReleaseTrain'];
  actionKind?: ReviewSummary['actionKind'];
  recommendedAction?: ReviewSummary['recommendedAction'];
  /** Latest human decision and whether it is still waiting to be applied (the Escalation room reads both). */
  latestDecision?: ReviewSummary['latestDecision'];
  decisionPending?: ReviewSummary['decisionPending'];
  /** Review room: the server's idle flag (past its threshold) and the completion-gate counts. */
  idle?: ReviewSummary['idle'];
  gates?: ReviewSummary['gates'];
  /** Times the task entered Debug Lab, from the server's history count. Never derived here. */
  debugRounds?: ReviewSummary['debugRounds'];
}

export type OfficeZoneStats = Map<string, ZoneStat<OfficeTask>>;

export type OfficeSelection =
  | { kind: 'room'; zoneId: string }
  | { kind: 'desk'; zoneId: string; taskId: string | null };

export interface OfficeDesk {
  key: string;
  zoneId: string;
  taskId: string | null;
  task: OfficeTask | null;
}

export interface OfficeTaskLine {
  taskId: string;
  /** Room name when the line is a Blocked-room entry whose task sits in another room. */
  roomTag?: string;
  title: string;
  statusLabel: string;
  phaseLabel: string;
  operator: string;
}

export interface OfficeSelectionDetail {
  heading: string;
  emptyLabel: string;
  tasks: OfficeTaskLine[];
}

/** Floor position of each zone room, in world units. Every `ZONES` id has one. */
export const ROOM_LAYOUT: Record<string, { x: number; z: number }> = {
  escalation: { x: -6, z: -7 },
  devops: { x: 0, z: -7 },
  debug: { x: 6, z: -7 },
  review: { x: -6, z: 0 },
  done: { x: 0, z: 0 },
  rejected: { x: 6, z: 0 },
  inbox: { x: -6, z: 7 },
  dev: { x: 0, z: 7 },
  aborted: { x: 6, z: 7 },
  blocked: { x: 0, z: 14 },
};

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function officeTasksFromApi(
  reviews: Array<Pick<ReviewSummary, 'taskId' | 'title' | 'phase' | 'needsReview'> & Partial<Pick<ReviewSummary, 'lastTransition' | 'statusUpdatedAt' | 'waitsOn' | 'isReleaseTrain' | 'actionKind' | 'recommendedAction' | 'latestDecision' | 'decisionPending' | 'idle' | 'gates' | 'debugRounds'>>>,
  runs: Array<Pick<RunSummary, 'id' | 'title' | 'status' | 'currentAgent' | 'updatedAt' | 'currentConductor'>>,
): OfficeTask[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  return reviews.map((review) => {
    const run = runById.get(review.taskId);
    return {
      taskId: review.taskId,
      title: run?.title || review.title || review.taskId,
      phase: review.phase,
      status: run?.status || 'unknown',
      needsReview: review.needsReview,
      currentAgent: run?.currentAgent,
      updatedAt: run?.updatedAt,
      operator: characterOperator(run?.currentConductor),
      lastTransition: review.lastTransition,
      statusUpdatedAt: review.statusUpdatedAt,
      waitsOn: review.waitsOn,
      isReleaseTrain: review.isReleaseTrain,
      actionKind: review.actionKind,
      recommendedAction: review.recommendedAction,
      latestDecision: review.latestDecision,
      decisionPending: review.decisionPending,
      idle: review.idle,
      gates: review.gates,
      debugRounds: review.debugRounds,
    };
  });
}

export function tasksInZone(zoneId: string, tasks: OfficeTask[], stats?: OfficeZoneStats): OfficeTask[] {
  return (stats ?? summarizeZones(tasks)).get(zoneId)?.tasks ?? [];
}

/** One desk per task in the zone (preview order). An empty room keeps a single empty desk. */
export function desksForZone(zoneId: string, tasks: OfficeTask[], stats?: OfficeZoneStats): OfficeDesk[] {
  const zone = ZONE_BY_ID.get(zoneId);
  if (!zone) return [];
  const inZone = tasksInZone(zoneId, tasks, stats);
  // Review is a line, not a row of desks: the longest wait first, then decided, then the rest.
  const ordered = zoneId === 'review' ? reviewOrder(inZone) : zonePreview(zone, inZone, inZone.length || 1);
  if (ordered.length === 0) {
    return [{ key: `${zoneId}:empty`, zoneId, taskId: null, task: null }];
  }
  return ordered.map((task) => ({ key: task.taskId, zoneId, taskId: task.taskId, task }));
}

export function sceneDesks(desks: OfficeDesk[]): OfficeDesk[] {
  const occupied = desks.filter((desk) => desk.taskId);
  if (occupied.length === 0) return desks.slice(0, 1);
  return occupied.slice(0, SCENE_DESK_LIMIT);
}

/** The Blocked room's seats instead of desks: the Earth queue's chairs, then the bench. */
function blockedSeats(tasks: OfficeTask[]): OfficeDesk[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seated = blockedSeating(tasks);
  const desks = [...seated.chairs, ...seated.bench].map((taskId) => ({
    key: taskId,
    zoneId: 'blocked',
    taskId,
    task: byId.get(taskId) ?? null,
  }));
  return desks.length > 0 ? desks : [{ key: 'blocked:empty', zoneId: 'blocked', taskId: null, task: null }];
}

/** The help desk's seats instead of desks: the desk, the bench, then the standing spots. */
function escalationSeats(tasks: OfficeTask[]): OfficeDesk[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seated = escalationSeating(tasks);
  const order = [...(seated.desk ? [seated.desk] : []), ...seated.bench, ...seated.standing];
  const desks = order.map((taskId) => ({ key: taskId, zoneId: 'escalation', taskId, task: byId.get(taskId) ?? null }));
  return desks.length > 0 ? desks : [{ key: 'escalation:empty', zoneId: 'escalation', taskId: null, task: null }];
}

/** Desks the side list and the keyboard walk. A held row wins over the live count. */
export function officeDesks(
  zoneId: string,
  tasks: OfficeTask[],
  stats?: OfficeZoneStats,
  rows?: DeskRowMap | null,
): OfficeDesk[] {
  if (zoneId === 'blocked') return blockedSeats(tasks);
  if (zoneId === 'escalation') return escalationSeats(tasks);
  const row = rows?.[zoneId];
  if (!row) return sceneDesks(desksForZone(zoneId, tasks, stats));
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  return row.map((slot) => ({
    key: slot.taskId ?? `${zoneId}:empty`,
    zoneId,
    taskId: slot.taskId,
    task: slot.taskId ? (byId.get(slot.taskId) ?? null) : null,
  }));
}

function lineOf(task: OfficeTask): OfficeTaskLine {
  return {
    taskId: task.taskId,
    title: task.title,
    statusLabel: runStatusLabel(task.status, task.phase),
    phaseLabel: phaseLabel(task.phase),
    operator: characterOperator(task.operator),
  };
}

/** One line in the selection card: task, status, and the last operator. */
export function officeTaskSummary(task: OfficeTaskLine): string {
  const base = `${task.taskId} · ${task.statusLabel} · ${lastOperatorLabel(task.operator)}`;
  return task.roomTag ? `${base} · ${task.roomTag}` : base;
}

/** What the detail pane shows for the current room or desk. */
export function describeOfficeSelection(
  selection: OfficeSelection | null,
  tasks: OfficeTask[],
  stats?: OfficeZoneStats,
): OfficeSelectionDetail {
  if (!selection) {
    return { heading: '3D Office', emptyLabel: 'Select a room or a desk.', tasks: [] };
  }
  const label = ZONE_BY_ID.get(selection.zoneId)?.label ?? selection.zoneId;
  if (selection.kind === 'room' && selection.zoneId === 'blocked') {
    // The waiting room lists its queue in readout order: waiting on Earth from every room, then the others.
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const lines = queueLines(buildWaitQueue(tasks, Date.now())).flatMap((entry) => {
      const task = byId.get(entry.taskId);
      return task ? [{ ...lineOf(task), ...(entry.roomTag ? { roomTag: entry.roomTag } : {}) }] : [];
    });
    return { heading: label, emptyLabel: 'No tasks in this room.', tasks: lines };
  }
  if (selection.kind === 'room') {
    const zone = ZONE_BY_ID.get(selection.zoneId);
    const found = tasksInZone(selection.zoneId, tasks, stats);
    // A finished room lists its latest close first, the order the Command map and the Done TV use.
    const inZone = zone?.kind === 'terminal' ? zonePreview(zone, found, found.length || 1) : found;
    return {
      heading: label,
      emptyLabel: 'No tasks in this room.',
      tasks: inZone.map(lineOf),
    };
  }
  const task = selection.taskId
    ? tasksInZone(selection.zoneId, tasks, stats).find((item) => item.taskId === selection.taskId)
    : undefined;
  return {
    heading: `${label} desk`,
    emptyLabel: 'No task at this desk.',
    tasks: task ? [lineOf(task)] : [],
  };
}

/** Keyboard movement across rooms (up/down) and desks inside the current room (left/right). */
export function moveOfficeSelection(
  current: OfficeSelection | null,
  key: string,
  tasks: OfficeTask[],
  rows?: DeskRowMap | null,
): OfficeSelection | null {
  if (!NAV_KEYS.has(key)) return null;
  const ids = ZONES.map((zone) => zone.id);
  if (key === 'Home') return { kind: 'room', zoneId: ids[0] };
  if (key === 'End') return { kind: 'room', zoneId: ids[ids.length - 1] };
  if (!current) {
    if (key === 'ArrowDown' || key === 'ArrowRight') return { kind: 'room', zoneId: ids[0] };
    return null;
  }
  const index = Math.max(0, ids.indexOf(current.zoneId));
  if (key === 'ArrowDown') return { kind: 'room', zoneId: ids[(index + 1) % ids.length] };
  if (key === 'ArrowUp') return { kind: 'room', zoneId: ids[(index - 1 + ids.length) % ids.length] };
  const desks = officeDesks(current.zoneId, tasks, undefined, rows);
  if (key === 'ArrowRight') {
    if (current.kind === 'room' || current.taskId == null) {
      const first = desks[0];
      return first ? { kind: 'desk', zoneId: current.zoneId, taskId: first.taskId } : current;
    }
    const at = desks.findIndex((desk) => desk.taskId === current.taskId);
    const next = desks[Math.min(at < 0 ? 0 : at + 1, desks.length - 1)];
    return { kind: 'desk', zoneId: current.zoneId, taskId: next.taskId };
  }
  if (current.kind === 'desk' && current.taskId) {
    const at = desks.findIndex((desk) => desk.taskId === current.taskId);
    if (at > 0) return { kind: 'desk', zoneId: current.zoneId, taskId: desks[at - 1].taskId };
  }
  return { kind: 'room', zoneId: current.zoneId };
}

export function taskZoneId(task: OfficeTask): string | null {
  return (task.phase && PHASE_TO_ZONE.get(task.phase)) || null;
}

/** Desk selection for a `?run=` task, or null when that task is not on the board yet. */
export function deskSelectionForTask(taskId: string, tasks: OfficeTask[]): OfficeSelection | null {
  const task = tasks.find((item) => item.taskId === taskId);
  const zoneId = task ? taskZoneId(task) : null;
  if (!task || !zoneId) return null;
  return { kind: 'desk', zoneId, taskId: task.taskId };
}

/**
 * After a refresh, a selected desk follows its task into the new zone.
 * Returns the same selection when the task did not move.
 */
export function followTaskSelection(selection: OfficeSelection | null, tasks: OfficeTask[]): OfficeSelection | null {
  if (!selection || selection.kind !== 'desk' || !selection.taskId) return selection;
  const next = deskSelectionForTask(selection.taskId, tasks);
  if (!next || next.zoneId === selection.zoneId) return selection;
  return next;
}

export function selectionDomId(selection: OfficeSelection): string {
  if (selection.kind === 'room') return `office-room-${selection.zoneId}`;
  return `office-desk-${selection.zoneId}-${selection.taskId ?? 'empty'}`;
}

function cssIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

export function focusOfficeSelection(
  root: { querySelector(selector: string): { focus(): void } | null },
  selection: OfficeSelection,
): boolean {
  const el = root.querySelector(`#${cssIdent(selectionDomId(selection))}`);
  if (!el) return false;
  el.focus();
  return true;
}

/** Arrow-key step: update the selection and move DOM focus onto that room or desk. */
export function commitOfficeKey(
  current: OfficeSelection | null,
  key: string,
  tasks: OfficeTask[],
  root: { querySelector(selector: string): { focus(): void } | null },
  rows?: DeskRowMap | null,
): OfficeSelection | null {
  const next = moveOfficeSelection(current, key, tasks, rows);
  if (!next) return null;
  focusOfficeSelection(root, next);
  return next;
}
