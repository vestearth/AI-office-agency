import { PHASE_TO_ZONE } from '../commandZones';
import { BOARD_SEGMENTS, byTaskId, gatesCard, litSegments, trainRow, trainText, type GatesState } from './officeDevops';
import type { ShownDesk } from './officeLook';
import type { OfficeTask } from './officeSelection';

/**
 * Dev Bay as an office with a kanban whiteboard (SPAR-53). The board is a read model of the room's tasks:
 * one sticky note per task, in the column of the gate it needs next, with one dot per gate. Nothing here is
 * derived from prose: the columns come from `gates.items` (name, status, resolved) and nothing else.
 */

export interface GateItem {
  name: string;
  status: string;
  resolved: boolean;
}

export const COLUMN_COUNT = 6;
/** Notes a column draws before the sixth slot turns into a small stack. */
export const NOTES_PER_COLUMN = 5;
export const NOTE_ROWS = 6;
export const STACK_ROW = NOTE_ROWS - 1;
/** Dots a note draws at most. Equal to the DevOps board's `BOARD_SEGMENTS` (a test pins it), written out so this module has no load-time import. */
export const NOTE_DOTS = 6;
/** Capacity of the note mesh: every note, its dots and a halo, plus a stack of three for each column. */
export const NOTE_INSTANCE_CAP = COLUMN_COUNT * (NOTES_PER_COLUMN * (2 + NOTE_DOTS) + 3);

/** The columns left to right. The scene has no text, so `head` is for the readout and the tests. */
export const COLUMNS = [
  { id: 'verify', head: 'ตรวจ' },
  { id: 'staging', head: 'staging' },
  { id: 'prod', head: 'prod' },
  { id: 'closeout', head: 'ปิดงาน' },
  { id: 'complete', head: 'ครบ' },
  { id: 'none', head: 'ไม่มี' },
] as const;

const COMPLETE_COLUMN = 4;
const NONE_COLUMN = 5;

/** The column of each gate name. A name that is not here goes to the first column and the readout shows its real name. */
export const GATE_COLUMN: Readonly<Record<string, number>> = {
  implementation_verification: 0,
  product_contract: 0,
  shared_lib_publication: 0,
  train_prepared: 0,
  deploy_staging: 1,
  staging_acceptance: 1,
  authenticated_staging: 1,
  deploy_production: 2,
  production_acceptance: 2,
  prod_boot_acceptance: 2,
  knowledge_closeout: 3,
};

/** Wait kinds as the readout's second line names them. */
export const WAIT_TEXT: Readonly<Record<string, string>> = {
  prod_run: 'รัน prod',
  operator_decision: 'Earth ตัดสินใจ',
  operator_approval: 'Earth อนุมัติ',
  qa: 'QA',
  aws_permission: 'AWS permission',
  external: 'ฝั่งนอก',
};
const GRANT_TEXT = 'grant';

export const COMPLETE_TEXT = 'gate ครบ · รอย้ายออก';
export const NO_GATE_TEXT = 'ไม่มี gate';
export const UNREADABLE_TEXT = 'gates unreadable';

/* ---- the room ---- */

export const BAY_DESK_Z = 0.8;
export const DEVBAY_DESK_SCALE = 0.82;
/** Half of the walkway between the two pairs of workstations: a robot (0.533 wide) keeps 0.2 either side. */
export const AISLE_HALF = 0.475;
const DESK_W = 0.7345 * DEVBAY_DESK_SCALE;
const DESK_GAP = 0.03;
/** The four fixed workstations, left to right, two on each side of the aisle. */
export const WORKSTATION_X: readonly number[] = [
  -(AISLE_HALF + DESK_W / 2 + DESK_W + DESK_GAP),
  -(AISLE_HALF + DESK_W / 2),
  AISLE_HALF + DESK_W / 2,
  AISLE_HALF + DESK_W / 2 + DESK_W + DESK_GAP,
];
export const WORKSTATION_COUNT = WORKSTATION_X.length;

/**
 * Room-local layout, +z is the open front. The desks stand at the front (`BAY_DESK_Z`), the whiteboard has
 * the back wall, and the centre aisle (x about 0) runs from the front to the board. The near +x wall hides
 * anything past x about 1.2 from the default camera, so nothing stands there. Numbers are meters from the room
 * centre; y is above the floor slab.
 */
export const DEVBAY = {
  board: { x: -0.35, y: 0.62, z: -1.645, w: 2.93, h: 0.9, d: 0.04 },
  face: { x: -0.35, y: 0.62, z: -1.62, w: 2.85, h: 0.84, d: 0.012 },
  /** Column pitch, and the row of header strips under the board's top edge. */
  columnPitch: 0.45,
  header: { y: 1.0, w: 0.4, h: 0.04, d: 0.006 },
  /** Note slots: row 0 on top, row 5 (the stack) at the bottom. */
  note: { w: 0.3, h: 0.105, d: 0.012, rowPitch: 0.115, firstRowY: 0.9, z: -1.607 },
  dot: { size: 0.026, pitch: 0.037, drop: 0.024, d: 0.006 },
  tray: { x: -0.35, y: 0.165, z: -1.6, w: 1.3, h: 0.025, d: 0.07 },
  /** Where a robot stands in front of the board, and the lane it walks along to reach a column. */
  stand: { z: -1.28 },
  table: { file: 'table', x: -1.1, z: -0.35, rotY: 0, scale: 1.25, w: 0.841 * 1.25, d: 0.447 * 1.25, top: 0.327 * 1.25 },
  chairs: [
    { x: -1.3, z: -0.8, rotY: 0 },
    { x: -0.9, z: -0.8, rotY: 0 },
    { x: -1.3, z: 0.1, rotY: Math.PI },
    { x: -0.9, z: 0.1, rotY: Math.PI },
  ],
  chairScale: 1.2,
  rug: { x: -1.1, z: -0.35, w: 1.5, d: 1.15, h: 0.016 },
  runner: { x: 0, z: 0.1, w: 0.7, d: 3.0, h: 0.012 },
  bookcases: [
    { file: 'bookcaseOpen', x: -1.93, z: -0.98, rotY: Math.PI / 2, scale: 1.05, w: 0.4 * 1.05, d: 0.25 * 1.05, h: 0.88 * 1.05 },
    { file: 'bookcaseClosed', x: -1.93, z: -0.55, rotY: Math.PI / 2, scale: 1.05, w: 0.4 * 1.05, d: 0.25 * 1.05, h: 0.85 * 1.05 },
  ],
  filing: { x: -1.92, z: -1.45, w: 0.26, d: 0.4, h: 0.78 },
  window: { x: -2.045, y: 0.62, z: 0.3, w: 0.02, h: 0.5, d: 0.7 },
  /** The printer sits on the low cabinet beside the aisle, clear of the lane in front of the board and under the sight line of the right-hand columns. */
  cabinet: { file: 'cabinetBedDrawer', x: 1.0, z: -0.65, scale: 1.35, w: 0.266 * 1.35, d: 0.217 * 1.35, h: 0.263 * 1.35 },
  printer: { x: 1.0, z: -0.65, w: 0.3, d: 0.22, h: 0.12 },
  cooler: { x: 1.05, z: -0.1, w: 0.24, d: 0.24, h: 0.5, jugH: 0.3 },
  plants: [{ x: -1.88, z: -0.1 }, { x: 1.02, z: 0.33 }],
  plantScale: 1.15,
  /** The desk lamp is three flat pieces on the rack mesh: its own shade, never the merged decor's glowing one and no new draw call. */
  lamp: { dx: 0.2, dz: -0.12, base: 0.07, stemH: 0.17, shade: { w: 0.11, h: 0.06 } },
  mug: { dx: -0.2, dz: 0.04, w: 0.05, h: 0.06, d: 0.05 },
} as const;

/** Muted tones for the pieces that need their own color. None of them is a status color or a glow. */
export const DEVBAY_COLORS = {
  face: '#a9aeb3',
  divider: '#868c92',
  headers: ['#70797f', '#7a8275', '#877f6c', '#7a7069', '#75787e', '#5a5c60'],
  paper: '#9c8a52',
  paperStack: '#85763f',
  inkOn: '#1d1f23',
  inkOff: '#c2b27a',
  halo: '#2f3a46',
  marker: ['#5b6670', '#7a5f55', '#4f6a58'],
  jug: '#4d6670',
  drawer: '#5a636d',
  glass: '#587286',
  lampBase: '#2b2e33',
  lampShade: '#9a8c63',
  mugA: '#b0aaa0',
  mugB: '#7f8f93',
} as const;

export type DevBayBucket = 'wood' | 'metal' | 'fabric';

export interface DevBayBox {
  part: string;
  bucket: DevBayBucket;
  /** Room-local center. y is the center height above the floor slab. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export interface DevBayTinted {
  part: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

const box = (part: string, bucket: DevBayBucket, x: number, y: number, z: number, w: number, h: number, d: number): DevBayBox =>
  ({ part, bucket, x, y, z, w, h, d });
const tint = (part: string, color: string, x: number, y: number, z: number, w: number, h: number, d: number): DevBayTinted =>
  ({ part, x, y, z, w, h, d, color });

export const columnX = (column: number): number => DEVBAY.board.x + (column - (COLUMN_COUNT - 1) / 2) * DEVBAY.columnPitch;
export const rowY = (row: number): number => DEVBAY.note.firstRowY - row * DEVBAY.note.rowPitch;

/** Plain-colored pieces for the merged decor. Wood, metal and fabric only: no shade, so nothing here glows. */
export function devBayBoxes(): DevBayBox[] {
  const { board, tray, rug, runner, filing, window: win, printer, cooler } = DEVBAY;
  const out: DevBayBox[] = [
    box('board', 'metal', board.x, board.y, board.z, board.w, board.h, board.d),
    box('tray', 'metal', tray.x, tray.y, tray.z, tray.w, tray.h, tray.d),
    box('rug', 'fabric', rug.x, rug.h / 2, rug.z, rug.w, rug.h, rug.d),
    box('runner', 'fabric', runner.x, runner.h / 2, runner.z, runner.w, runner.h, runner.d),
    box('filing', 'metal', filing.x, filing.h / 2, filing.z, filing.w, filing.h, filing.d),
    box('printer', 'metal', printer.x, DEVBAY.cabinet.h + printer.h / 2, printer.z, printer.w, printer.h, printer.d),
    box('cooler', 'metal', cooler.x, cooler.h / 2, cooler.z, cooler.w, cooler.h, cooler.d),
    // The window frame, and the blind: a few slats over the glass.
    box('window', 'metal', win.x, win.y, win.z, win.w, win.h + 0.05, win.d + 0.05),
  ];
  for (let slat = 0; slat < 5; slat += 1) {
    out.push(box('blind', 'fabric', win.x + 0.02, win.y + win.h / 2 - 0.05 - slat * 0.09, win.z, 0.012, 0.03, win.d - 0.04));
  }
  return out;
}

/** Flat pieces that need their own color: they ride the rack mesh as per-instance colors, with no glow. */
export function devBayTinted(): DevBayTinted[] {
  const { face, header, tray, filing, cooler, window: win } = DEVBAY;
  const out: DevBayTinted[] = [tint('face', DEVBAY_COLORS.face, face.x, face.y, face.z, face.w, face.h, face.d)];
  for (let column = 0; column < COLUMN_COUNT; column += 1) {
    out.push(tint('header', DEVBAY_COLORS.headers[column], columnX(column), header.y, face.z + 0.008, header.w, header.h, header.d));
  }
  for (let split = 1; split < COLUMN_COUNT; split += 1) {
    const x = columnX(split) - DEVBAY.columnPitch / 2;
    out.push(tint('divider', DEVBAY_COLORS.divider, x, 0.57, face.z + 0.007, 0.006, 0.72, 0.004));
  }
  DEVBAY_COLORS.marker.forEach((color, index) => {
    out.push(tint('marker', color, tray.x - 0.2 + index * 0.1, tray.y + 0.03, tray.z + 0.005, 0.07, 0.022, 0.022));
  });
  for (let drawer = 0; drawer < 3; drawer += 1) {
    out.push(tint('drawer', DEVBAY_COLORS.drawer, filing.x + filing.w / 2 + 0.003, 0.16 + drawer * 0.24, filing.z, 0.006, 0.17, filing.d - 0.08));
  }
  out.push(tint('jug', DEVBAY_COLORS.jug, cooler.x, cooler.h + cooler.jugH / 2, cooler.z, 0.2, cooler.jugH, 0.2));
  out.push(tint('glass', DEVBAY_COLORS.glass, win.x + 0.012, win.y, win.z, 0.008, win.h, win.d));
  // A desk lamp and a mug on each workstation.
  WORKSTATION_X.forEach((x) => {
    const lx = x + DEVBAY.lamp.dx;
    const lz = BAY_DESK_Z + DEVBAY.lamp.dz;
    const { base, stemH, shade } = DEVBAY.lamp;
    out.push(tint('lamp', DEVBAY_COLORS.lampBase, lx, DESK_TOP + 0.01, lz, base, 0.02, base));
    out.push(tint('lamp', DEVBAY_COLORS.lampBase, lx, DESK_TOP + 0.02 + stemH / 2, lz, 0.015, stemH, 0.015));
    out.push(tint('lamp', DEVBAY_COLORS.lampShade, lx, DESK_TOP + 0.02 + stemH + shade.h / 2 - 0.01, lz, shade.w, shade.h, shade.w));
  });
  WORKSTATION_X.forEach((x, index) => {
    out.push(tint('mug', index % 2 === 0 ? DEVBAY_COLORS.mugA : DEVBAY_COLORS.mugB,
      x + DEVBAY.mug.dx, DESK_TOP + DEVBAY.mug.h / 2, BAY_DESK_Z + DEVBAY.mug.dz, DEVBAY.mug.w, DEVBAY.mug.h, DEVBAY.mug.d));
  });
  return out;
}

/** The desk top above the floor slab: the model is 0.3844 tall. */
export const DESK_TOP = 0.3844 * DEVBAY_DESK_SCALE;

export const DEVBAY_TINTED: readonly DevBayTinted[] = devBayTinted();

export interface Footprint {
  part: string;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Height of the piece above the floor slab. */
  h: number;
}

/** Footprints of everything that stands on the floor behind the desk row, for the clearance and sight-line tests. */
export function devBayFootprints(): Footprint[] {
  const { table, chairs, chairScale, bookcases, cabinet, plants, plantScale } = DEVBAY;
  const floor = devBayBoxes().filter((item) => !['board', 'tray', 'rug', 'runner', 'window', 'blind'].includes(item.part));
  const rotated = (width: number, depth: number, rotY: number) => (Math.abs(Math.sin(rotY)) > 0.5 ? [depth, width] : [width, depth]);
  return [
    ...floor.map((item) => ({ part: item.part, x: item.x, z: item.z, w: item.w, d: item.d, h: item.y + item.h / 2 })),
    { part: 'jug', x: DEVBAY.cooler.x, z: DEVBAY.cooler.z, w: 0.2, d: 0.2, h: DEVBAY.cooler.h + DEVBAY.cooler.jugH },
    { part: 'table', x: table.x, z: table.z, w: table.w, d: table.d, h: table.top },
    ...chairs.map((chair) => ({ part: 'chair', x: chair.x, z: chair.z, w: 0.2 * chairScale, d: 0.2 * chairScale, h: 0.47 * chairScale })),
    ...bookcases.map((shelf) => {
      const [w, d] = rotated(shelf.w, shelf.d, shelf.rotY);
      return { part: 'bookcase', x: shelf.x, z: shelf.z, w, d, h: shelf.h };
    }),
    { part: 'cabinet', x: cabinet.x, z: cabinet.z, w: cabinet.w, d: cabinet.d, h: cabinet.h },
    ...plants.map((plant) => ({ part: 'plant', x: plant.x, z: plant.z, w: 0.255 * plantScale, d: 0.291 * plantScale, h: 0.654 * plantScale })),
  ];
}

/** Workstation x for a slot index. */
export function workstationX(index: number): number {
  return WORKSTATION_X[Math.min(Math.max(0, Math.floor(index)), WORKSTATION_COUNT - 1)];
}

/**
 * The four workstations, always drawn. A seated task keeps its workstation for as long as it stays (or its robot
 * is still walking out: `retained`); a newcomer takes the lowest free one, and waits undrawn when all are taken.
 * An empty workstation has no task, so no robot and a dark monitor.
 */
export function bayWorkstations(
  wanted: readonly string[],
  previous: readonly Pick<ShownDesk, 'taskId'>[] | null = null,
  retained: readonly string[] = [],
): ShownDesk[] {
  const slots: (string | null)[] = Array.from({ length: WORKSTATION_COUNT }, () => null);
  const keep = new Set([...wanted.slice(0, WORKSTATION_COUNT), ...retained]);
  (previous ?? []).forEach((desk, index) => {
    if (index < WORKSTATION_COUNT && desk.taskId && keep.has(desk.taskId)) slots[index] = desk.taskId;
  });
  for (const taskId of wanted.slice(0, WORKSTATION_COUNT)) {
    if (slots.includes(taskId)) continue;
    const free = slots.indexOf(null);
    if (free >= 0) slots[free] = taskId;
  }
  return slots.map((taskId, index) => ({ taskId, localX: workstationX(index) }));
}

/* ---- reading the gates ---- */

export interface GateReading {
  /** `gates`: the list is there. `counts`: an older server that sends only totals. */
  state: GatesState | 'counts';
  items: GateItem[];
  total: number;
  resolved: number;
  next: GateItem | null;
  /** Every gate has resolved. */
  complete: boolean;
}

const NO_READING: GateReading = { state: 'none', items: [], total: 0, resolved: 0, next: null, complete: false };

function validItems(value: unknown): GateItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: GateItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { name, status, resolved } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof resolved !== 'boolean') return null;
    items.push({ name, status: typeof status === 'string' ? status : 'pending', resolved });
  }
  return items;
}

/**
 * What a task's gates say, and nothing more. `readable` comes first: the server sends zero counts when it
 * cannot read the gates. A missing or inconsistent `items` list leaves counts only, so an old server does not
 * break the room: ครบ when every gate has resolved, ตรวจ otherwise.
 */
export function readGates(task: Pick<OfficeTask, 'gates'>): GateReading {
  const gates = task.gates;
  if (!gates) return NO_READING;
  if (!gates.readable) return { ...NO_READING, state: 'unreadable' };
  if (!(gates.total > 0)) return NO_READING;
  const total = Math.floor(gates.total);
  const items = validItems((gates as { items?: unknown }).items);
  if (!items || items.length !== total) {
    const resolved = Math.min(Math.max(0, Math.floor(gates.resolved)), total);
    return { state: 'counts', items: [], total, resolved, next: null, complete: resolved >= total };
  }
  const resolved = items.filter((item) => item.resolved).length;
  const next = items.find((item) => !item.resolved) ?? null;
  return { state: 'gates', items, total, resolved, next, complete: next === null };
}

/** The column of a task: its next gate, ครบ when all have resolved, the last column when there are no gates. */
export function columnOf(reading: GateReading): number {
  if (reading.state === 'none' || reading.state === 'unreadable') return NONE_COLUMN;
  if (reading.complete) return COMPLETE_COLUMN;
  if (reading.state === 'counts' || !reading.next) return 0;
  return GATE_COLUMN[reading.next.name] ?? 0;
}

/**
 * One cell per gate, at most `BOARD_SEGMENTS`, true when resolved. With the list and up to six gates each
 * cell is its own gate; a longer list scales like the DevOps board (`floor`, full only when all have resolved).
 */
export function dotStates(reading: GateReading): boolean[] {
  if (reading.state !== 'gates' && reading.state !== 'counts') return [];
  if (reading.state === 'gates' && reading.total <= BOARD_SEGMENTS) return reading.items.map((item) => item.resolved);
  const cells = Math.min(reading.total, BOARD_SEGMENTS);
  const lit = litSegments(reading.resolved, reading.total);
  return Array.from({ length: cells }, (_, index) => index < lit);
}

/** How many gates have resolved, from the list when it is there. */
export function resolvedCount(task: Pick<OfficeTask, 'gates'>): number {
  return readGates(task).resolved;
}

/* ---- tasks in the room ---- */

export function isBayTask(task: Pick<OfficeTask, 'phase'>): boolean {
  return Boolean(task.phase) && PHASE_TO_ZONE.get(task.phase!) === 'dev';
}

/** Every task in the room, by task number. The order never depends on dates, so a note never moves for them. */
export function tasksInBay<T extends Pick<OfficeTask, 'phase' | 'taskId'>>(tasks: readonly T[]): T[] {
  return tasks.filter(isBayTask).sort(byTaskId);
}

/**
 * Who gets a workstation: urgent tasks first, as everywhere, then the newest `updatedAt`, then task id. A gate
 * write sets `updated_at`, so the task that just moved stays seated and its robot is the one that walks to the
 * board. The other rooms seat their oldest first.
 */
export function bayOrder<T extends Pick<OfficeTask, 'taskId' | 'needsReview' | 'status' | 'updatedAt'>>(tasks: readonly T[]): T[] {
  const urgent = (task: T) => (task.needsReview || task.status === 'failed' ? 0 : 1);
  return [...tasks].sort((a, b) => urgent(a) - urgent(b)
    || (b.updatedAt || '').localeCompare(a.updatedAt || '')
    || byTaskId(a, b));
}

/* ---- the board ---- */

export interface NoteSlot {
  taskId: string;
  column: number;
  row: number;
  /** One cell per gate: true when inked. */
  dots: boolean[];
}

export interface StackSlot {
  column: number;
  /** Tasks past the five notes the column draws. */
  extra: number;
}

export interface BoardLayout {
  notes: NoteSlot[];
  stacks: StackSlot[];
  /** Tasks in each column, notes and stack together. */
  counts: number[];
}

export const EMPTY_BOARD: BoardLayout = { notes: [], stacks: [], counts: Array.from({ length: COLUMN_COUNT }, () => 0) };

export function boardLayout(tasks: readonly OfficeTask[]): BoardLayout {
  const counts = Array.from({ length: COLUMN_COUNT }, () => 0);
  const notes: NoteSlot[] = [];
  for (const task of tasksInBay(tasks)) {
    const reading = readGates(task);
    const column = columnOf(reading);
    const row = counts[column];
    counts[column] += 1;
    if (row < NOTES_PER_COLUMN) notes.push({ taskId: task.taskId, column, row, dots: dotStates(reading) });
  }
  const stacks = counts.flatMap((count, column) => (count > NOTES_PER_COLUMN ? [{ column, extra: count - NOTES_PER_COLUMN }] : []));
  return { notes, stacks, counts };
}

/** `ตรวจ 4 · staging 1 · prod 1 · ปิดงาน 0 · ครบ 3 · ไม่มี 1`: exactly how many tasks each column holds. */
export function boardCountsText(counts: readonly number[]): string {
  return COLUMNS.map((column, index) => `${column.head} ${counts[index] ?? 0}`).join(' · ');
}

export interface BayLine {
  taskId: string;
  title: string;
  /** `currentAgent` as written, or null. */
  role: string | null;
  column: number;
  cells: boolean[];
  /** The next gate's name, or the sentence for none, unreadable and all resolved. */
  next: string;
  /** What the task waits on, e.g. `รอ QA`; null when `waitsOn` is empty. */
  wait: string | null;
}

function nextText(reading: GateReading): string {
  if (reading.state === 'none') return NO_GATE_TEXT;
  if (reading.state === 'unreadable') return UNREADABLE_TEXT;
  if (reading.complete) return COMPLETE_TEXT;
  if (reading.state === 'counts') return `gates ${reading.resolved}/${reading.total}`;
  return reading.next?.name ?? NO_GATE_TEXT;
}

/** What the task waits on, from the structured `waitsOn` and the grant action kind only. */
export function waitText(task: Pick<OfficeTask, 'waitsOn' | 'actionKind'>): string | null {
  const labels = (task.waitsOn ?? []).map((wait) => WAIT_TEXT[wait.kind]).filter((label): label is string => Boolean(label));
  if (task.actionKind === 'authorization_required') labels.push(GRANT_TEXT);
  const unique = [...new Set(labels)];
  return unique.length > 0 ? `รอ ${unique.join(', ')}` : null;
}

/** One line per task in the room, by task number. The readout always lists every task. */
export function bayLines(tasks: readonly OfficeTask[]): BayLine[] {
  return tasksInBay(tasks).map((task) => {
    const reading = readGates(task);
    return {
      taskId: task.taskId,
      title: task.title,
      role: task.currentAgent ?? null,
      column: columnOf(reading),
      cells: dotStates(reading),
      next: nextText(reading),
      wait: waitText(task),
    };
  });
}

/** The gate list of a card: the items in order, or none when only counts are known. */
export function cardGateItems(task: Pick<OfficeTask, 'gates'>): GateItem[] {
  return readGates(task).items;
}

/* ---- the notes in motion ---- */

/** A note slides to its new slot over this long. */
export const SLIDE_MS = 380;
/** The board waits this long for a robot to claim a gate move before it moves the note itself. */
export const CLAIM_GRACE_MS = 400;
/** A robot that never reaches the board must not freeze the note. */
export const HOLD_MAX_MS = 9000;

export interface GateMoveRequest {
  taskId: string;
  /** The column the task sits in once the gate has resolved. */
  column: number;
  fromColumn: number;
}

/** Messages between the board and the robots, plain data so both sides stay testable. */
export interface BoardBus {
  requests: Map<string, GateMoveRequest>;
  claimed: Set<string>;
  arrived: Set<string>;
  rejected: Set<string>;
}

export const createBoardBus = (): BoardBus => ({ requests: new Map(), claimed: new Set(), arrived: new Set(), rejected: new Set() });

interface Hold {
  /** The gates the board keeps drawing until the robot reaches it. */
  gates: OfficeTask['gates'];
  since: number;
  claimed: boolean;
}

export interface BoardState {
  seen: ReadonlyMap<string, { gates: OfficeTask['gates']; resolved: number }>;
  holds: ReadonlyMap<string, Hold>;
  /** The slot each note was drawn in at the last step. */
  shown: ReadonlyMap<string, { column: number; row: number }>;
  slides: ReadonlyMap<string, { fromX: number; fromY: number; at: number }>;
  layout: BoardLayout;
}

export const NO_BOARD: BoardState = { seen: new Map(), holds: new Map(), shown: new Map(), slides: new Map(), layout: EMPTY_BOARD };

export interface BoardSignals {
  claimed: ReadonlySet<string>;
  arrived: ReadonlySet<string>;
  rejected: ReadonlySet<string>;
}

export const NO_SIGNALS: BoardSignals = { claimed: new Set(), arrived: new Set(), rejected: new Set() };

const ease = (t: number): number => 1 - (1 - t) * (1 - t);

/** Where a note is at `now`: in its slot, or on its way from the old one. */
export function notePosition(state: Pick<BoardState, 'slides'>, taskId: string, slot: { column: number; row: number }, now: number): { x: number; y: number } {
  const x = columnX(slot.column);
  const y = rowY(slot.row);
  const slide = state.slides.get(taskId);
  if (!slide) return { x, y };
  const t = (now - slide.at) / SLIDE_MS;
  if (t >= 1) return { x, y };
  const k = ease(Math.max(0, t));
  return { x: slide.fromX + (x - slide.fromX) * k, y: slide.fromY + (y - slide.fromY) * k };
}

/**
 * Moves the board to the room's tasks. A gate that resolved since the last step makes the note wait (it keeps its
 * old column and dots) while a robot walks to the board; the note moves, or its dot inks, when the robot arrives.
 * With no robot to claim it, or when `snap` (first load, hidden tab, stream gap, reduced motion), the board moves
 * the note itself, or jumps. The room never borrows another task's robot.
 */
export function stepBoard(
  prev: BoardState,
  tasks: readonly OfficeTask[],
  opts: { snap: boolean; now: number },
  signals: BoardSignals = NO_SIGNALS,
): { state: BoardState; requests: GateMoveRequest[] } {
  const bay = tasksInBay(tasks);
  const inBay = new Set(bay.map((task) => task.taskId));
  const holds = new Map<string, Hold>();
  for (const [taskId, hold] of prev.holds) {
    const claimed = hold.claimed || signals.claimed.has(taskId);
    const release = opts.snap
      || !inBay.has(taskId)
      || signals.arrived.has(taskId)
      || signals.rejected.has(taskId)
      || (!claimed && opts.now - hold.since > CLAIM_GRACE_MS)
      || opts.now - hold.since > HOLD_MAX_MS;
    if (!release) holds.set(taskId, { ...hold, claimed });
  }
  const requests: GateMoveRequest[] = [];
  const seen = new Map<string, { gates: OfficeTask['gates']; resolved: number }>();
  for (const task of bay) {
    const resolved = resolvedCount(task);
    const before = prev.seen.get(task.taskId);
    if (!opts.snap && before && resolved > before.resolved && !holds.has(task.taskId) && !prev.holds.has(task.taskId)) {
      holds.set(task.taskId, { gates: before.gates, since: opts.now, claimed: false });
      requests.push({ taskId: task.taskId, column: columnOf(readGates(task)), fromColumn: columnOf(readGates({ gates: before.gates })) });
    }
    seen.set(task.taskId, { gates: task.gates, resolved });
  }
  const display = tasks.map((task) => (holds.has(task.taskId) && inBay.has(task.taskId) ? { ...task, gates: holds.get(task.taskId)!.gates } : task));
  const layout = boardLayout(display);
  const shown = new Map(layout.notes.map((note) => [note.taskId, { column: note.column, row: note.row }]));
  const slides = new Map<string, { fromX: number; fromY: number; at: number }>();
  if (!opts.snap) {
    for (const note of layout.notes) {
      const was = prev.shown.get(note.taskId);
      const running = prev.slides.get(note.taskId);
      if (was && (was.column !== note.column || was.row !== note.row)) {
        const from = notePosition(prev, note.taskId, was, opts.now);
        slides.set(note.taskId, { fromX: from.x, fromY: from.y, at: opts.now });
      } else if (running && opts.now - running.at < SLIDE_MS) {
        slides.set(note.taskId, running);
      }
    }
  }
  return { state: { seen, holds, shown, slides, layout }, requests };
}

/** True while a note is sliding or a note is waiting for its robot: the board keeps drawing. */
export function boardActive(state: BoardState, now: number): boolean {
  if (state.holds.size > 0) return true;
  for (const slide of state.slides.values()) if (now - slide.at < SLIDE_MS) return true;
  return false;
}

/* ---- the notes as instances ---- */

export interface NoteInstance {
  /** The task a click on this piece selects; null for a stack, which is only a sign of "more". */
  taskId: string | null;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rotZ: number;
  color: string;
}

/** Every piece of the board's mesh at `now`: halo, notes, dots and stacks. The order is stable for a given state. */
export function noteInstances(state: BoardState, selectedTaskId: string | null, now: number): NoteInstance[] {
  const { note, dot } = DEVBAY;
  const out: NoteInstance[] = [];
  for (const slot of state.layout.notes) {
    const at = notePosition(state, slot.taskId, slot, now);
    if (slot.taskId === selectedTaskId) {
      out.push({ taskId: slot.taskId, x: at.x, y: at.y, z: note.z - 0.004, w: note.w + 0.03, h: note.h + 0.03, d: note.d, rotZ: 0, color: DEVBAY_COLORS.halo });
    }
    out.push({ taskId: slot.taskId, x: at.x, y: at.y, z: note.z, w: note.w, h: note.h, d: note.d, rotZ: 0, color: DEVBAY_COLORS.paper });
    const span = (slot.dots.length - 1) * dot.pitch;
    slot.dots.forEach((inked, index) => {
      out.push({
        taskId: slot.taskId,
        x: at.x - span / 2 + index * dot.pitch,
        y: at.y - dot.drop,
        z: note.z + note.d / 2 + dot.d / 2,
        w: dot.size,
        h: dot.size,
        d: dot.d,
        rotZ: 0,
        color: inked ? DEVBAY_COLORS.inkOn : DEVBAY_COLORS.inkOff,
      });
    });
  }
  // The sixth slot of a crowded column: three notes, a little crooked, one over the other.
  for (const stack of state.layout.stacks) {
    const x = columnX(stack.column);
    const y = rowY(STACK_ROW);
    [[-0.014, 0.006, 0.07], [0.012, 0.002, -0.06], [0, 0, 0.02]].forEach(([dx, dy, tilt], index) => {
      out.push({
        taskId: null,
        x: x + dx,
        y: y + dy,
        z: note.z + index * 0.004,
        w: note.w,
        h: note.h,
        d: note.d,
        rotZ: tilt,
        color: index === 2 ? DEVBAY_COLORS.paper : DEVBAY_COLORS.paperStack,
      });
    });
  }
  return out;
}

/** Where a robot stands to work on a column of the board (room-local). */
export function boardStand(column: number): { x: number; z: number } {
  return { x: columnX(Math.min(Math.max(0, Math.floor(column)), COLUMN_COUNT - 1)), z: DEVBAY.stand.z };
}

/* ---- the card ---- */

export interface GatesCardModel {
  /** `gates x/y`, `gates unreadable` or `no gates`, exactly as the release trains show it. */
  text: string;
  state: GatesState;
  resolved: number;
  total: number;
  /** The gates in order with their state; empty when only counts are known. */
  items: GateItem[];
}

/**
 * What the selection card adds for a task's gates: every open release train, in any room, and every task in
 * Dev Bay that has gates. EAR-406 is both and gets one block. Null for any other task.
 */
export function gatesCardFor(task: OfficeTask): GatesCardModel | null {
  const train = gatesCard(task);
  if (!train && !(isBayTask(task) && task.gates)) return null;
  const row = trainRow(task);
  return { text: trainText(row), state: row.state, resolved: row.resolved, total: row.total, items: cardGateItems(task) };
}
