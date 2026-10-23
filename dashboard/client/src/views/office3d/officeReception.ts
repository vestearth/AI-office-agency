import { DESK_Z } from './officeLook';
import { SCENE_DESK_LIMIT } from './officeSelection';

export const QUEUE_CAP = 6;

/**
 * Inbox work desks sit behind the reception counter. Every other room keeps
 * `DESK_Z`. Seats stay `SLOT_Z_OFFSET` in front of whichever row they use.
 */
export const INBOX_DESK_Z = -0.55;

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
export const RECEPTION = {
  counters: [
    { file: 'desk', x: -0.58, y: 0, z: 0.72, rotY: 0, scale: 1.65 },
    { file: 'desk', x: 0.58, y: 0, z: 0.72, rotY: 0, scale: 1.65 },
  ],
  screen: { x: -0.58, y: 0.64, z: 0.52, rotY: Math.PI, scale: 1.35 },
  shelf: { file: 'bookcaseClosedWide', x: -0.2, y: 0, z: -1.5, rotY: 0, scale: 1.2 },
  plant: { x: 1.25, z: -1.2 },
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
      z: RECEPTION.shelf.z + 0.18,
      rotY: (col - 1) * 0.08,
    });
  }
  return slots;
}
