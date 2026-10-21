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
