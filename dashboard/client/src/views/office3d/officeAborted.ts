import { PHASE_TO_ZONE, ZONE_BY_ID, zonePreview } from '../commandZones';
import { closedNote } from '../monitorDetail';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';

/** Largest heap, reached at 100 aborted tasks. The board carries the real number. */
export const HEAP_CAP = 36;
/** The reason is shown as written and cut to two lines of the readout (about 90 characters). */
export const BOARD_REASON_CHARS = 90;
/** Neutral and desaturated (saturation 0.035), so it is not a status color. Level is `LOUNGE_LIGHT_LEVEL`. */
export const ABORTED_LIGHT = '#d8dadd';

/** Bag and paper tones for the instanced heap. Boxes and crates take the decor wood bucket. */
export const ABORTED_COLORS = {
  bags: '#4b4e53',
  papers: '#bdb8ad',
  light: ABORTED_LIGHT,
} as const;

/**
 * Room-local Aborted layout, +z is the door. The heap fills the back-left corner at most as far as
 * x 0.45 / z -0.4, the crates stand in the back-right corner, and the three drop spots sit in the
 * free strip in front of the heap's largest footprint (a body is about 0.53 wide).
 */
export const ABORTED = {
  crates: [
    { file: 'crate', x: 1.5, y: 0, z: -1.25, rotY: 0.2, scale: 0.36 },
    { file: 'crate', x: 1.52, y: 0.5, z: -1.24, rotY: -0.25, scale: 0.36 },
    { file: 'crate', x: 0.98, y: 0, z: -1.3, rotY: -0.1, scale: 0.36 },
  ],
  /** Flat note board on the left wall. The text is a DOM readout under the room front. */
  board: { x: -2.04, y: 0.62, z: 0.42, w: 0.06, h: 0.5, d: 0.86 },
  dropSpots: [
    { x: -1.4, z: 0.05 },
    { x: -0.65, z: 0.05 },
    { x: 0.1, z: 0.05 },
  ],
} as const;

export type HeapKind = 'boxClosed' | 'boxOpen' | 'bags' | 'papers';

export const HEAP_FILES: Record<HeapKind, string> = {
  boxClosed: 'cardboardBoxClosed',
  boxOpen: 'cardboardBoxOpen',
  bags: 'trashBags',
  papers: 'debrisPapers',
};

export interface HeapSlot {
  kind: HeapKind;
  /** Room-local. y is height above the floor slab. */
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  /** Footprint radius, for clearance. */
  r: number;
}

const KIND_SCALE: Record<HeapKind, number> = { boxClosed: 1.25, boxOpen: 1.25, bags: 0.4, papers: 0.34 };
const KIND_REACH: Record<HeapKind, number> = { boxClosed: 0.2, boxOpen: 0.2, bags: 0.22, papers: 0.2 };
/** Height of one piece of each kind at its heap scale. The next piece in a stack rests on it. */
export const HEAP_PIECE_HEIGHT: Record<HeapKind, number> = { boxClosed: 0.35, boxOpen: 0.35, bags: 0.2, papers: 0.03 };
const COLUMNS = [-1.75, -1.35, -0.95, -0.55, -0.15, 0.25];
const ROWS = [-1.4, -1, -0.6];
const CORNER = { x: -2, z: -1.7 };
/**
 * Piece kinds in the order the heap grows: mostly boxes with a bag and a paper pile in every five,
 * so even a small heap is a mixed one (17 pieces: 10 boxes, 4 bags, 3 papers).
 */
const KIND_CYCLE: HeapKind[] = ['boxClosed', 'bags', 'boxOpen', 'papers', 'boxOpen'];

/** Pieces for N aborted tasks ever: min(36, ceil(3.6 * sqrt(N))). 21 gives 17, 50 gives 26. */
export function heapPieceCount(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(HEAP_CAP, Math.ceil(3.6 * Math.sqrt(total)));
}

function levelsAt(distance: number): number {
  if (distance < 1.15) return 3;
  if (distance < 1.9) return 2;
  return 1;
}

interface Candidate {
  cell: number;
  level: number;
  x: number;
  z: number;
  key: number;
}

/** Every stack position, nearest the corner and lowest first. A smaller heap is a prefix of a bigger one. */
const CANDIDATES: Candidate[] = (() => {
  const list: Candidate[] = [];
  let cell = 0;
  for (const z of ROWS) {
    for (const x of COLUMNS) {
      const distance = Math.hypot(x - CORNER.x, z - CORNER.z);
      const levels = levelsAt(distance);
      for (let level = 0; level < levels; level += 1) {
        list.push({ cell, level, x, z, key: distance + level * 0.55 });
      }
      cell += 1;
    }
  }
  return list.sort((a, b) => a.key - b.key || a.cell - b.cell || a.level - b.level);
})();

/** Slots for `count` pieces, capped at 36. A piece rests on whatever the pieces below it in its stack add up to. */
export function heapSlots(count: number): HeapSlot[] {
  const total = Math.max(0, Math.min(HEAP_CAP, Math.floor(Number.isFinite(count) ? count : 0)));
  const stackHeight = new Map<number, number>();
  return CANDIDATES.slice(0, total).map((candidate, index) => {
    const kind = KIND_CYCLE[index % KIND_CYCLE.length];
    const y = stackHeight.get(candidate.cell) ?? 0;
    stackHeight.set(candidate.cell, y + HEAP_PIECE_HEIGHT[kind]);
    return {
      kind,
      x: candidate.x + (((index * 37) % 7) - 3) * 0.012,
      y,
      z: candidate.z + (((index * 53) % 7) - 3) * 0.012,
      rotY: (((index * 29) % 13) / 13) * Math.PI * 2,
      scale: KIND_SCALE[kind],
      r: KIND_REACH[kind],
    };
  });
}

/** A reason as written, whitespace folded, cut to about two readout lines and ended with an ellipsis. */
export function boardReason(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text.length <= BOARD_REASON_CHARS) return text;
  const cut = text.slice(0, BOARD_REASON_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space >= BOARD_REASON_CHARS - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface AbortedBoard {
  /** Aborted tasks in the room. */
  count: number;
  /** The most recently aborted task, by closing transition. */
  latestId: string | null;
  /** That task's own abort reason, verbatim. Null unless its last transition went into aborted. */
  reason: string | null;
}

export function abortedBoard(tasks: readonly OfficeTask[]): AbortedBoard {
  const zone = ZONE_BY_ID.get('aborted')!;
  const inRoom = tasks.filter((task) => task.phase != null && PHASE_TO_ZONE.get(task.phase) === 'aborted');
  const latest = zonePreview(zone, inRoom, 1)[0];
  if (!latest) return { count: 0, latestId: null, reason: null };
  const note = closedNote({
    phase: latest.phase,
    lastTransition: latest.lastTransition ?? null,
    statusUpdatedAt: latest.statusUpdatedAt ?? null,
  });
  const reason = note?.reason?.trim() ? note.reason : null;
  return { count: inRoom.length, latestId: latest.taskId, reason };
}

/** About one second at the heap, the existing interact clip, before the scale-down vanish. */
export const THROW_SECONDS = 1;
export const DROP_SPOT_COUNT = ABORTED.dropSpots.length;

/** World position of a drop spot. Spots are stored in Aborted-room local space. */
export function dropSpotWorld(index: number): { x: number; z: number } {
  const spot = ABORTED.dropSpots[index];
  return { x: ROOM_LAYOUT.aborted.x + (spot?.x ?? 0), z: ROOM_LAYOUT.aborted.z + (spot?.z ?? 0) };
}

/**
 * Free drop spot nearest the desk's side, lowest index on a tie. Null when all three are taken:
 * the robot then vanishes at the Aborted front, as extra robots do at the Done door.
 * Pass no seat for a robot without a desk.
 */
export function pickDropSpot(seat: { x: number } | null | undefined, taken: ReadonlySet<number>): number | null {
  const order = ABORTED.dropSpots.map((_, index) => index);
  if (seat) {
    const distance = (index: number) => Math.abs(dropSpotWorld(index).x - seat.x);
    order.sort((a, b) => distance(a) - distance(b) || a - b);
  }
  return order.find((index) => !taken.has(index)) ?? null;
}

/**
 * Drop spots still in use across data rounds. A walker holds its spot from the moment it sets
 * off until the box is thrown (`dropSpot` is cleared then) or it is gone.
 */
export function takenDropSpots(walkers: Iterable<{ dead: boolean; dropSpot: number | null }>): Set<number> {
  const taken = new Set<number>();
  for (const walker of walkers) {
    if (!walker.dead && walker.dropSpot !== null) taken.add(walker.dropSpot);
  }
  return taken;
}
