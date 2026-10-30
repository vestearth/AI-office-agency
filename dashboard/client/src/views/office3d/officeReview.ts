import type { ActionKind, DecisionAction } from '../../../../shared/types';
import { runStatusLabel } from '../../../../shared/statusLabels';
import { PHASE_TO_ZONE, ZONE_COLORS } from '../commandZones';
import { statusTimeMs } from '../formatAge';
import type { OfficeTask } from './officeSelection';

/** The line holds this many waiting boxes. It equals `SCENE_DESK_LIMIT`, so the side list still reaches every box. */
export const REVIEW_LINE_CAP = 4;
/** Each decided spot and the side spots hold this many boxes or robots. */
export const REVIEW_SPOT_CAP = 2;
/** The box slide and the gate moment last about this long. Reduced motion and snap place with no slide. */
export const BOX_SLIDE_SECONDS = 0.9;
/** Neutral warm white, the Done light family. Never a status color. */
export const REVIEW_TAG_COLOR = '#f3ecdf';

const DAY_MS = 86_400_000;
/**
 * Belt, rack and shelf stand at waist height so a robot beside the line does not hide a box from the
 * default camera (about 32 degrees down): the box sits above the robot's sight line to the camera.
 */
const BELT_TOP = 0.5;
const RACK_TOP = 0.5;
const SHELF_TOP = 0.5;
const BIN_FLOOR = 0.04;
/** Tag origin above the box it hangs over. */
const TAG_RISE = 0.5;

export type PropBucket = 'wood' | 'metal' | 'fabric';

export interface ReviewProp {
  bucket: PropBucket;
  /** Room-local centre. y is height above the floor slab. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

const prop = (bucket: PropBucket, x: number, y: number, z: number, w: number, h: number, d: number): ReviewProp => ({
  bucket, x, y, z, w, h, d,
});

/**
 * Room-local Review layout, +z is the door. A conveyor runs along the back wall into an inspection
 * gate; a passed box rides on to the far end. The return rack stands at the start end, the shelf
 * and the bin beside the gate, and the side spots near the room front. Robots stand 0.53 or more
 * apart (a body is about 0.53 wide).
 */
export const REVIEW = {
  belt: { z: -1.38 },
  gate: { x: 0.95, z: -1.38 },
  /** Waiting boxes from the gate back to the start of the line, and the robot in front of each. */
  lineX: [0.5, -0.1, -0.7, -1.3],
  lineRobot: [{ x: 0.5, z: -0.84 }, { x: -0.1, z: -0.84 }, { x: -0.7, z: -0.84 }, { x: -1.3, z: -0.84 }],
  approve: [
    { box: { x: 1.22, z: -1.38 }, robot: { x: 1.15, z: -0.8 } },
    { box: { x: 1.78, z: -1.38 }, robot: { x: 1.72, z: -0.8 } },
  ],
  changes: [
    { box: { x: -1.78, z: -0.2 }, robot: { x: -1.23, z: -0.26 } },
    { box: { x: -1.78, z: 0.2 }, robot: { x: -1.33, z: 0.52 } },
  ],
  shelf: [
    { box: { x: 0.65, z: -0.35 }, robot: { x: 0.34, z: 0.21 } },
    { box: { x: 1.05, z: -0.35 }, robot: { x: 1.0, z: 0.11 } },
  ],
  bin: [
    { box: { x: 1.62, z: 0.45 }, robot: { x: 1.13, z: 0.74 } },
    { box: { x: 1.85, z: 0.68 }, robot: { x: 1.69, z: 1.15 } },
  ],
  side: [{ x: -0.6, z: 1.2 }, { x: 0.1, z: 1.2 }],
  /** Panel on the front post of the gate. The back-wall screen it replaces was 2.3 times a desk screen. */
  panel: { y: 0.8, z: -1.06, scale: 0.9 },
  props: [
    prop('metal', 0.025, 0.47, -1.38, 3.95, 0.06, 0.5),
    prop('fabric', 0.025, 0.505, -1.38, 3.9, 0.01, 0.34),
    ...[-1.9, 0, 1.9].flatMap((x) => [-1.55, -1.2].map((z) => prop('metal', x, 0.22, z, 0.06, 0.44, 0.06))),
    prop('metal', 0.95, 0.475, -1.66, 0.06, 0.95, 0.06),
    prop('metal', 0.95, 0.475, -1.1, 0.06, 0.95, 0.06),
    prop('metal', 0.95, 0.97, -1.38, 0.08, 0.06, 0.62),
    prop('wood', -1.78, 0.475, 0, 0.4, 0.05, 0.9),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => prop('wood', -1.78 + sx * 0.15, 0.225, sz * 0.4, 0.05, 0.45, 0.05))),
    prop('wood', 0.85, 0.475, -0.35, 0.95, 0.05, 0.4),
    prop('wood', 0.45, 0.225, -0.35, 0.05, 0.45, 0.36),
    prop('wood', 1.25, 0.225, -0.35, 0.05, 0.45, 0.36),
    prop('metal', 1.75, 0.015, 0.55, 0.62, 0.03, 0.6),
    prop('metal', 1.75, 0.14, 0.835, 0.62, 0.26, 0.03),
    prop('metal', 1.75, 0.14, 0.265, 0.62, 0.26, 0.03),
    prop('metal', 1.445, 0.14, 0.55, 0.03, 0.26, 0.6),
    prop('metal', 2.055, 0.14, 0.55, 0.03, 0.26, 0.6),
  ],
} as const;

export type ReviewKind = 'waiting' | 'decided' | 'other';
export type SpotKind = 'line' | 'approve' | 'changes' | 'shelf' | 'bin' | 'side';

export interface BoxPlace {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface ReviewSpot {
  kind: SpotKind;
  index: number;
  /** Null for the side spots: tasks that are not waiting for a decision get no box. */
  box: BoxPlace | null;
  robot: { x: number; z: number };
}

export interface ReviewEntry {
  task: OfficeTask;
  kind: ReviewKind;
  /** Whole days since the last status change; null without a time. */
  ageDays: number | null;
  overdue: { thresholdDays: number } | null;
  decision: DecisionAction | null;
  spot: ReviewSpot | null;
}

export interface ReviewTag {
  taskId: string;
  x: number;
  y: number;
  z: number;
}

export interface ReviewBoard {
  waiting: ReviewEntry[];
  decided: ReviewEntry[];
  others: ReviewEntry[];
  /** Tasks that still need a decision: the Review chip and the readout header. */
  waitingCount: number;
  tags: ReviewTag[];
}

/** When status.yaml last changed, as `statusTimeMs` reads it; null without a usable value. */
function changedAt(statusUpdatedAt: string | null | undefined): number | null {
  const at = statusUpdatedAt ? statusTimeMs(statusUpdatedAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * The server's `idle` formula: whole days since status.yaml changed. A date-only value counts from
 * local midnight, as `statusTimeMs` reads it and the server reads it in the office time zone.
 */
export function reviewAgeDays(statusUpdatedAt: string | null | undefined, now: Date): number | null {
  const at = changedAt(statusUpdatedAt);
  if (at === null) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

export function reviewKindOf(task: OfficeTask): ReviewKind {
  if (task.decisionPending && task.latestDecision) return 'decided';
  if (task.needsReview && !task.decisionPending) return 'waiting';
  return 'other';
}

function byOldest(a: OfficeTask, b: OfficeTask): number {
  const left = changedAt(a.statusUpdatedAt) ?? Infinity;
  const right = changedAt(b.statusUpdatedAt) ?? Infinity;
  if (left !== right) return left < right ? -1 : 1;
  return a.taskId.localeCompare(b.taskId);
}

function decidedAt(task: OfficeTask): number {
  const at = task.latestDecision ? Date.parse(task.latestDecision.decidedAt) : NaN;
  return Number.isFinite(at) ? at : Infinity;
}

const DECIDED_SPOTS: Record<DecisionAction, { kind: Exclude<SpotKind, 'line' | 'side'>; places: readonly { box: { x: number; z: number }; robot: { x: number; z: number } }[]; y: number }> = {
  approve: { kind: 'approve', places: REVIEW.approve, y: BELT_TOP },
  request_changes: { kind: 'changes', places: REVIEW.changes, y: RACK_TOP },
  escalate: { kind: 'shelf', places: REVIEW.shelf, y: SHELF_TOP },
  reject: { kind: 'bin', places: REVIEW.bin, y: BIN_FLOOR },
};

/** A tiny fixed turn per place, so a row of boxes does not look machine-ruled. */
const turn = (index: number): number => (index % 2 === 0 ? 0.08 : -0.1);

/**
 * Everything the Review room shows, derived from the tasks. Waiting boxes sit on the line, the
 * longest wait at the gate; decided boxes leave at once for the place of their decision; the rest
 * get a side spot and no box. `now` only feeds the age and the overdue tags, never the order.
 */
export function reviewBoard(tasks: readonly OfficeTask[], now: Date): ReviewBoard {
  const inRoom = tasks.filter((task) => task.phase != null && PHASE_TO_ZONE.get(task.phase) === 'review');
  const entry = (task: OfficeTask, kind: ReviewKind): ReviewEntry => ({
    task,
    kind,
    ageDays: reviewAgeDays(task.statusUpdatedAt, now),
    overdue: kind === 'waiting' && task.idle ? { thresholdDays: task.idle.thresholdDays } : null,
    decision: kind === 'decided' ? task.latestDecision?.decision ?? null : null,
    spot: null,
  });
  const waiting = inRoom.filter((task) => reviewKindOf(task) === 'waiting').sort(byOldest).map((task) => entry(task, 'waiting'));
  const decided = inRoom
    .filter((task) => reviewKindOf(task) === 'decided')
    .sort((a, b) => decidedAt(a) - decidedAt(b) || a.taskId.localeCompare(b.taskId))
    .map((task) => entry(task, 'decided'));
  const others = inRoom
    .filter((task) => reviewKindOf(task) === 'other')
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => entry(task, 'other'));

  waiting.slice(0, REVIEW_LINE_CAP).forEach((item, index) => {
    const x = REVIEW.lineX[index];
    item.spot = {
      kind: 'line',
      index,
      box: { x, y: BELT_TOP, z: REVIEW.belt.z, rotY: turn(index) },
      robot: REVIEW.lineRobot[index],
    };
  });
  const used = new Map<DecisionAction, number>();
  for (const item of decided) {
    const decision = item.decision;
    if (!decision) continue;
    const taken = used.get(decision) ?? 0;
    const group = DECIDED_SPOTS[decision];
    if (taken >= REVIEW_SPOT_CAP || !group.places[taken]) continue;
    used.set(decision, taken + 1);
    const place = group.places[taken];
    item.spot = {
      kind: group.kind,
      index: taken,
      box: { x: place.box.x, y: group.y, z: place.box.z, rotY: turn(taken + 1) },
      robot: place.robot,
    };
  }
  others.slice(0, REVIEW_SPOT_CAP).forEach((item, index) => {
    item.spot = { kind: 'side', index, box: null, robot: REVIEW.side[index] };
  });

  const tags: ReviewTag[] = [];
  for (const item of waiting) {
    if (item.overdue && item.spot?.box) {
      tags.push({ taskId: item.task.taskId, x: item.spot.box.x, y: item.spot.box.y + TAG_RISE, z: item.spot.box.z });
    }
  }
  return { waiting, decided, others, waitingCount: waiting.length, tags };
}

/** Review tasks in line order: waiting by age, then decided, then the rest. The side list walks this order. */
export function reviewOrder(tasks: readonly OfficeTask[]): OfficeTask[] {
  const board = reviewBoard(tasks, new Date(0));
  return [...board.waiting, ...board.decided, ...board.others].map((item) => item.task);
}

export interface ReviewStandingSlot {
  taskId: string;
  /** Room-local. */
  x: number;
  z: number;
}

/** Where each robot of the room stands. A task without a box or a side spot has no robot. */
export function reviewStanding(tasks: readonly OfficeTask[]): ReviewStandingSlot[] {
  const board = reviewBoard(tasks, new Date(0));
  return [...board.waiting, ...board.decided, ...board.others].flatMap((item) => (
    item.spot ? [{ taskId: item.task.taskId, x: item.spot.robot.x, z: item.spot.robot.z }] : []
  ));
}

export interface ReadoutLine {
  taskId: string;
  /** What the line says after the task id (age, decision, or the Attention label). */
  detail: string;
  /** The whole line as plain text. */
  text: string;
  /** `over 7d` on a waiting task past its threshold. */
  badge: string | null;
  /** A waiting or decided line opens the panel. */
  clickable: boolean;
}

export interface ReviewReadout {
  header: string;
  waiting: ReadoutLine[];
  decided: ReadoutLine[];
  othersHeading: string | null;
  others: ReadoutLine[];
  footer: string | null;
}

/** The labels Attention gives these action kinds (`ACTION_META` in ReviewView). */
const OTHER_LABEL: Partial<Record<ActionKind, string>> = {
  completion_held: 'Completion held',
  authorization_required: 'Authorization required',
  gates_unreadable: 'Gate unreadable',
  workflow_exception: 'Workflow exceptions',
  artifact_drift: 'Artifact drift',
  check_due: 'Check due',
  stale_work: 'Stale work',
};

function heldGates(task: OfficeTask): string | null {
  const gates = task.gates;
  if (task.latestDecision?.decision !== 'approve' || !gates || !gates.readable || gates.total <= 0) return null;
  return gates.resolved < gates.total ? `gates ${gates.resolved}/${gates.total}` : null;
}

export function reviewReadout(board: ReviewBoard, _now: Date): ReviewReadout {
  const line = (taskId: string, detail: string, badge: string | null, clickable: boolean): ReadoutLine => ({
    taskId, detail, text: `${taskId} · ${detail}`, badge, clickable,
  });
  const waiting = board.waiting.map((item) => line(
    item.task.taskId,
    item.ageDays == null ? '–' : `${item.ageDays}d`,
    item.overdue ? `over ${item.overdue.thresholdDays}d` : null,
    true,
  ));
  const decided = board.decided.map((item) => line(
    item.task.taskId,
    ['decided', item.decision, heldGates(item.task)].filter(Boolean).join(' · '),
    null,
    true,
  ));
  const others = board.others.map((item) => line(
    item.task.taskId,
    (item.task.actionKind && OTHER_LABEL[item.task.actionKind]) || 'Needs attention',
    null,
    false,
  ));
  return {
    header: `awaiting review · ${board.waitingCount}`,
    waiting,
    decided,
    othersHeading: others.length > 0 ? 'not waiting for a decision' : null,
    others,
    footer: waiting.length + decided.length > 0 ? 'click a task to decide' : null,
  };
}

export type ReviewVia = 'box' | 'readout' | 'card' | 'list';
export type ReviewIntent = 'panel' | 'card' | 'select';

/**
 * What a click on a Review task does. A box, a readout line and the card button open the decision
 * panel for waiting and decided tasks (a decided one again, to correct it). Other kinds show the
 * card with Open in Monitor. The side list only selects, so arrow keys never pop a modal.
 */
export function reviewClickIntent(task: OfficeTask, via: ReviewVia): ReviewIntent {
  if (via === 'list') return 'select';
  return reviewKindOf(task) === 'other' ? 'card' : 'panel';
}

/** Panel status chip in Command's vocabulary: the run's label, amber while a decision is due. */
export function reviewPanelStatus(task: OfficeTask): { label: string; color: string } {
  return {
    label: runStatusLabel(task.status, task.phase),
    color: task.needsReview ? ZONE_COLORS.amber : ZONE_COLORS.gray,
  };
}

export interface BoxTarget {
  taskId: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Extra height at mid-slide, for a box lifted onto the rack, shelf or bin. */
  lift: number;
}

export interface BoxState {
  taskId: string;
  /** Where the box is drawn. */
  x: number;
  y: number;
  z: number;
  rotY: number;
  from: { x: number; y: number; z: number };
  to: BoxTarget;
  t: number;
  sliding: boolean;
}

const ease = (t: number): number => t * t * (3 - 2 * t);

function settled(target: BoxTarget): BoxState {
  return {
    taskId: target.taskId,
    x: target.x,
    y: target.y,
    z: target.z,
    rotY: target.rotY,
    from: { x: target.x, y: target.y, z: target.z },
    to: target,
    t: 1,
    sliding: false,
  };
}

/**
 * One animation step for the boxes. A box that is new, or any box while `snap` is set (first load,
 * a hidden tab, a stream gap, reduced motion), is placed with no slide; otherwise it slides to its
 * new place over `BOX_SLIDE_SECONDS`. Boxes no longer in `targets` are dropped.
 */
export function stepBoxes(
  previous: ReadonlyMap<string, BoxState>,
  targets: readonly BoxTarget[],
  options: { snap: boolean; dt: number },
): Map<string, BoxState> {
  const next = new Map<string, BoxState>();
  for (const target of targets) {
    const before = previous.get(target.taskId);
    if (!before || options.snap) {
      next.set(target.taskId, settled(target));
      continue;
    }
    const moved = before.to.x !== target.x || before.to.y !== target.y || before.to.z !== target.z;
    const from = moved ? { x: before.x, y: before.y - liftAt(before), z: before.z } : before.from;
    const t = Math.min(1, (moved ? 0 : before.t) + Math.max(0, options.dt) / BOX_SLIDE_SECONDS);
    const e = ease(t);
    const lift = target.lift * Math.sin(Math.PI * e);
    next.set(target.taskId, {
      taskId: target.taskId,
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e + lift,
      z: from.z + (target.z - from.z) * e,
      rotY: target.rotY,
      from,
      to: target,
      t,
      sliding: t < 1,
    });
  }
  return next;
}

function liftAt(state: BoxState): number {
  return state.to.lift * Math.sin(Math.PI * ease(state.t));
}
