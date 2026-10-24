import { formatAge } from '../formatAge';
import { boardReason } from './officeAborted';
import { byWait, timeOf } from './officeBlocked';
import { SCENE } from './officeLook';
import type { OfficeTask } from './officeSelection';

/** From this round on a task is looping: its tags brighten and its round badge is highlighted. */
export const LOOP_ROUND = 3;
/** Tags drawn beside one desk. The readout and the card carry the real number. */
export const ROUND_TAG_CAP = 8;

/**
 * Paint for the clinic pieces that need their own color. They are instances of the scene's
 * per-instance-color box (`geoms.rack` with `mats.paint`), which is never emissive, so nothing
 * here glows. Every color is near-neutral or far from the status hues (`loungeLightAllowed`).
 */
export const CLINIC_COLORS = {
  dummy: '#a9b6c4',
  dummyJoint: '#646a70',
  dummyFace: '#2c2f33',
  lampHead: '#a4abb2',
  tray: '#8a9198',
  tool: '#c9d0d6',
  toolDark: '#5a5e63',
  curtain: '#a3b8b0',
  sheet: '#c8bfae',
  bug: '#1c1b1a',
  tag: '#9a948a',
  tagLoop: '#fff5e3',
} as const;

export type ClinicPart = 'table' | 'dummy' | 'lamp' | 'tray' | 'cart' | 'curtain' | 'board';

/** A box in room-local space (+z is the door, +x the near wall). y is the box centre above the floor slab. */
export interface ClinicBox {
  part: ClinicPart;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** Plain pieces that join the merged decor. Never the lamp-shade bucket: that glows with DevOps. */
export interface ClinicFrameBox extends ClinicBox {
  bucket: 'wood' | 'metal' | 'fabric';
}

export interface ClinicPiece extends ClinicBox {
  color: string;
}

/**
 * Room-local clinic layout. The table, lamp, tray and cart stand in the back band behind the desk row
 * (desks at z 0.35, their back edge at about 0.13). The curtain stands in the front-left corner, clear
 * of the door-to-desk walks, and the bug board hangs on the left wall, which faces the camera.
 */
const TABLE = { x: -0.55, z: -1.08 };
const LAMP = { x: -0.72, z: -1.56 };
const TRAY = { x: 0.42, z: -1.22 };
const CART = { x: 1.05, z: -1.3 };
const CURTAIN = { x: -1.8, z0: 0.8, z1: 1.58 };
const BOARD = { x: -2.03, y: 0.68, z: -0.55, w: 0.04, h: 0.42, d: 0.72 };
/** Bug silhouettes on the board: (height, z) of each body. */
const BUGS: ReadonlyArray<readonly [number, number]> = [
  [0.8, -0.78], [0.8, -0.55], [0.8, -0.32], [0.58, -0.66], [0.58, -0.44],
];
const PAD_TOP = 0.475;
const PILLOW_TOP = 0.51;
const TRAY_TOP = 0.5125;

function box(part: ClinicPart, x: number, y: number, z: number, w: number, h: number, d: number): ClinicBox {
  return { part, x, y, z, w, h, d };
}

function frame(bucket: ClinicFrameBox['bucket'], item: ClinicBox): ClinicFrameBox {
  return { ...item, bucket };
}

function piece(color: string, item: ClinicBox): ClinicPiece {
  return { ...item, color };
}

function corners(cx: number, cz: number, dx: number, dz: number): Array<[number, number]> {
  return [[cx - dx, cz - dz], [cx + dx, cz - dz], [cx - dx, cz + dz], [cx + dx, cz + dz]];
}

const FRAME: ClinicFrameBox[] = [
  frame('metal', box('table', TABLE.x, 0.4, TABLE.z, 1.3, 0.05, 0.56)),
  ...corners(TABLE.x, TABLE.z, 0.6, 0.23).map(([x, z]) => frame('metal', box('table', x, 0.1875, z, 0.05, 0.375, 0.05))),
  frame('metal', box('table', TABLE.x, 0.1, TABLE.z, 1.2, 0.03, 0.04)),
  frame('fabric', box('table', TABLE.x, 0.45, TABLE.z, 1.24, 0.05, 0.5)),
  frame('fabric', box('table', TABLE.x - 0.48, 0.4925, TABLE.z, 0.22, 0.035, 0.36)),

  frame('metal', box('lamp', LAMP.x, 0.015, LAMP.z, 0.26, 0.03, 0.26)),
  frame('metal', box('lamp', LAMP.x, 0.52, LAMP.z, 0.04, 1.0, 0.04)),
  frame('metal', box('lamp', LAMP.x, 1.0, (LAMP.z + TABLE.z) / 2, 0.04, 0.04, TABLE.z - LAMP.z + 0.04)),
  frame('metal', box('lamp', LAMP.x, 0.965, TABLE.z, 0.05, 0.05, 0.05)),

  frame('metal', box('tray', TRAY.x, 0.01, TRAY.z, 0.2, 0.02, 0.2)),
  frame('metal', box('tray', TRAY.x, 0.25, TRAY.z, 0.035, 0.48, 0.035)),

  frame('metal', box('cart', CART.x, 0.09, CART.z, 0.42, 0.06, 0.34)),
  ...corners(CART.x, CART.z, 0.17, 0.13).map(([x, z]) => frame('metal', box('cart', x, 0.03, z, 0.05, 0.06, 0.05))),
  frame('metal', box('cart', CART.x, 0.45, CART.z - 0.08, 0.05, 0.66, 0.05)),
  frame('metal', box('cart', CART.x, 0.5, CART.z, 0.36, 0.03, 0.28)),
  frame('metal', box('cart', CART.x, 0.92, CART.z - 0.06, 0.46, 0.32, 0.06)),

  frame('metal', box('curtain', CURTAIN.x, 0.475, CURTAIN.z0, 0.035, 0.95, 0.035)),
  frame('metal', box('curtain', CURTAIN.x, 0.475, CURTAIN.z1, 0.035, 0.95, 0.035)),
  frame('metal', box('curtain', CURTAIN.x, 0.94, (CURTAIN.z0 + CURTAIN.z1) / 2, 0.03, 0.03, CURTAIN.z1 - CURTAIN.z0 + 0.035)),
  frame('metal', box('curtain', CURTAIN.x, 0.01, CURTAIN.z0, 0.24, 0.02, 0.04)),
  frame('metal', box('curtain', CURTAIN.x, 0.01, CURTAIN.z1, 0.24, 0.02, 0.04)),

  frame('wood', box('board', BOARD.x, BOARD.y, BOARD.z, BOARD.w, BOARD.h, BOARD.d)),
];

const BUG_X = BOARD.x + BOARD.w / 2 + 0.008;

const PIECES: ClinicPiece[] = [
  // The dummy lies on its back, head on the pillow (-x), feet up at the +x end.
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x - 0.48, PILLOW_TOP + 0.075, TABLE.z, 0.18, 0.15, 0.2)),
  piece(CLINIC_COLORS.dummyFace, box('dummy', TABLE.x - 0.48, PILLOW_TOP + 0.158, TABLE.z, 0.11, 0.016, 0.14)),
  piece(CLINIC_COLORS.dummyJoint, box('dummy', TABLE.x - 0.37, PAD_TOP + 0.055, TABLE.z, 0.06, 0.07, 0.08)),
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x - 0.17, PAD_TOP + 0.075, TABLE.z, 0.36, 0.15, 0.3)),
  piece(CLINIC_COLORS.dummyFace, box('dummy', TABLE.x - 0.17, PAD_TOP + 0.158, TABLE.z, 0.14, 0.016, 0.14)),
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x - 0.15, PAD_TOP + 0.04, TABLE.z - 0.2, 0.34, 0.08, 0.08)),
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x - 0.15, PAD_TOP + 0.04, TABLE.z + 0.2, 0.34, 0.08, 0.08)),
  piece(CLINIC_COLORS.dummyJoint, box('dummy', TABLE.x + 0.05, PAD_TOP + 0.055, TABLE.z, 0.1, 0.1, 0.24)),
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x + 0.29, PAD_TOP + 0.045, TABLE.z - 0.07, 0.38, 0.09, 0.1)),
  piece(CLINIC_COLORS.dummy, box('dummy', TABLE.x + 0.29, PAD_TOP + 0.045, TABLE.z + 0.07, 0.38, 0.09, 0.1)),
  piece(CLINIC_COLORS.dummyJoint, box('dummy', TABLE.x + 0.51, PAD_TOP + 0.08, TABLE.z - 0.07, 0.06, 0.16, 0.1)),
  piece(CLINIC_COLORS.dummyJoint, box('dummy', TABLE.x + 0.51, PAD_TOP + 0.08, TABLE.z + 0.07, 0.06, 0.16, 0.1)),

  piece(CLINIC_COLORS.lampHead, box('lamp', LAMP.x, 0.915, TABLE.z, 0.46, 0.06, 0.36)),

  piece(CLINIC_COLORS.tray, box('tray', TRAY.x, 0.5, TRAY.z, 0.38, 0.025, 0.26)),
  piece(CLINIC_COLORS.tool, box('tray', TRAY.x - 0.06, TRAY_TOP + 0.01, TRAY.z - 0.06, 0.2, 0.02, 0.03)),
  piece(CLINIC_COLORS.toolDark, box('tray', TRAY.x + 0.05, TRAY_TOP + 0.0125, TRAY.z + 0.05, 0.16, 0.025, 0.04)),
  piece(CLINIC_COLORS.tool, box('tray', TRAY.x + 0.12, TRAY_TOP + 0.01, TRAY.z - 0.06, 0.03, 0.02, 0.09)),

  piece(SCENE.screenOff, box('cart', CART.x, 0.92, CART.z - 0.025, 0.4, 0.26, 0.012)),

  ...[0, 1, 2, 3].map((index) => piece(CLINIC_COLORS.curtain, box(
    'curtain', CURTAIN.x + (index % 2 === 0 ? -0.02 : 0.02), 0.51, CURTAIN.z0 + 0.1125 + index * 0.185, 0.02, 0.78, 0.19,
  ))),

  piece(CLINIC_COLORS.sheet, box('board', BOARD.x + BOARD.w / 2 + 0.002, BOARD.y, BOARD.z, 0.004, BOARD.h - 0.06, BOARD.d - 0.06)),
  ...BUGS.flatMap(([y, z]) => [
    piece(CLINIC_COLORS.bug, box('board', BUG_X, y, z, 0.008, 0.075, 0.035)),
    piece(CLINIC_COLORS.bug, box('board', BUG_X, y + 0.05, z, 0.008, 0.025, 0.026)),
    piece(CLINIC_COLORS.bug, box('board', BUG_X, y + 0.018, z, 0.008, 0.012, 0.085)),
    piece(CLINIC_COLORS.bug, box('board', BUG_X, y - 0.018, z, 0.008, 0.012, 0.095)),
  ]),
];

/** The robot clinic: plain frames for the merged decor, colored pieces for the per-instance box. */
export const DEBUG_LAB: { frame: readonly ClinicFrameBox[]; pieces: readonly ClinicPiece[] } = {
  frame: FRAME,
  pieces: PIECES,
};

export interface RoundTagBox {
  kind: 'post' | 'rail' | 'tag';
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

/** One round tag: thin, facing the camera's side of the desk, no text. */
export const ROUND_TAG_SIZE = { w: 0.012, h: 0.1, d: 0.065 } as const;
/** The post stands just off the desk's -x side, in the gap the four-desk row leaves (desks are 0.845 wide). */
const TAG_POST_DX = -0.47;
const TAG_POST_DZ = -0.17;
/** Above a seated robot's head, so the tags are not hidden behind it. */
const TAG_RAIL_Y = 1.0;
const TAG_SPACING = 0.08;
/** Longest tag run: past six tags they close up instead of growing toward the chair. */
export const ROUND_TAG_RUN = 0.4;

/** Whether a task is looping (its tags and badge brighten). Rounds come from the server's `debugRounds`. */
export function isLooping(rounds: number | null | undefined): boolean {
  return typeof rounds === 'number' && rounds >= LOOP_ROUND;
}

/**
 * One desk's round tags in room-local space: a post and a rail beside the desk and one tag per round,
 * hung toward the room front. `deskX` / `deskZ` are the desk's current room-local centre, so the tags
 * follow the desk row. No rounds (0, legacy history or a hand-set phase) draws nothing.
 */
export function roundTagBoxes(rounds: number | null | undefined, deskX: number, deskZ: number): RoundTagBox[] {
  if (typeof rounds !== 'number' || !Number.isFinite(rounds) || rounds < 1) return [];
  const count = Math.min(ROUND_TAG_CAP, Math.floor(rounds));
  const spacing = count > 1 ? Math.min(TAG_SPACING, ROUND_TAG_RUN / (count - 1)) : 0;
  const x = deskX + TAG_POST_DX;
  const start = deskZ + TAG_POST_DZ;
  const rail = ROUND_TAG_SIZE.d + 0.03 + (count - 1) * spacing;
  const color = isLooping(rounds) ? CLINIC_COLORS.tagLoop : CLINIC_COLORS.tag;
  const out: RoundTagBox[] = [
    { kind: 'post', x, y: TAG_RAIL_Y / 2 + 0.01, z: start, w: 0.025, h: TAG_RAIL_Y + 0.02, d: 0.025, color: SCENE.metal },
    { kind: 'rail', x, y: TAG_RAIL_Y, z: start - 0.0125 + rail / 2, w: 0.02, h: 0.02, d: rail, color: SCENE.metal },
  ];
  for (let index = 0; index < count; index += 1) {
    out.push({
      kind: 'tag', x, y: TAG_RAIL_Y - 0.01 - ROUND_TAG_SIZE.h / 2, z: start + 0.0175 + ROUND_TAG_SIZE.d / 2 + index * spacing, ...ROUND_TAG_SIZE, color,
    });
  }
  return out;
}

/** The readout line for a task the debugger handed to dev or dev-2. */
export const COMPLETE_TEXT = 'debugger done · waiting for dev';

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How long a task has been in the room, from `debugEntry.at`. A timestamp uses `formatAge` (minutes,
 * then hours). A date-only value counts whole days from local midnight, as `timeOf` reads it, and
 * shows `today` or `Nd`: `formatAge` would read it as UTC midnight and show misleading hours.
 * No usable time, no age.
 */
export function stayAge(at: string | null | undefined, now: number): string | null {
  if (!at) return null;
  if (DATE_ONLY.test(at)) {
    const start = timeOf({ statusUpdatedAt: at });
    if (start === null) return null;
    const days = Math.max(0, Math.floor((now - start) / DAY_MS));
    return days === 0 ? 'today' : `${days}d`;
  }
  return Number.isFinite(Date.parse(at)) ? formatAge(at, now) : null;
}

/**
 * True when Earth's Changes button sent the task here, from structured fields only: the entry row is
 * the orchestrator's, the latest decision is `request_changes`, it is applied, and it was decided no
 * later than the entry. The Escalation room has the same shape of rule over `lastTransition` and
 * `escalate`; the two could share one helper later.
 */
export function sentBackByEarth(task: Pick<OfficeTask, 'debugEntry' | 'latestDecision' | 'decisionPending'>): boolean {
  const entry = task.debugEntry;
  const decision = task.latestDecision;
  if (!entry || !decision) return false;
  if (entry.agent !== 'orchestrator' || decision.decision !== 'request_changes' || task.decisionPending !== false) return false;
  const decidedAt = Date.parse(decision.decidedAt);
  const enteredAt = entry.at ? Date.parse(entry.at) : NaN;
  return Number.isFinite(decidedAt) && Number.isFinite(enteredAt) && decidedAt <= enteredAt;
}

export interface DebugLine {
  taskId: string;
  title: string;
  kind: 'debugging' | 'complete';
  /** The server's `debugRounds`, or null when it is 0 or unknown (no badge). */
  rounds: number | null;
  looping: boolean;
  /** `7m`, `3h`, `today`, `4d`, or null with no entry time. */
  age: string | null;
  /** `sent back by reviewer`, `sent back by earth (Changes)`, the waiting-for-dev text, or null. */
  who: string | null;
  /** The reason as written, cut to two readout lines. */
  reason: string | null;
}

export interface DebugCardModel {
  heading: 'Debugging' | 'Debugger done';
  rounds: number | null;
  looping: boolean;
  age: string | null;
  who: string | null;
  /** The full reason, whitespace folded. */
  reason: string | null;
}

function clean(text: string | null | undefined): string | null {
  const folded = (text ?? '').replace(/\s+/g, ' ').trim();
  return folded === '' ? null : folded;
}

/**
 * Who sent the task back and why, read from `debugEntry` only, so a bookkeeping row during the stay
 * changes neither. The reason is shown as written; Earth's Changes decision shows Earth's note.
 */
function sentBack(task: OfficeTask): { who: string | null; reason: string | null } {
  if (task.phase === 'debugging_complete') return { who: COMPLETE_TEXT, reason: null };
  const entry = task.debugEntry;
  if (!entry) return { who: null, reason: null };
  if (sentBackByEarth(task)) return { who: `sent back by ${task.latestDecision!.actor} (Changes)`, reason: clean(task.latestDecision!.note) };
  return { who: `sent back by ${entry.agent}`, reason: clean(entry.reason) };
}

function roundsOf(task: OfficeTask): number | null {
  const rounds = task.debugRounds;
  return typeof rounds === 'number' && Number.isFinite(rounds) && rounds >= 1 ? Math.floor(rounds) : null;
}

function entryTime(task: OfficeTask): number | null {
  return task.debugEntry?.at ? timeOf({ statusUpdatedAt: task.debugEntry.at }) : null;
}

function inRoom(tasks: readonly OfficeTask[], phase: 'debugging' | 'debugging_complete'): OfficeTask[] {
  return tasks
    .filter((task) => task.phase === phase)
    .map((task) => ({ task, at: entryTime(task) }))
    .sort((a, b) => byWait({ at: a.at, taskId: a.task.taskId }, { at: b.at, taskId: b.task.taskId }))
    .map(({ task }) => task);
}

/** One line per task in the room: tasks in debugging first, then the ones waiting for dev, each longest stay first. */
export function debugLines(tasks: readonly OfficeTask[], now: number): DebugLine[] {
  const line = (task: OfficeTask, kind: DebugLine['kind']): DebugLine => {
    const back = sentBack(task);
    return {
      taskId: task.taskId,
      title: task.title,
      kind,
      rounds: roundsOf(task),
      looping: isLooping(roundsOf(task)),
      age: stayAge(task.debugEntry?.at, now),
      who: back.who,
      reason: back.reason === null ? null : boardReason(back.reason),
    };
  };
  return [
    ...inRoom(tasks, 'debugging').map((task) => line(task, 'debugging')),
    ...inRoom(tasks, 'debugging_complete').map((task) => line(task, 'complete')),
  ];
}

/** What the selection card adds for a task in Debug Lab, or null for a task elsewhere. */
export function debugCard(task: OfficeTask, now: number): DebugCardModel | null {
  if (task.phase !== 'debugging' && task.phase !== 'debugging_complete') return null;
  const back = sentBack(task);
  return {
    heading: task.phase === 'debugging' ? 'Debugging' : 'Debugger done',
    rounds: roundsOf(task),
    looping: isLooping(roundsOf(task)),
    age: stayAge(task.debugEntry?.at, now),
    who: back.who,
    reason: back.reason,
  };
}
