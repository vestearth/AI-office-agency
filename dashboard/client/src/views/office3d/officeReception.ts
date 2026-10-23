import { DESK_Z } from './officeLook';
import { ROOM_LAYOUT, SCENE_DESK_LIMIT } from './officeSelection';

export const QUEUE_CAP = 6;

/**
 * Inbox work desks sit behind the reception counter. Every other room keeps
 * `DESK_Z`. Seats stay `SLOT_Z_OFFSET` in front of whichever row they use.
 */
export const INBOX_DESK_Z = -0.95;

/**
 * Meters the counter moves toward the door from its original spot.
 * The desk row at -0.95 still leaves the side lane short of a body width,
 * and 0.08 is enough without leaving the approved 0.1 limit.
 */
export const COUNTER_DOOR_SHIFT = 0.08;

/**
 * Cross walk between the counter and the seated row. The window that clears both is
 * 0.113..0.173 (seated robots at -0.45 need 0.563, the counter at 0.44 needs 0.267).
 * 0.15 sits inside it with about 0.02 spare on each side.
 */
export const INBOX_AISLE_Z = 0.15;

/** Side lane x, beside the counter end (the counter ends at 1.22). */
export const SIDE_LANE_X = 1.62;

export function deskZ(zoneId: string): number {
  return zoneId === 'inbox' ? INBOX_DESK_Z : DESK_Z;
}

/** Inbox tasks past the four drawn desks. Zero when the desks cover them, six at most. */
export function queueBoxCount(inboxTasks: number): number {
  const tasks = Number.isFinite(inboxTasks) ? inboxTasks : 0;
  return Math.min(QUEUE_CAP, Math.max(0, Math.floor(tasks) - SCENE_DESK_LIMIT));
}

/**
 * Room-local reception. The counter is just inside the door (+z) and faces it.
 * The shelf is on the back wall. The monitor sits on the counter, facing the
 * receptionist (rotY PI; desk monitors use rotY 0 toward the chair).
 */
const COUNTER_Z = 0.72 + COUNTER_DOOR_SHIFT;
const PICKUP_Z = 1.36 + COUNTER_DOOR_SHIFT;

export const RECEPTION = {
  counters: [
    { file: 'desk', x: -0.58, y: 0, z: COUNTER_Z, rotY: 0, scale: 1.65 },
    { file: 'desk', x: 0.58, y: 0, z: COUNTER_Z, rotY: 0, scale: 1.65 },
  ],
  screen: { x: -0.58, y: 0.64, z: 0.52 + COUNTER_DOOR_SHIFT, rotY: Math.PI, scale: 1.35 },
  shelf: { file: 'bookcaseClosedWide', x: -0.2, y: 0, z: -1.5, rotY: 0, scale: 1.2 },
  plant: { x: 1.88, z: -1.48 },
} as const;

const SHELF_COLS = [-0.26, 0, 0.26];
const SHELF_ROWS = [0.28, 0.58];

/** One slot per waiting box, three to a shelf, capped. Offsets are room-local. */
export function queueSlots(count: number): { x: number; y: number; z: number; rotY: number }[] {
  const total = Math.max(0, Math.min(QUEUE_CAP, Math.floor(count)));
  const slots: { x: number; y: number; z: number; rotY: number }[] = [];
  for (let index = 0; index < total; index += 1) {
    const row = Math.floor(index / SHELF_COLS.length);
    const col = index % SHELF_COLS.length;
    slots.push({
      x: RECEPTION.shelf.x + SHELF_COLS[col],
      y: SHELF_ROWS[row] ?? SHELF_ROWS[SHELF_ROWS.length - 1],
      z: RECEPTION.shelf.z + 0.06,
      rotY: (col - 1) * 0.08,
    });
  }
  return slots;
}

/** About one second. The walker uses the existing interact-right clip. */
export const PICKUP_SECONDS = 1;
/** Warm white, the same family as the Done coffee-table box. */
export const ENVELOPE_COLOR = '#f3ecdf';

/**
 * Three spots in front of the counter, inside the open door, each facing a part of the
 * counter top. Spread wider than a body (0.533) so simultaneous arrivals do not overlap.
 */
export const PICKUP_SPOTS = [
  { x: -0.8, z: PICKUP_Z },
  { x: 0, z: PICKUP_Z },
  { x: 0.8, z: PICKUP_Z },
] as const;

/** Room-local volume of the two counter desks. A route that enters it clips. */
export const COUNTER_BLOCK = {
  minX: -1.22,
  maxX: 1.22,
  minZ: 0.36 + COUNTER_DOOR_SHIFT,
  maxZ: 1.08 + COUNTER_DOOR_SHIFT,
};

/** Counter top above the floor slab: the desk model is 0.3844 tall at scale 1.65. */
export const COUNTER_TOP_Y = 0.3844 * 1.65;
/** Envelope thickness (the instanced box is scaled 0.05 tall). */
const ENVELOPE_HALF_DEPTH = 0.07;

/**
 * Where an unclaimed envelope rests for a pickup point (world x/z): the same x, on the
 * counter top, near the front edge. `y` is above the floor slab.
 */
export function envelopeOnCounter(pickup: { x: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: pickup.x,
    y: COUNTER_TOP_Y + 0.025,
    z: pickup.z - PICKUP_Z + COUNTER_BLOCK.maxZ - ENVELOPE_HALF_DEPTH - 0.04,
  };
}

/**
 * Counter spots still in use across data rounds. A walker holds its spot while its envelope
 * is on the counter (heading there, or standing at it); once it picks the envelope up
 * (`carry`) or is gone, the spot is free again.
 */
export function takenPickupSpots(
  walkers: Iterable<{ dead: boolean; envelope: string; envelopeX: number }>,
): Set<number> {
  const taken = new Set<number>();
  for (const walker of walkers) {
    if (walker.dead || walker.envelope !== 'counter') continue;
    PICKUP_SPOTS.forEach((spot, index) => {
      if (Math.abs(envelopeOnCounter(receptionWorld(spot)).x - walker.envelopeX) < 0.01) taken.add(index);
    });
  }
  return taken;
}

export function receptionWorld(local: { x: number; z: number }): { x: number; z: number } {
  return { x: ROOM_LAYOUT.inbox.x + local.x, z: ROOM_LAYOUT.inbox.z + local.z };
}

export function segmentHitsCounter(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.08));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t - ROOM_LAYOUT.inbox.x;
    const z = a.z + (b.z - a.z) * t - ROOM_LAYOUT.inbox.z;
    if (x >= COUNTER_BLOCK.minX && x <= COUNTER_BLOCK.maxX && z >= COUNTER_BLOCK.minZ && z <= COUNTER_BLOCK.maxZ) {
      return true;
    }
  }
  return false;
}
