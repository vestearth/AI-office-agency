import { PHASE_TO_ZONE, ZONE_BY_ID } from '../commandZones';
import { boardReason } from './officeAborted';
import { ARROW, clean, daysSince, ordered, roomLabel, type EscalationCardModel, type EscalationLine } from './officeEscalation';
import type { OfficeTask } from './officeSelection';

/** The board draws at most this many open release trains, each with at most this many gate segments. */
export const BOARD_ROWS = 4;
export const BOARD_SEGMENTS = 6;

/** The line a task in `devops_complete` carries, the way Escalation's hand-offs do. */
export const DEVOPS_HANDOFF_TEXT = 'devops done · waiting for handoff';

/** Muted tones for the pieces that need their own color. None of them is a status color or a glow. */
export const DEVOPS_COLORS = {
  segmentDark: '#2b2d31',
  paper: '#bdb8ad',
  folder: '#8a9299',
  line: '#c4c0b6',
  check: '#8a8f96',
  clockFace: '#cfc9bb',
  clockHand: '#26282c',
  keyboard: '#2d2f33',
  mugA: '#b0aaa0',
  mugB: '#7f8f93',
} as const;

export type DevopsBucket = 'wood' | 'metal' | 'fabric';

export interface DevopsBox {
  part: 'board' | 'clock' | 'tray' | 'console' | 'whiteboard' | 'coffee' | 'rug';
  bucket: DevopsBucket;
  /** Room-local center. y is height above the floor slab. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export interface DevopsTinted {
  part: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

const box = (part: DevopsBox['part'], bucket: DevopsBucket, x: number, y: number, z: number, w: number, h: number, d: number): DevopsBox =>
  ({ part, bucket, x, y, z, w, h, d });
const tint = (part: string, color: string, x: number, y: number, z: number, w: number, h: number, d: number): DevopsTinted =>
  ({ part, x, y, z, w, h, d, color });

/**
 * Room-local layout of the deploy control room, +z is the open front. The desk row sits at the front
 * (`deskZ('devops')`), so everything below stands behind it: release board on the back wall, racks and
 * console at the back right, go/no-go table at the back left, checklist whiteboard on the left wall.
 * The near +x wall hides anything past x about 1.2 from the default camera, so nothing stands there.
 * Numbers are meters from the room centre; y is above the floor slab.
 */
export const DEVOPS = {
  board: { x: -0.72, y: 0.78, z: -1.64, w: 1.4, h: 0.56, d: 0.05 },
  /** Segment slots: row 0 on top, column 0 on the left. Lit ones sit a little proud of the dark ones. */
  segment: { w: 0.165, h: 0.085, d: 0.02, pitchX: 0.21, pitchY: 0.125, z: -1.605, litD: 0.03, litZ: -1.59 },
  clock: { x: -1.78, y: 0.8, z: -1.64, r: 0.19, d: 0.04 },
  tray: { x: 0.9, y: 1.1, z: -1.52, w: 1.3, h: 0.04, d: 0.2 },
  /**
   * Two racks on the back wall. The first is the room's original three-tier rack. The second has two tiers
   * so it stays under the sight line from the default camera to the board (see the visibility test).
   */
  racks: [{ x: 1.15, tiers: 3, w: 0.72 }, { x: 0.45, tiers: 2, w: 0.6 }],
  rackZ: -1.28,
  console: { x: 1.0, z: -0.62, w: 0.8, d: 0.4, top: 0.34 },
  screen: { x: 1.0, z: -0.7, scale: 1.2, rotY: 0 },
  table: { file: 'table', x: -0.62, z: -0.42, rotY: 0, scale: 1.25, w: 0.841 * 1.25, d: 0.447 * 1.25, top: 0.327 * 1.25 },
  chairs: [
    { x: -0.85, z: -0.88, rotY: 0 },
    { x: -0.4, z: -0.88, rotY: 0 },
    { x: -0.62, z: 0.0, rotY: Math.PI },
  ],
  chairScale: 1.2,
  rug: { x: -0.62, z: -0.45, w: 1.7, d: 1.2, h: 0.016 },
  whiteboard: { x: -2.04, y: 0.66, z: -0.55, w: 0.06, h: 0.62, d: 0.95 },
  cabinet: { x: -1.75, z: -1.42, scale: 1.35 },
  coffee: { x: -1.0, z: -1.5, w: 0.62, h: 0.3, d: 0.34 },
  lamp: { x: -1.86, z: -1.0, scale: 1.15 },
  plant: { x: -1.88, z: 0.12 },
} as const;

/** One slot of the board in room-local meters. */
export interface SegmentSlot {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export function segmentSlot(row: number, col: number, lit: boolean): SegmentSlot {
  const { board, segment } = DEVOPS;
  return {
    x: board.x + (col - (BOARD_SEGMENTS - 1) / 2) * segment.pitchX,
    y: board.y + ((BOARD_ROWS - 1) / 2 - row) * segment.pitchY,
    z: lit ? segment.litZ : segment.z,
    w: segment.w,
    h: segment.h,
    d: lit ? segment.litD : segment.d,
  };
}

/** Flat pieces that need their own color: they ride the rack mesh as per-instance colors, with no glow. */
function tintedPieces(): DevopsTinted[] {
  const out: DevopsTinted[] = [];
  const { clock, whiteboard, console: desk, table } = DEVOPS;
  // Clock face and two hands, no numbers.
  out.push(tint('clock', DEVOPS_COLORS.clockFace, clock.x, clock.y, clock.z + clock.d / 2 + 0.006, 0.25, 0.25, 0.012));
  out.push(tint('clock', DEVOPS_COLORS.clockHand, clock.x, clock.y + 0.05, clock.z + clock.d / 2 + 0.016, 0.018, 0.1, 0.01));
  out.push(tint('clock', DEVOPS_COLORS.clockHand, clock.x + 0.04, clock.y, clock.z + clock.d / 2 + 0.016, 0.08, 0.018, 0.01));
  // Deploy checklist: a line and a tick box per row, no text.
  for (let row = 0; row < 4; row += 1) {
    const y = whiteboard.y + 0.2 - row * 0.13;
    out.push(tint('checklist', DEVOPS_COLORS.line, whiteboard.x + 0.04, y, whiteboard.z + 0.12, 0.02, 0.03, 0.52));
    out.push(tint('checklist', DEVOPS_COLORS.check, whiteboard.x + 0.04, y, whiteboard.z - 0.3, 0.02, 0.08, 0.08));
  }
  // Papers and a folder on the go/no-go table, a keyboard on the console, two mugs on the coffee machine's cabinet.
  const tableTop = table.top + 0.008;
  out.push(tint('paper', DEVOPS_COLORS.paper, table.x - 0.3, tableTop, table.z + 0.02, 0.2, 0.014, 0.15));
  out.push(tint('paper', DEVOPS_COLORS.paper, table.x + 0.05, tableTop, table.z - 0.06, 0.18, 0.014, 0.14));
  out.push(tint('folder', DEVOPS_COLORS.folder, table.x + 0.36, tableTop + 0.004, table.z + 0.06, 0.2, 0.02, 0.15));
  out.push(tint('keyboard', DEVOPS_COLORS.keyboard, desk.x, desk.top + 0.03, desk.z + 0.1, 0.34, 0.02, 0.1));
  out.push(tint('mug', DEVOPS_COLORS.mugA, DEVOPS.coffee.x + 0.12, DEVOPS.coffee.h + 0.04, DEVOPS.coffee.z + 0.08, 0.06, 0.08, 0.06));
  out.push(tint('mug', DEVOPS_COLORS.mugB, DEVOPS.coffee.x + 0.22, DEVOPS.coffee.h + 0.04, DEVOPS.coffee.z + 0.06, 0.06, 0.08, 0.06));
  return out;
}

export const DEVOPS_TINTED: readonly DevopsTinted[] = tintedPieces();

/** Plain-colored pieces for the merged decor. Wood, metal and fabric only: no shade, so nothing here glows. */
export function devopsBoxes(): DevopsBox[] {
  const { board, tray, console: desk, whiteboard, coffee, rug } = DEVOPS;
  const legH = desk.top - 0.04;
  return [
    box('board', 'metal', board.x, board.y, board.z, board.w, board.h, board.d),
    box('tray', 'metal', tray.x, tray.y, tray.z, tray.w, tray.h, tray.d),
    box('console', 'wood', desk.x, desk.top - 0.02, desk.z, desk.w, 0.04, desk.d),
    box('console', 'metal', desk.x - desk.w / 2 + 0.05, legH / 2, desk.z, 0.05, legH, desk.d - 0.06),
    box('console', 'metal', desk.x + desk.w / 2 - 0.05, legH / 2, desk.z, 0.05, legH, desk.d - 0.06),
    box('whiteboard', 'metal', whiteboard.x, whiteboard.y, whiteboard.z, whiteboard.w, whiteboard.h, whiteboard.d),
    box('coffee', 'wood', coffee.x, coffee.h / 2, coffee.z, coffee.w, coffee.h, coffee.d),
    box('coffee', 'metal', coffee.x - 0.12, coffee.h + 0.11, coffee.z - 0.02, 0.2, 0.22, 0.2),
    box('coffee', 'metal', coffee.x - 0.12, coffee.h + 0.03, coffee.z + 0.09, 0.14, 0.04, 0.05),
    box('rug', 'fabric', rug.x, rug.h / 2, rug.z, rug.w, rug.h, rug.d),
  ];
}

/** Footprints of everything that stands on the floor behind the desk row, for the clearance tests. */
export function devopsFootprints(): { part: string; x: number; z: number; w: number; d: number }[] {
  const { table, cabinet, lamp, plant, racks, rackZ, chairs, chairScale } = DEVOPS;
  const floor = devopsBoxes().filter((item) => item.part !== 'rug' && item.y - item.h / 2 < 0.4 && item.part !== 'board' && item.part !== 'tray' && item.part !== 'whiteboard');
  return [
    ...floor.map((item) => ({ part: item.part, x: item.x, z: item.z, w: item.w, d: item.d })),
    ...racks.map((rack) => ({ part: 'rack', x: rack.x, z: rackZ, w: rack.w, d: 0.32 })),
    { part: 'table', x: table.x, z: table.z, w: table.w, d: table.d },
    ...chairs.map((chair) => ({ part: 'chair', x: chair.x, z: chair.z, w: 0.2 * chairScale, d: 0.2 * chairScale })),
    { part: 'cabinet', x: cabinet.x, z: cabinet.z, w: 0.266 * cabinet.scale, d: 0.381 * cabinet.scale },
    { part: 'lamp', x: lamp.x, z: lamp.z, w: 0.152 * lamp.scale, d: 0.176 * lamp.scale },
    { part: 'plant', x: plant.x, z: plant.z, w: 0.255 * 1.15, d: 0.291 * 1.15 },
  ];
}

export function isDevopsPhase(phase: OfficeTask['phase']): boolean {
  return phase === 'devops_needed' || phase === 'devops_complete';
}

/* ---- release trains ---- */

export type GatesState = 'gates' | 'unreadable' | 'none';

export interface TrainRow {
  taskId: string;
  title: string;
  state: GatesState;
  resolved: number;
  total: number;
  /** Lit board segments, never more than `BOARD_SEGMENTS`. Zero when the gates cannot be read. */
  lit: number;
  /** Slots the board draws for this train: its gate count (capped), or a full dark row when it has none. */
  slots: number;
}

/**
 * Segments to light. A train of up to six gates lights one per resolved gate. A longer train scales by
 * `floor(6 × resolved / total)`, and a full row only when every gate has resolved, so the board never
 * shows a train as done early.
 */
export function litSegments(resolved: number, total: number): number {
  if (!Number.isFinite(resolved) || !Number.isFinite(total) || total <= 0) return 0;
  const done = Math.min(Math.max(0, Math.floor(resolved)), Math.floor(total));
  if (total <= BOARD_SEGMENTS) return done;
  if (done >= total) return BOARD_SEGMENTS;
  return Math.min(BOARD_SEGMENTS - 1, Math.floor((BOARD_SEGMENTS * done) / total));
}

function trainRow(item: OfficeTask): TrainRow {
  const gates = item.gates;
  const base = { taskId: item.taskId, title: item.title };
  if (!gates) return { ...base, state: 'none', resolved: 0, total: 0, lit: 0, slots: BOARD_SEGMENTS };
  // `readable` comes first: the server sends total 0 and resolved 0 when it cannot read the gates.
  if (!gates.readable) return { ...base, state: 'unreadable', resolved: 0, total: 0, lit: 0, slots: BOARD_SEGMENTS };
  if (!(gates.total > 0)) return { ...base, state: 'none', resolved: 0, total: 0, lit: 0, slots: BOARD_SEGMENTS };
  const total = Math.floor(gates.total);
  const resolved = Math.min(Math.max(0, Math.floor(gates.resolved)), total);
  return { ...base, state: 'gates', resolved, total, lit: litSegments(resolved, total), slots: Math.min(total, BOARD_SEGMENTS) };
}

/** True for a release train that still lives in an open room. A finished or aborted one has no row. */
function isOpenTrain(item: OfficeTask): boolean {
  if (item.isReleaseTrain !== true) return false;
  const zone = item.phase ? ZONE_BY_ID.get(PHASE_TO_ZONE.get(item.phase) ?? '') : undefined;
  return zone != null && zone.kind !== 'terminal';
}

/** Every open release train, by task id. The order never depends on dates, so a row never moves. */
export function trainRows(tasks: readonly OfficeTask[]): TrainRow[] {
  return tasks
    .filter(isOpenTrain)
    .sort((a, b) => a.taskId.localeCompare(b.taskId, 'en', { numeric: true }))
    .map(trainRow);
}

/** The rows the board draws. The readout lists them all. */
export function boardRows(rows: readonly TrainRow[]): TrainRow[] {
  return rows.slice(0, BOARD_ROWS);
}

/** "gates 1/4", "gates unreadable" or "no gates": exactly what the data says, nothing guessed. */
export function trainText(row: Pick<TrainRow, 'state' | 'resolved' | 'total'>): string {
  if (row.state === 'unreadable') return 'gates unreadable';
  if (row.state === 'none') return 'no gates';
  return `gates ${row.resolved}/${row.total}`;
}

/** What the selection card adds for an open release train, or null for any other task. */
export function gatesCard(item: OfficeTask): { text: string; state: GatesState; resolved: number; total: number } | null {
  if (!isOpenTrain(item)) return null;
  const row = trainRow(item);
  return { text: trainText(row), state: row.state, resolved: row.resolved, total: row.total };
}

/* ---- tasks in the room ---- */

interface Origin {
  from: string | null;
  reason: string | null;
  reasonLabel: 'reason' | 'latest note' | null;
}

/**
 * Where a DevOps task came from and why, read from the structured `lastTransition` only. Nothing is
 * shown unless that transition is the one into the task's current phase. A move inside the room keeps
 * its text but calls it the latest note. The role is `lastTransition.agent` as written, `orchestrator`
 * included: no human decision routes a task into DevOps, so there is no "decided by" branch.
 */
function originOf(item: OfficeTask): Origin {
  const transition = item.lastTransition;
  const match = transition ? ARROW.exec(transition.phase) : null;
  if (!transition || !match || match[2] !== item.phase) return { from: null, reason: null, reasonLabel: null };
  const reason = clean(transition.reason);
  if (PHASE_TO_ZONE.get(match[1]) === 'devops') {
    return { from: null, reason, reasonLabel: reason ? 'latest note' : null };
  }
  return {
    from: [roomLabel(match[1]), clean(transition.agent)].filter(Boolean).join(' · ') || null,
    reason,
    reasonLabel: reason ? 'reason' : null,
  };
}

/** One line per task in the room: work first, then hand-offs, each longest wait first. */
export function devopsLines(tasks: readonly OfficeTask[], now: number): Omit<EscalationLine, 'kind'>[] {
  const work = ordered(tasks, 'devops_needed').map((item) => {
    const origin = originOf(item);
    return {
      taskId: item.taskId,
      title: item.title,
      from: origin.from,
      reason: origin.reason === null ? null : boardReason(origin.reason),
      reasonLabel: origin.reasonLabel,
      days: daysSince(item, now),
    };
  });
  const handoff = ordered(tasks, 'devops_complete').map((item) => ({
    taskId: item.taskId,
    title: item.title,
    from: null,
    reason: DEVOPS_HANDOFF_TEXT,
    reasonLabel: null,
    days: daysSince(item, now),
  }));
  return [...work, ...handoff];
}

/** What the selection card adds for a task in this room, or null for a task elsewhere. */
export function devopsCard(item: OfficeTask, now: number): EscalationCardModel | null {
  if (item.phase === 'devops_complete') {
    return { heading: 'DevOps done', from: null, reason: DEVOPS_HANDOFF_TEXT, reasonLabel: null, days: daysSince(item, now) };
  }
  if (item.phase !== 'devops_needed') return null;
  const origin = originOf(item);
  return { heading: 'DevOps', from: origin.from, reason: origin.reason, reasonLabel: origin.reasonLabel, days: daysSince(item, now) };
}

/* ---- the lit segments and their one blink ---- */

/** A newly resolved gate shows lit for this long, goes out for the same time, then stays lit. */
export const SEGMENT_BLINK_MS = 160;

export interface LightState {
  /** Lit segments currently shown per train. */
  shown: ReadonlyMap<string, number>;
  /** Segment key -> when its blink started. */
  blinking: ReadonlyMap<string, number>;
}

export const NO_LIGHTS: LightState = { shown: new Map(), blinking: new Map() };

export const segmentKey = (taskId: string, col: number): string => `${taskId}:${col}`;

/**
 * Moves the lights to the board's rows. A gate that resolved since the last step blinks once, unless
 * `snap` (first load, hidden tab, stream gap, reduced motion) or the train is new to the board.
 */
export function stepLights(prev: LightState, rows: readonly Pick<TrainRow, 'taskId' | 'lit'>[], opts: { snap: boolean; now: number }): LightState {
  const shown = new Map<string, number>();
  const blinking = new Map<string, number>();
  for (const row of rows) {
    const before = prev.shown.get(row.taskId);
    shown.set(row.taskId, row.lit);
    if (opts.snap || before === undefined) continue;
    for (let col = 0; col < row.lit; col += 1) {
      const key = segmentKey(row.taskId, col);
      const started = prev.blinking.get(key);
      if (col >= before) blinking.set(key, opts.now);
      else if (started !== undefined && opts.now - started < SEGMENT_BLINK_MS * 2) blinking.set(key, started);
    }
  }
  return { shown, blinking };
}

/** Keys of the segments drawn lit right now: shown ones, minus a blinking one during its off half. */
export function visibleLit(state: LightState, now: number): string[] {
  const keys: string[] = [];
  for (const [taskId, lit] of state.shown) {
    for (let col = 0; col < lit; col += 1) {
      const key = segmentKey(taskId, col);
      const started = state.blinking.get(key);
      const off = started !== undefined && now - started >= SEGMENT_BLINK_MS && now - started < SEGMENT_BLINK_MS * 2;
      if (!off) keys.push(key);
    }
  }
  return keys;
}

/** True while at least one segment is still inside its blink. */
export function blinkActive(state: LightState, now: number): boolean {
  for (const started of state.blinking.values()) if (now - started < SEGMENT_BLINK_MS * 2) return true;
  return false;
}
