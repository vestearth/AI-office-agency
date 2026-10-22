import { PHASE_TO_ZONE, ZONE_BY_ID, summarizeZones } from '../commandZones';
import { ROOM_D, ROOM_W } from './officeLook';
import { characterSlots } from './officeCharacters';
import { characterOperator, type CharacterOperator } from './officeOperator';
import { ROOM_LAYOUT, type OfficeTask, type OfficeZoneStats } from './officeSelection';

/** Just outside the open +z face, so a waypoint is in the aisle rather than on the wall. */
export const FRONT_OUTSET = 0.45;
export const WALK_SPEED = 4;
export const SPRINT_SPEED = 8;
export const SPRINT_DISTANCE = 16;
export const CELEBRATE_SECONDS = 1.5;
export const VANISH_SECONDS = 0.4;

export interface MovePoint {
  x: number;
  z: number;
  role: 'seat' | 'door' | 'aisle';
}

export interface CharacterPlace {
  taskId: string;
  zoneId: string;
  drawn: boolean;
  terminal: 'done' | 'aborted' | null;
  seat: { x: number; z: number } | null;
  operator: CharacterOperator;
  posture: 'work' | 'blocked';
}

export interface MovePlan {
  taskId: string;
  action: 'stay' | 'enter' | 'walk' | 'shift' | 'leave' | 'vanish' | 'overflow' | 'instant';
  gait: 'walk' | 'sprint' | 'none';
  celebrate: boolean;
  vanish: boolean;
  points: MovePoint[];
}

export interface RoomRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function roomFront(zoneId: string): { x: number; z: number } {
  const layout = ROOM_LAYOUT[zoneId];
  return { x: layout.x, z: layout.z + ROOM_D / 2 + FRONT_OUTSET };
}

export function roomRect(zoneId: string): RoomRect {
  const layout = ROOM_LAYOUT[zoneId];
  return {
    minX: layout.x - ROOM_W / 2,
    maxX: layout.x + ROOM_W / 2,
    minZ: layout.z - ROOM_D / 2,
    maxZ: layout.z + ROOM_D / 2,
  };
}

export function classifyTasks(tasks: OfficeTask[], stats?: OfficeZoneStats): CharacterPlace[] {
  const resolved = stats ?? summarizeZones(tasks);
  const drawn = new Map(characterSlots(tasks, resolved).map((slot) => [slot.taskId, slot]));
  const places: CharacterPlace[] = [];
  for (const task of tasks) {
    const zoneId = task.phase ? PHASE_TO_ZONE.get(task.phase) : undefined;
    if (!zoneId) continue;
    const zone = ZONE_BY_ID.get(zoneId);
    if (!zone) continue;
    const slot = drawn.get(task.taskId);
    places.push({
      taskId: task.taskId,
      zoneId,
      drawn: Boolean(slot),
      terminal: zone.kind === 'terminal' ? (zone.id === 'aborted' ? 'aborted' : 'done') : null,
      seat: slot ? { x: slot.x, z: slot.z } : null,
      operator: slot?.operator ?? characterOperator(task.operator),
      posture: zone.kind === 'stuck' ? 'blocked' : 'work',
    });
  }
  return places;
}

function corridorXs(): number[] {
  const xs = [...new Set(Object.values(ROOM_LAYOUT).map((point) => point.x))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < xs.length; index += 1) gaps.push((xs[index - 1] + xs[index]) / 2);
  return gaps;
}

function pickCorridor(fromX: number, toX: number): number {
  const gaps = corridorXs();
  const lo = Math.min(fromX, toX);
  const hi = Math.max(fromX, toX);
  const between = gaps.find((x) => x > lo + 0.01 && x < hi - 0.01);
  if (between !== undefined) return between;
  return gaps.reduce((best, x) => (Math.abs(x - fromX) < Math.abs(best - fromX) ? x : best));
}

function dedupe(points: MovePoint[]): MovePoint[] {
  const out: MovePoint[] = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - point.x, prev.z - point.z) < 0.05) continue;
    out.push(point);
  }
  return out;
}

/** Fixed aisle waypoints. Not a search: same-row traffic stays on the front line, row changes use the column gap. */
function betweenDoors(fromDoor: MovePoint, toDoor: MovePoint): MovePoint[] {
  if (Math.abs(fromDoor.z - toDoor.z) < 0.2) return [toDoor];
  const cx = pickCorridor(fromDoor.x, toDoor.x);
  const points: MovePoint[] = [];
  if (Math.abs(fromDoor.x - cx) > 0.05) points.push({ x: cx, z: fromDoor.z, role: 'aisle' });
  if (Math.abs(fromDoor.z - toDoor.z) > 0.05) points.push({ x: cx, z: toDoor.z, role: 'aisle' });
  points.push(toDoor);
  return points;
}

function doorPoint(zoneId: string): MovePoint {
  const door = roomFront(zoneId);
  return { x: door.x, z: door.z, role: 'door' };
}

function seatPoint(seat: { x: number; z: number }): MovePoint {
  return { x: seat.x, z: seat.z, role: 'seat' };
}

function withGait(taskId: string, action: MovePlan['action'], points: MovePoint[], extra: Pick<MovePlan, 'celebrate' | 'vanish'>): MovePlan {
  const clean = dedupe(points);
  const distance = polylineLength(clean);
  const gait = distance >= SPRINT_DISTANCE ? 'sprint' : distance > 0.05 ? 'walk' : 'none';
  return { taskId, action, gait, points: clean, ...extra };
}

function polylineLength(points: MovePoint[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  return distance;
}

export function planTravelSeconds(plan: MovePlan): number {
  if (plan.gait === 'none') return 0;
  const speed = plan.gait === 'sprint' ? SPRINT_SPEED : WALK_SPEED;
  return polylineLength(plan.points) / speed;
}

function stay(place: CharacterPlace): MovePlan {
  return {
    taskId: place.taskId,
    action: 'stay',
    gait: 'none',
    celebrate: false,
    vanish: false,
    points: place.seat ? [seatPoint(place.seat)] : [],
  };
}

function instant(place: CharacterPlace | null, taskId: string): MovePlan {
  return {
    taskId,
    action: 'instant',
    gait: 'none',
    celebrate: false,
    vanish: !place?.drawn,
    points: place?.seat ? [seatPoint(place.seat)] : [],
  };
}

function enterPoints(place: CharacterPlace): MovePoint[] {
  const inbox = doorPoint('inbox');
  const points: MovePoint[] = [inbox];
  if (place.zoneId !== 'inbox') points.push(...betweenDoors(inbox, doorPoint(place.zoneId)));
  if (place.seat) points.push(seatPoint(place.seat));
  return points;
}

/**
 * What changed between two loads.
 * `initial` is the first snapshot: drawn tasks are already in their chairs.
 * A later task with no previous place walks in through the Inbox front.
 */
export function planMove(
  prev: CharacterPlace | null,
  next: CharacterPlace | null,
  options: { reducedMotion: boolean; initial: boolean },
): MovePlan | null {
  const taskId = next?.taskId ?? prev?.taskId;
  if (!taskId) return null;
  if (options.reducedMotion) {
    if (options.initial && !next?.drawn) return null;
    return instant(next, taskId);
  }
  if (options.initial) {
    if (!next?.drawn) return null;
    return stay(next);
  }
  if (!prev && next?.drawn && next.seat) {
    return withGait(taskId, 'enter', enterPoints(next), { celebrate: false, vanish: false });
  }
  if (!prev && next && !next.drawn && !next.terminal) {
    return withGait(taskId, 'overflow', [...enterPoints({ ...next, seat: null })], { celebrate: false, vanish: true });
  }
  if (!prev) return null;
  if (!next) return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, points: [] };
  if (next.terminal === 'aborted') {
    return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, points: [] };
  }
  if (next.terminal === 'done' && prev.seat) {
    return withGait(taskId, 'leave', [seatPoint(prev.seat), doorPoint(prev.zoneId)], { celebrate: true, vanish: true });
  }
  if (prev.drawn && prev.seat && next.drawn && next.seat && prev.zoneId === next.zoneId) {
    if (Math.hypot(prev.seat.x - next.seat.x, prev.seat.z - next.seat.z) < 0.05) return stay(next);
    return withGait(taskId, 'shift', [seatPoint(prev.seat), seatPoint(next.seat)], { celebrate: false, vanish: false });
  }
  if (prev.drawn && prev.seat && next.drawn && next.seat) {
    const points = [seatPoint(prev.seat), doorPoint(prev.zoneId), ...betweenDoors(doorPoint(prev.zoneId), doorPoint(next.zoneId)), seatPoint(next.seat)];
    return withGait(taskId, 'walk', points, { celebrate: false, vanish: false });
  }
  if (prev.seat && !next.drawn && !next.terminal) {
    const points = [seatPoint(prev.seat), doorPoint(prev.zoneId), ...betweenDoors(doorPoint(prev.zoneId), doorPoint(next.zoneId))];
    return withGait(taskId, 'overflow', points, { celebrate: false, vanish: true });
  }
  if (next.drawn && next.seat) return stay(next);
  return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, points: [] };
}
