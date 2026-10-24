import { WAIT_KIND_LABEL, isWaitKind, type WaitKind } from '../../../../shared/waitKinds';
import { PHASE_TO_ZONE, ZONE_BY_ID } from '../commandZones';
import { isShellCommand } from '../CommandCopy';
import type { OfficeTask } from './officeSelection';

/** Seats of the waiting room. The Earth queue fills the chairs, the bench holds the others. */
export const CHAIR_COUNT = 4;
export const BENCH_COUNT = 3;
/** Most lit bars the queue board shows. The readout and the chip carry the real number. */
export const BAR_CAP = 8;

/**
 * Room-local layout of the waiting room, +z is the open front. Chairs face the queue board on the
 * back wall, the bench sits near the front, the clock hangs on the back wall and the closed door
 * on the left wall. A robot sits 0.04 behind its chair, the way a desk robot does.
 */
export const BLOCKED = {
  chairs: [
    { x: -1.2, z: -0.4 },
    { x: -0.4, z: -0.4 },
    { x: 0.4, z: -0.4 },
    { x: 1.2, z: -0.4 },
  ],
  bench: [
    { x: -0.7, z: 0.82 },
    { x: 0, z: 0.82 },
    { x: 0.7, z: 0.82 },
  ],
  /** The robot sits this far behind the chair's own position. */
  seatOffsetZ: 0.04,
  /**
   * A chair robot leaves by the aisle between the chair row and the bench, out a side lane clear of
   * the bench ends, then to the room front. A bench robot steps straight forward first, so it does
   * not brush its neighbours.
   */
  lane: { x: 1.62, rowZ: 0.22, frontZ: 1.45 },
  benchFrame: { x: 0, z: 0.82, stretch: [5, 1.7, 2.5] as const },
  board: { x: 0, y: 0.7, z: -1.62, w: 2.1, h: 0.56, d: 0.05 },
  bars: { y: 0.7, z: -1.58, w: 0.14, h: 0.34, d: 0.03, pitch: 0.22 },
  clock: { x: -1.62, y: 0.78, z: -1.64, r: 0.19, d: 0.04 },
  door: { x: -2.04, y: 0.42, z: -0.62, w: 0.06, h: 0.84, d: 0.56 },
} as const;

/** Warm neutral white of the queue bars. Never the amber status color of the room. */
export const BAR_COLOR = '#f3ecdf';

/** The short label of each wait in the readout. The card uses the full `WAIT_KIND_LABEL` text. */
export const SHORT_WAIT: Record<WaitKind | 'authorization_required', string> = {
  prod_run: 'prod run',
  operator_decision: 'decision',
  operator_approval: 'approval',
  authorization_required: 'grant',
  aws_permission: 'AWS permission',
  qa: 'QA',
  external: 'external party',
};

const EARTH_KINDS: readonly WaitKind[] = ['prod_run', 'operator_decision', 'operator_approval'];
const OTHER_KINDS: readonly WaitKind[] = ['aws_permission', 'qa', 'external'];
const UNRECORDED = 'wait not recorded';
const DAY_MS = 86_400_000;

export type WaitSide = 'earth' | 'others';

export interface WaitLine {
  taskId: string;
  title: string;
  /** The task's own room, from its phase. */
  roomId: string;
  /** Room name for a task outside the Blocked room, else null. */
  roomTag: string | null;
  side: WaitSide;
  /** False for a Blocked task that has no wait recorded. */
  recorded: boolean;
  /** Short wait labels, joined. */
  label: string;
  /** Whole days since the last status change, or null when the date is missing. */
  days: number | null;
  /** The listed task this one waits on and nothing else, or null for a line of its own. */
  parentId: string | null;
  depth: number;
}

export interface WaitQueue {
  /** Waiting on Earth, readout order: longest wait first, a chained task right under its parent. */
  earth: WaitLine[];
  /** Waiting on others (and Blocked tasks with no wait recorded), same order. */
  others: WaitLine[];
}

interface Classified {
  side: WaitSide;
  recorded: boolean;
  /** Distinct short labels of the waits that put the task on this side. */
  labels: string[];
}

function kindsOf(task: OfficeTask): WaitKind[] {
  return (task.waitsOn ?? []).map((wait) => wait.kind).filter(isWaitKind);
}

/**
 * Which side a task waits on, from the structured fields only (`waitsOn` kinds and the action
 * kind), never from reason or command text. Null: not part of the queue by its own waits.
 */
function classify(task: OfficeTask): Classified | null {
  const kinds = kindsOf(task);
  const grant = task.actionKind === 'authorization_required';
  const earth = [
    ...EARTH_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => SHORT_WAIT[kind]),
    ...(grant ? [SHORT_WAIT.authorization_required] : []),
  ];
  if (earth.length > 0) return { side: 'earth', recorded: true, labels: earth };
  const others = OTHER_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => SHORT_WAIT[kind]);
  if (others.length > 0) return { side: 'others', recorded: true, labels: others };
  return null;
}

function roomOf(task: OfficeTask): string | null {
  return (task.phase && PHASE_TO_ZONE.get(task.phase)) || null;
}

/**
 * A date-only `updated_at` (every live task has one) is local midnight, not UTC midnight: the side
 * panel's "Oldest wait" reads it as midnight in the office time zone, which is the viewer's own.
 * A value with a time keeps the instant it names.
 */
export function timeOf(task: Pick<OfficeTask, 'statusUpdatedAt'>): number | null {
  if (!task.statusUpdatedAt) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.statusUpdatedAt);
  const at = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    : new Date(task.statusUpdatedAt).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Oldest first, a task with no date last, the task id settles ties. */
export function byWait(a: { at: number | null; taskId: string }, b: { at: number | null; taskId: string }): number {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at;
  }
  return a.taskId.localeCompare(b.taskId);
}

interface Entry {
  task: OfficeTask;
  roomId: string;
  side: WaitSide;
  recorded: boolean;
  labels: string[];
  at: number | null;
}

/** The one listed task a task waits on and nothing else, or null. A task with a grant has its own wait. */
function soleRef(task: OfficeTask, group: ReadonlyMap<string, Entry>): string | null {
  const waits = task.waitsOn ?? [];
  if (waits.length === 0 || task.actionKind === 'authorization_required') return null;
  const refs = new Set(waits.map((wait) => wait.ref ?? ''));
  if (refs.size !== 1) return null;
  const [ref] = [...refs];
  return ref && ref !== task.taskId && group.has(ref) ? ref : null;
}

/** Drop the parent link of the oldest task in every cycle, so a pair that wait on each other both stay listed. */
function breakCycles(parent: Map<string, string | null>, group: ReadonlyMap<string, Entry>): void {
  for (const start of parent.keys()) {
    const seen: string[] = [];
    let at: string | null = start;
    while (at && !seen.includes(at)) {
      seen.push(at);
      at = parent.get(at) ?? null;
    }
    if (!at) continue;
    const loop = seen.slice(seen.indexOf(at)).map((taskId) => group.get(taskId)!);
    const root = loop.map((entry) => ({ at: entry.at, taskId: entry.task.taskId })).sort(byWait)[0];
    parent.set(root.taskId, null);
  }
}

function lineOf(entry: Entry, parentId: string | null, depth: number, now: number): WaitLine {
  const roomId = entry.roomId;
  return {
    taskId: entry.task.taskId,
    title: entry.task.title,
    roomId,
    roomTag: roomId === 'blocked' ? null : ZONE_BY_ID.get(roomId)?.label ?? roomId,
    side: entry.side,
    recorded: entry.recorded,
    label: entry.labels.join(', '),
    days: entry.at === null ? null : Math.max(0, Math.floor((now - entry.at) / DAY_MS)),
    parentId,
    depth,
  };
}

function layoutGroup(entries: Entry[], now: number): WaitLine[] {
  const group = new Map(entries.map((entry) => [entry.task.taskId, entry]));
  const parent = new Map<string, string | null>(entries.map((entry) => [entry.task.taskId, soleRef(entry.task, group)]));
  breakCycles(parent, group);
  const kids = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = parent.get(entry.task.taskId) ?? null;
    kids.set(key, [...(kids.get(key) ?? []), entry]);
  }
  const out: WaitLine[] = [];
  const walk = (key: string | null, depth: number) => {
    const list = (kids.get(key) ?? []).sort((a, b) => byWait({ at: a.at, taskId: a.task.taskId }, { at: b.at, taskId: b.task.taskId }));
    for (const entry of list) {
      out.push(lineOf(entry, key, depth, now));
      walk(entry.task.taskId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Everything that waits on Earth, from any room, then the Blocked room's tasks that wait on someone
 * else. A finished task is never listed. A Blocked task with no wait recorded is "wait not
 * recorded" among the others; a task in another room that waits only on others is left out.
 */
export function buildWaitQueue(tasks: readonly OfficeTask[], now: number): WaitQueue {
  const earth: Entry[] = [];
  const others: Entry[] = [];
  for (const task of tasks) {
    const roomId = roomOf(task);
    const zone = roomId ? ZONE_BY_ID.get(roomId) : undefined;
    if (!roomId || !zone || zone.kind === 'terminal') continue;
    const found = classify(task);
    const at = timeOf(task);
    if (found?.side === 'earth') {
      earth.push({ task, roomId, side: 'earth', recorded: true, labels: found.labels, at });
    } else if (roomId === 'blocked') {
      others.push({
        task,
        roomId,
        side: 'others',
        recorded: found !== null,
        labels: found ? found.labels : [UNRECORDED],
        at,
      });
    }
  }
  return { earth: layoutGroup(earth, now), others: layoutGroup(others, now) };
}

/** Every listed line, the Earth queue first. */
export function queueLines(queue: WaitQueue): WaitLine[] {
  return [...queue.earth, ...queue.others];
}

export interface BlockedSeating {
  /** Blocked tasks waiting on Earth that sit on a chair, longest wait first. */
  chairs: string[];
  /** Blocked tasks waiting on others that sit on the bench, longest wait first. */
  bench: string[];
}

/**
 * Who sits where. A Blocked task past its group's seats has no robot but stays listed. Order does
 * not depend on the clock, only on `statusUpdatedAt`, so a robot never re-seats because time passed.
 */
export function blockedSeating(tasks: readonly OfficeTask[]): BlockedSeating {
  const queue = buildWaitQueue(tasks, 0);
  const at = new Map(tasks.map((task) => [task.taskId, timeOf(task)]));
  const seatOrder = (lines: WaitLine[], limit: number) => lines
    .filter((line) => line.roomId === 'blocked')
    .map((line) => ({ taskId: line.taskId, at: at.get(line.taskId) ?? null }))
    .sort(byWait)
    .slice(0, limit)
    .map((item) => item.taskId);
  return {
    chairs: seatOrder(queue.earth, CHAIR_COUNT),
    bench: seatOrder(queue.others, BENCH_COUNT),
  };
}

/** The Blocked room's chip: tasks waiting on Earth from any room. Null (hidden) at zero. */
export function blockedChip(queue: WaitQueue): number | null {
  return queue.earth.length > 0 ? queue.earth.length : null;
}

/** Lit bars on the queue board: one per task waiting on Earth, up to the cap. */
export function boardBars(waitingOnEarth: number): number {
  return Math.min(BAR_CAP, Math.max(0, Math.floor(waitingOnEarth)));
}

/**
 * Which bars are lit while a bar goes out. `lit` is the settled count and `ghosts` the bars that
 * just went out; they blink off and on for `BLINK_STEPS` half-steps, then stay dark. Reduced motion
 * has no blink: the bar is just out.
 */
export const BLINK_STEPS = 6;
export const BLINK_STEP_MS = 140;

export function litBars(lit: number, ghosts: number, step: number, reducedMotion: boolean): number {
  if (reducedMotion || ghosts <= 0 || step >= BLINK_STEPS) return lit;
  return step % 2 === 0 ? lit + ghosts : lit;
}

export interface WaitCardModel {
  heading: 'Waiting on you' | 'Waiting on others' | 'Wait not recorded';
  days: number | null;
  /** Full wait text, e.g. "approval to run prod, an authorization grant". */
  detail: string;
  /** The task's own `recommendedAction`, only when it is a shell command. */
  command: string | null;
  /** The listed task this one waits on, for the "Go to" button. */
  goTo: string | null;
}

function fullLabels(task: OfficeTask, side: WaitSide): string[] {
  const kinds = kindsOf(task);
  const wanted = side === 'earth' ? EARTH_KINDS : OTHER_KINDS;
  return [
    ...wanted.filter((kind) => kinds.includes(kind)).map((kind) => WAIT_KIND_LABEL[kind]),
    ...(side === 'earth' && task.actionKind === 'authorization_required' ? ['an authorization grant'] : []),
  ];
}

/** What the selection card shows for a waiting task, or null when the task is not in the queue. */
export function waitCard(task: OfficeTask, queue: WaitQueue): WaitCardModel | null {
  const line = queueLines(queue).find((item) => item.taskId === task.taskId);
  if (!line) return null;
  const action = task.recommendedAction?.trim() ?? '';
  return {
    heading: line.side === 'earth' ? 'Waiting on you' : line.recorded ? 'Waiting on others' : 'Wait not recorded',
    days: line.days,
    detail: line.recorded ? fullLabels(task, line.side).join(', ') : '',
    command: action && isShellCommand(action) ? action : null,
    goTo: line.parentId,
  };
}

/** "9d", or a dash when the date is missing. */
export function waitDays(days: number | null): string {
  return days === null ? '—' : `${days}d`;
}
