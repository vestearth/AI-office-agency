import { ZONE_COLORS } from '../commandZones';

/**
 * Scene colors that are not status. Status light stays on `zoneTone` /
 * `ZONE_COLORS`. The one approved exception is the decorative spine, which
 * uses the same cyan as a busy room.
 */
export const SCENE = {
  background: '#0a0e14',
  ground: '#10161e',
  grid: '#1c2836',
  wall: '#314155',
  wallSide: '#3a4a5e',
  glass: '#8fb8c9',
  glassEdge: '#14fff9',
  wood: '#6a4b32',
  metal: '#3e4854',
  fabric: '#4c3b45',
  shade: '#ffe7a8',
  foliage: '#2f8f5b',
  soil: '#5c4030',
  screenOff: '#1b2430',
  rack: '#242c36',
  neonSpur: '#af5df6',
  live: '#e6edf5',
  stale: '#8b97a8',
  text: '#e6edf5',
  spark: '#d7e2ee',
} as const;

/** Decorative path down the main workflow. Approved to share `ZONE_COLORS.cyan`. */
export const NEON_SPINE = ZONE_COLORS.cyan;

export const ROOM_W = 4.2;
export const ROOM_D = 3.4;
export const WALL_H = 1.15;
export const WALL_T = 0.08;
export const FLOOR_TOP = 0.18;
export const DESK_Z = 0.35;

export function deskGap(count: number): number {
  return count > 2 ? 0.95 : 1.2;
}

export function deskLocalX(index: number, count: number): number {
  return (index - (count - 1) / 2) * deskGap(count);
}

export interface ShownDesk {
  taskId: string | null;
  localX: number;
}

/** Per-room desk rows the scene, the characters, and the side list share. */
export type DeskRowMap = Readonly<Record<string, readonly ShownDesk[]>>;

/** Keep a desk center on the slab. */
const DESK_INSET = 0.55;

export function centeredDeskRow(taskIds: readonly (string | null)[]): ShownDesk[] {
  return taskIds.map((taskId, index) => ({
    taskId,
    localX: deskLocalX(index, taskIds.length),
  }));
}

function besideLocalX(existing: readonly number[]): number {
  if (existing.length === 0) return 0;
  const gap = deskGap(existing.length + 1);
  const sorted = [...existing].sort((a, b) => a - b);
  const edge = ROOM_W / 2 - DESK_INSET;
  const right = sorted[sorted.length - 1] + gap;
  const left = sorted[0] - gap;
  if (right <= edge) return right;
  if (left >= -edge) return left;
  return Math.abs(right) <= Math.abs(left) ? edge : -edge;
}

/**
 * #108 steady state is `deskLocalX`. While `hold` is set, desks already on
 * screen keep that local X and a new task is placed beside them. A quiet
 * room recenters. Callers drop a leaving task from `shown` only after its
 * robot has vanished, so the celebration does not overlap a desk that jumped.
 */
export function resolveDeskRow(
  previous: readonly ShownDesk[] | null,
  shown: readonly (string | null)[],
  hold: boolean,
): ShownDesk[] {
  if (!hold || !previous || previous.length === 0) return centeredDeskRow(shown);
  const prevX = new Map<string, number>();
  for (const desk of previous) {
    if (desk.taskId) prevX.set(desk.taskId, desk.localX);
  }
  const kept: ShownDesk[] = [];
  const added: (string | null)[] = [];
  for (const taskId of shown) {
    if (taskId && prevX.has(taskId)) kept.push({ taskId, localX: prevX.get(taskId)! });
    else added.push(taskId);
  }
  const row = [...kept];
  for (const taskId of added) {
    row.push({ taskId, localX: besideLocalX(row.map((desk) => desk.localX)) });
  }
  row.sort((a, b) => a.localX - b.localX || String(a.taskId).localeCompare(String(b.taskId)));
  return row;
}

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Put a card beside a room's projected box, on the side with more free space, so it does not cover the room. */
export function placeBeside(
  box: ScreenBox,
  viewW: number,
  viewH: number,
  cardW: number,
  cardH: number,
  gap = 12,
): { x: number; y: number } {
  const rightX = box.right + gap;
  const leftX = box.left - gap - cardW;
  const rightFits = rightX >= 0 && rightX + cardW <= viewW;
  const leftFits = leftX >= 0 && leftX + cardW <= viewW;
  if (rightFits || leftFits) {
    const x = rightFits && (!leftFits || viewW - (rightX + cardW) >= leftX) ? rightX : leftX;
    return clampOverlay(x, box.top, viewW, viewH, cardW, cardH);
  }
  return clampOverlay(box.left, box.bottom + gap, viewW, viewH, cardW, cardH);
}

export function clampOverlay(
  x: number,
  y: number,
  viewW: number,
  viewH: number,
  boxW: number,
  boxH: number,
): { x: number; y: number } {
  const maxX = Math.max(0, viewW - boxW);
  const maxY = Math.max(0, viewH - boxH);
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
  };
}
