import { PHASE_TO_ZONE, ZONE_BY_ID, ZONES, summarizeZones } from '../commandZones';
import { FLOOR_TOP, ROOM_D, ROOM_W, resolveDeskRow, type DeskRowMap, type ShownDesk } from './officeLook';
import { FACING_Y, SEAT_Y, characterSlots, type CharacterSlot } from './officeCharacters';
import { characterOperator, type CharacterOperator } from './officeOperator';
import { ABORTED, DROP_SPOT_COUNT, THROW_SECONDS, dropSpotWorld, pickDropSpot } from './officeAborted';
import { SIT_SECONDS, loungeSeatWorld, lowestFreeLoungeSeat } from './officeLounge';
import { INBOX_AISLE_Z, PICKUP_SECONDS, PICKUP_SPOTS, SIDE_LANE_X, receptionWorld } from './officeReception';
import { BLOCKED } from './officeBlocked';
import { ESCALATION, PRESS_SECONDS, escalationSpotOf } from './officeEscalation';
import { ROOM_LAYOUT, SCENE_DESK_LIMIT, desksForZone, sceneDesks, type OfficeTask, type OfficeZoneStats } from './officeSelection';

/** Just outside the open +z face, so a waypoint is in the aisle rather than on the wall. */
export const FRONT_OUTSET = 0.45;
export const WALK_SPEED = 4;
export const SPRINT_SPEED = 8;
export const SPRINT_DISTANCE = 16;
export const CELEBRATE_SECONDS = 1.5;
export const VANISH_SECONDS = 0.4;
export { SIT_SECONDS, PICKUP_SECONDS, THROW_SECONDS, PRESS_SECONDS };

export interface MovePoint {
  x: number;
  z: number;
  role: 'seat' | 'door' | 'aisle' | 'pickup' | 'throw' | 'inside' | 'press';
}

export interface CharacterPlace {
  taskId: string;
  zoneId: string;
  drawn: boolean;
  terminal: 'done' | 'aborted' | null;
  seat: { x: number; z: number } | null;
  operator: CharacterOperator;
  posture: CharacterSlot['posture'];
  /** Whether the robot sits or stands once it arrives. */
  stance: CharacterSlot['stance'];
  /** The way the robot faces at rest. */
  facing: number;
}

export interface MovePlan {
  taskId: string;
  action: 'stay' | 'enter' | 'walk' | 'shift' | 'leave' | 'vanish' | 'overflow' | 'instant';
  gait: 'walk' | 'sprint' | 'none';
  celebrate: boolean;
  vanish: boolean;
  /** Seconds to stay seated after the route, before a delivery vanishes. */
  sitSeconds: number;
  /** Lounge seat this delivery reserved. Null when it does not sit. */
  seatIndex: number | null;
  /** Aborted drop spot this walk reserved. Null or absent when it does not throw. */
  dropSpot?: number | null;
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

/** A failed fetch leaves `loadedAt` null, so the empty task list must not boot the cast. */
export function officeSnapshotSettled(loadedAt: string | null): boolean {
  return loadedAt != null;
}

export type FootStance = 'sit' | 'stand' | 'celebrate';

/** Standing feet rest on the room slab. The aisle floor is y = 0. */
export function standY(x: number, z: number): number {
  for (const zone of ZONES) {
    const rect = roomRect(zone.id);
    if (x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ) return FLOOR_TOP;
  }
  return 0;
}

/**
 * Sitting drops by the sit-pose leg offset. Standing and celebrating keep
 * the floor under the feet, so the sit offset is not subtracted.
 */
export function actorRootY(x: number, z: number, stance: FootStance, sitDrop: number): number {
  if (stance === 'sit') return SEAT_Y - sitDrop;
  return standY(x, z);
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

export function classifyTasks(tasks: OfficeTask[], stats?: OfficeZoneStats, rows?: DeskRowMap | null): CharacterPlace[] {
  const resolved = stats ?? summarizeZones(tasks);
  const drawn = new Map(characterSlots(tasks, resolved, rows).map((slot) => [slot.taskId, slot]));
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
      posture: slot?.posture ?? (zone.kind === 'stuck' ? 'blocked' : 'work'),
      stance: slot?.stance ?? 'sit',
      facing: slot?.rotY ?? FACING_Y,
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

function withGait(
  taskId: string,
  action: MovePlan['action'],
  points: MovePoint[],
  extra: Pick<MovePlan, 'celebrate' | 'vanish'> & { sitSeconds?: number; seatIndex?: number | null; dropSpot?: number | null },
): MovePlan {
  const clean = dedupe(points);
  const distance = polylineLength(clean);
  const gait = distance >= SPRINT_DISTANCE ? 'sprint' : distance > 0.05 ? 'walk' : 'none';
  return {
    taskId,
    action,
    gait,
    points: clean,
    sitSeconds: extra.sitSeconds ?? 0,
    seatIndex: extra.seatIndex ?? null,
    dropSpot: extra.dropSpot ?? null,
    celebrate: extra.celebrate,
    vanish: extra.vanish,
  };
}

function polylineLength(points: MovePoint[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  return distance;
}

export function planTravelSeconds(plan: MovePlan): number {
  const pauses = plan.points.filter((point) => point.role === 'pickup').length * PICKUP_SECONDS
    + plan.points.filter((point) => point.role === 'throw').length * THROW_SECONDS
    + plan.points.filter((point) => point.role === 'press').length * PRESS_SECONDS;
  if (plan.gait === 'none') return pauses;
  const speed = plan.gait === 'sprint' ? SPRINT_SPEED : WALK_SPEED;
  return polylineLength(plan.points) / speed + pauses;
}

/**
 * A place change mid-walk used to restart at `points[0]`, which is the desk
 * the robot already left. Keep the current feet and join the nearest waypoint
 * of the new route.
 */
export function resumeMove(current: { x: number; z: number }, plan: MovePlan): MovePlan {
  if (plan.points.length === 0 || plan.action === 'stay' || plan.action === 'instant' || plan.action === 'vanish') {
    return plan;
  }
  let nearest = 0;
  let best = Infinity;
  for (let index = 0; index < plan.points.length; index += 1) {
    const dist = Math.hypot(plan.points[index].x - current.x, plan.points[index].z - current.z);
    if (dist < best) {
      best = dist;
      nearest = index;
    }
  }
  const rest = plan.points.slice(nearest);
  const start = rest[0];
  const here: MovePoint = { x: current.x, z: current.z, role: 'aisle' };
  const points = Math.hypot(here.x - start.x, here.z - start.z) < 0.05 ? rest : [here, ...rest];
  const resumed = withGait(plan.taskId, plan.action, points, {
    celebrate: plan.celebrate,
    vanish: plan.vanish,
    sitSeconds: plan.sitSeconds,
    seatIndex: plan.seatIndex,
    dropSpot: plan.dropSpot,
  });
  if (plan.gait === 'walk' && resumed.gait === 'sprint') return { ...resumed, gait: 'walk' };
  return resumed;
}

function stay(place: CharacterPlace): MovePlan {
  return {
    taskId: place.taskId,
    action: 'stay',
    gait: 'none',
    celebrate: false,
    vanish: false,
    sitSeconds: 0,
    seatIndex: null,
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
    sitSeconds: 0,
    seatIndex: null,
    points: place?.seat ? [seatPoint(place.seat)] : [],
  };
}

function takenLoungeSeats(options: { loungeTaken?: number; takenSeats?: ReadonlySet<number> }): Set<number> {
  if (options.takenSeats) return new Set(options.takenSeats);
  const seats = new Set<number>();
  for (let index = 0; index < (options.loungeTaken ?? 0); index += 1) seats.add(index);
  return seats;
}

/** Celebrate at the old desk, walk the aisle, then sit in the lowest free seat or vanish at the Done door. */
function deliverRoute(prev: CharacterPlace, taken: ReadonlySet<number>): { points: MovePoint[]; sitSeconds: number; seatIndex: number | null } {
  const exit = doorPoint(prev.zoneId);
  const arrival = doorPoint('done');
  const points = [...depart(prev), ...betweenDoors(exit, arrival)];
  const seatIndex = lowestFreeLoungeSeat(taken);
  if (seatIndex === null) return { points, sitSeconds: 0, seatIndex: null };
  return { points: [...points, seatPoint(loungeSeatWorld(seatIndex))], sitSeconds: SIT_SECONDS, seatIndex };
}

/**
 * Out the desk's room front, along the aisles, in the Aborted front and up the middle lane to a
 * drop spot in front of the heap. Without a spot (all three taken) the walk ends at the front.
 */
function throwRoute(prev: CharacterPlace, spot: number | null): MovePoint[] {
  const exit = doorPoint(prev.zoneId);
  const arrival = doorPoint('aborted');
  const points = [...depart(prev), ...betweenDoors(exit, arrival)];
  if (spot === null) return points;
  const lane = ABORTED.dropSpots[0].z;
  points.push({ x: arrival.x, z: ROOM_LAYOUT.aborted.z + lane, role: 'aisle' });
  points.push({ ...dropSpotWorld(spot), role: 'throw' });
  return points;
}

function insideInbox(point: { x: number; z: number }): boolean {
  const rect = roomRect('inbox');
  return point.x > rect.minX && point.x < rect.maxX && point.z > rect.minZ && point.z < rect.maxZ;
}

function spotIndex(spot: number | null | undefined): number | null {
  if (spot === null) return null;
  const index = spot ?? 0;
  return index >= 0 && index < PICKUP_SPOTS.length ? index : null;
}

/**
 * First free counter spot, the one on the seat's side of the counter first so the walker
 * does not cross the whole counter front. Null when all three are taken: skip the envelope.
 * Pass no seat for a task that is not going to an Inbox desk.
 */
export function pickPickupSpot(seat: { x: number } | null | undefined, taken: ReadonlySet<number>): number | null {
  const order = PICKUP_SPOTS.map((_, index) => index);
  if (seat && seat.x - ROOM_LAYOUT.inbox.x >= 0) order.reverse();
  return order.find((index) => !taken.has(index)) ?? null;
}

function counterSide(localX: number): number {
  return localX < 0 ? -SIDE_LANE_X : SIDE_LANE_X;
}

/** Door, the counter front, the side lane, a cross walk at INBOX_AISLE_Z, then down to the seat. A null spot skips the envelope. */
function aroundToInboxSeat(seat: { x: number; z: number }, spot: number | null): MovePoint[] {
  const side = counterSide(seat.x - ROOM_LAYOUT.inbox.x);
  const frontZ = PICKUP_SPOTS[0].z;
  const points: MovePoint[] = [doorPoint('inbox')];
  if (spot !== null) points.push({ ...receptionWorld(PICKUP_SPOTS[spot]), role: 'pickup' });
  points.push({ ...receptionWorld({ x: side, z: frontZ }), role: 'aisle' });
  points.push({ ...receptionWorld({ x: side, z: INBOX_AISLE_Z }), role: 'aisle' });
  points.push({ x: seat.x, z: receptionWorld({ x: 0, z: INBOX_AISLE_Z }).z, role: 'aisle' });
  points.push(seatPoint(seat));
  return points;
}

/** The same L backwards: up to the cross walk, out the side lane, counter front, door. */
function exitInbox(seat: { x: number; z: number }): MovePoint[] {
  const side = counterSide(seat.x - ROOM_LAYOUT.inbox.x);
  const frontZ = PICKUP_SPOTS[0].z;
  return [
    seatPoint(seat),
    { x: seat.x, z: receptionWorld({ x: 0, z: INBOX_AISLE_Z }).z, role: 'aisle' },
    { ...receptionWorld({ x: side, z: INBOX_AISLE_Z }), role: 'aisle' },
    { ...receptionWorld({ x: side, z: frontZ }), role: 'aisle' },
    doorPoint('inbox'),
  ];
}

/** Between a Blocked chair and the room front: the aisle behind the bench, a side lane, the front. Bench seats step straight forward first. */
function blockedLeg(seat: { x: number; z: number }): MovePoint[] {
  const layout = ROOM_LAYOUT.blocked;
  if (seat.z - layout.z > BLOCKED.bench[0].z - 0.3) return [{ x: seat.x, z: layout.z + BLOCKED.lane.frontZ, role: 'inside' }];
  const laneX = layout.x + (seat.x < layout.x ? -BLOCKED.lane.x : BLOCKED.lane.x);
  return [
    { x: seat.x, z: layout.z + BLOCKED.lane.rowZ, role: 'inside' },
    { x: laneX, z: layout.z + BLOCKED.lane.rowZ, role: 'inside' },
    { x: laneX, z: layout.z + BLOCKED.lane.frontZ, role: 'inside' },
  ];
}

/**
 * Between a help-desk spot and the room front. The desk robot goes round the right of the desk, the
 * standing robots up the left side past the bench; a bench robot steps straight forward.
 */
function escalationLeg(seat: { x: number; z: number }): MovePoint[] {
  const layout = ROOM_LAYOUT.escalation;
  if (escalationSpotOf(seat) === 'bench') return [{ x: seat.x, z: layout.z + ESCALATION.lane.frontZ, role: 'inside' }];
  if (escalationSpotOf(seat) === 'stand') {
    const leftX = layout.x + ESCALATION.lane.leftX;
    return [
      { x: leftX, z: seat.z, role: 'inside' },
      { x: leftX, z: layout.z + ESCALATION.lane.leftZ, role: 'inside' },
      { x: layout.x, z: layout.z + ESCALATION.lane.leftZ, role: 'inside' },
    ];
  }
  const laneX = layout.x + ESCALATION.lane.x;
  return [
    { x: laneX, z: seat.z, role: 'inside' },
    { x: laneX, z: layout.z + ESCALATION.lane.turnZ, role: 'inside' },
  ];
}

/**
 * The way in to a help-desk spot. A robot taking the desk first walks to the call button and presses
 * it, then goes round the right of the desk to the far side. Bench and standing robots just walk in.
 */
function escalationApproach(seat: { x: number; z: number }): MovePoint[] {
  const layout = ROOM_LAYOUT.escalation;
  if (escalationSpotOf(seat) !== 'desk') return [...escalationLeg(seat).reverse(), seatPoint(seat)];
  const laneX = layout.x + ESCALATION.lane.x;
  return [
    { x: layout.x + ESCALATION.press.x, z: layout.z + ESCALATION.press.z, role: 'press' },
    { x: laneX, z: layout.z + ESCALATION.lane.turnZ, role: 'inside' },
    { x: laneX, z: seat.z, role: 'inside' },
    seatPoint(seat),
  ];
}

/** The way from a room's door to its seat. Only the waiting room's and the help desk's seats need more than a straight line. */
function seatApproach(place: { zoneId: string; seat: { x: number; z: number } }): MovePoint[] {
  if (place.zoneId === 'blocked') return [...blockedLeg(place.seat).reverse(), seatPoint(place.seat)];
  if (place.zoneId === 'escalation') return escalationApproach(place.seat);
  return [seatPoint(place.seat)];
}

function depart(prev: CharacterPlace): MovePoint[] {
  if (prev.zoneId === 'inbox' && prev.seat) return exitInbox(prev.seat);
  if (prev.zoneId === 'blocked' && prev.seat) return [seatPoint(prev.seat), ...blockedLeg(prev.seat), doorPoint(prev.zoneId)];
  if (prev.zoneId === 'escalation' && prev.seat) return [seatPoint(prev.seat), ...escalationLeg(prev.seat), doorPoint(prev.zoneId)];
  return [seatPoint(prev.seat!), doorPoint(prev.zoneId)];
}

function enterPoints(place: CharacterPlace, spot: number | null | undefined): MovePoint[] {
  const index = spotIndex(spot);
  if (place.zoneId === 'inbox' && place.seat) return aroundToInboxSeat(place.seat, index);
  const inbox = doorPoint('inbox');
  const points: MovePoint[] = [inbox];
  if (index !== null) points.push({ ...receptionWorld(PICKUP_SPOTS[index]), role: 'pickup' }, inbox);
  if (place.zoneId !== 'inbox') points.push(...betweenDoors(inbox, doorPoint(place.zoneId)));
  if (place.seat) points.push(...seatApproach({ zoneId: place.zoneId, seat: place.seat }));
  return points;
}

/**
 * What changed between two loads.
 * `initial` is a fresh mount, including a remount: drawn tasks are already in their chairs.
 * A later task with no previous place walks in through the Inbox front.
 * A task that was hidden by a full room walks in through that room's front once a desk frees.
 */
export function needsReceptionPickup(
  prev: CharacterPlace | null,
  next: CharacterPlace,
  options: { reducedMotion: boolean; initial: boolean; snap?: boolean },
): boolean {
  if (options.reducedMotion || options.snap || options.initial) return false;
  if (!prev && next.drawn && Boolean(next.seat)) return true;
  if (!prev && !next.drawn && !next.terminal && next.zoneId !== 'inbox') return true;
  return Boolean(prev && !prev.drawn && !prev.terminal && next.drawn && next.seat && next.zoneId === 'inbox');
}

export function planMove(
  prev: CharacterPlace | null,
  next: CharacterPlace | null,
  options: {
    reducedMotion: boolean;
    initial: boolean;
    snap?: boolean;
    loungeTaken?: number;
    takenSeats?: ReadonlySet<number>;
    /** 0..2 claims a counter spot. null skips the envelope. Omitted uses spot 0. */
    pickupSpot?: number | null;
    /** 0..2 claims an Aborted drop spot. null vanishes at the Aborted front. Omitted picks the nearest. */
    dropSpot?: number | null;
  },
): MovePlan | null {
  const taskId = next?.taskId ?? prev?.taskId;
  if (!taskId) return null;
  if (options.reducedMotion || options.snap) {
    if (options.initial && !next?.drawn) return null;
    return instant(next, taskId);
  }
  if (options.initial) {
    if (!next?.drawn) return null;
    return stay(next);
  }
  if (!prev && next?.drawn && next.seat) {
    return withGait(taskId, 'enter', enterPoints(next, options.pickupSpot), { celebrate: false, vanish: false });
  }
  if (!prev && next && !next.drawn && !next.terminal && next.zoneId === 'inbox') {
    return { taskId, action: 'instant', gait: 'none', celebrate: false, vanish: true, sitSeconds: 0, seatIndex: null, points: [] };
  }
  if (!prev && next && !next.drawn && !next.terminal) {
    return withGait(taskId, 'overflow', enterPoints({ ...next, seat: null }, options.pickupSpot), { celebrate: false, vanish: true });
  }
  if (!prev) return null;
  if (!next) return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, sitSeconds: 0, seatIndex: null, points: [] };
  if (next.terminal === 'aborted' && prev.seat) {
    const requested = options.dropSpot === undefined ? pickDropSpot(prev.seat, new Set()) : options.dropSpot;
    const spot = requested !== null && requested >= 0 && requested < DROP_SPOT_COUNT ? requested : null;
    const plan = withGait(taskId, 'leave', throwRoute(prev, spot), { celebrate: false, vanish: true, dropSpot: spot });
    return { ...plan, gait: plan.gait === 'none' ? 'none' : 'walk' };
  }
  if (next.terminal === 'aborted') {
    return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, sitSeconds: 0, seatIndex: null, points: [] };
  }
  if (next.terminal === 'done' && prev.seat) {
    const delivery = deliverRoute(prev, takenLoungeSeats(options));
    const plan = withGait(taskId, 'leave', delivery.points, {
      celebrate: true,
      vanish: true,
      sitSeconds: delivery.sitSeconds,
      seatIndex: delivery.seatIndex,
    });
    return { ...plan, gait: plan.gait === 'none' ? 'none' : 'walk' };
  }
  // A neighbor entering or leaving recenters the row. Stay in the chair.
  // Standing up to walk to the new X is the overlap SPAR-39 removes.
  if (prev.drawn && prev.seat && next.drawn && next.seat && prev.zoneId === next.zoneId) {
    return stay(next);
  }
  if (prev.drawn && prev.seat && next.drawn && next.seat) {
    const arrival = next.zoneId === 'inbox' && insideInbox(next.seat)
      ? aroundToInboxSeat(next.seat, null).slice(1)
      : seatApproach({ zoneId: next.zoneId, seat: next.seat });
    const points = [...depart(prev), ...betweenDoors(doorPoint(prev.zoneId), doorPoint(next.zoneId)), ...arrival];
    return withGait(taskId, 'walk', points, { celebrate: false, vanish: false });
  }
  if (prev.seat && !next.drawn && !next.terminal) {
    const points = [...depart(prev), ...betweenDoors(doorPoint(prev.zoneId), doorPoint(next.zoneId))];
    return withGait(taskId, 'overflow', points, { celebrate: false, vanish: true });
  }
  if (!prev.drawn && !prev.terminal && next.drawn && next.seat) {
    const points = next.zoneId === 'inbox'
      ? enterPoints(next, options.pickupSpot)
      : [doorPoint(next.zoneId), ...seatApproach({ zoneId: next.zoneId, seat: next.seat })];
    return withGait(taskId, 'enter', points, { celebrate: false, vanish: false });
  }
  if (next.drawn && next.seat) return stay(next);
  return { taskId, action: 'vanish', gait: 'none', celebrate: false, vanish: true, sitSeconds: 0, seatIndex: null, points: [] };
}

export interface DeskActorState {
  moving: boolean;
  dead: boolean;
  /** Walking a finished task to the lounge. Absent means the older hold rule. */
  delivering?: boolean;
  /** Feet have left the room the desk belongs to. */
  leftOrigin?: boolean;
}

/**
 * Hold a room while a robot is walking, celebrating, or vanishing there,
 * and while a task has just arrived. Keep a desk the zone list already
 * dropped until that robot is no longer recorded in the room and has stopped.
 */
export function deskHoldForRoom(
  zoneId: string,
  previous: readonly ShownDesk[] | null,
  desiredTaskIds: readonly (string | null)[],
  prevPlaces: ReadonlyMap<string, { zoneId: string }>,
  actors: ReadonlyMap<string, DeskActorState>,
): { hold: boolean; retainTaskIds: string[] } {
  const desired = new Set(desiredTaskIds.filter((id): id is string => id != null));
  const previousIds = new Set<string>();
  const retain: string[] = [];
  for (const desk of previous ?? []) {
    if (!desk.taskId) continue;
    previousIds.add(desk.taskId);
    if (desired.has(desk.taskId)) continue;
    const actor = actors.get(desk.taskId);
    if (!actor || actor.dead) continue;
    if (actor.delivering && actor.leftOrigin) continue;
    const recordedHere = prevPlaces.get(desk.taskId)?.zoneId === zoneId;
    if (actor.moving || recordedHere) retain.push(desk.taskId);
  }
  // A row that is already full does not treat a newly promoted task as
  // arriving. It stays undrawn until the leaving desk is released, then
  // walks in through the front (D4: a desk freed in a full room).
  const previousOccupied = (previous ?? []).filter((desk) => desk.taskId);
  const arriving = previousOccupied.length < SCENE_DESK_LIMIT
    && [...desired].some((id) => !previousIds.has(id));
  const movingHere = [...actors.entries()].some(([taskId, actor]) => {
    if (!actor.moving || actor.dead || (actor.delivering && actor.leftOrigin)) return false;
    return desired.has(taskId) || prevPlaces.get(taskId)?.zoneId === zoneId || retain.includes(taskId);
  });
  return { hold: retain.length > 0 || arriving || movingHere, retainTaskIds: retain };
}

/**
 * The desk row to draw. A held room keeps occupied desks still and parks a
 * newcomer beside them. A full row does not take that newcomer: the task
 * waits undrawn until a leaving desk is released.
 */
export function commitRoomDesks(
  zoneId: string,
  tasks: OfficeTask[],
  stats: OfficeZoneStats | undefined,
  previous: readonly ShownDesk[] | null,
  options: { hold: boolean; retainTaskIds: readonly string[] },
): ShownDesk[] {
  const desired = sceneDesks(desksForZone(zoneId, tasks, stats));
  const ids: (string | null)[] = [];
  const seen = new Set<string>();
  for (const desk of desired) {
    if (desk.taskId) {
      if (seen.has(desk.taskId)) continue;
      seen.add(desk.taskId);
    }
    ids.push(desk.taskId);
  }
  if (options.hold) {
    for (const taskId of options.retainTaskIds) {
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      ids.push(taskId);
    }
  }
  let occupied = ids.filter((id): id is string => id != null);
  if (options.hold && previous?.some((desk) => desk.taskId) && occupied.length > SCENE_DESK_LIMIT) {
    const prevIds = new Set(previous.flatMap((desk) => (desk.taskId ? [desk.taskId] : [])));
    const kept = occupied.filter((id) => prevIds.has(id));
    const newcomers = occupied.filter((id) => !prevIds.has(id));
    occupied = kept.slice(0, SCENE_DESK_LIMIT);
    for (const taskId of newcomers) {
      if (occupied.length >= SCENE_DESK_LIMIT) break;
      occupied.push(taskId);
    }
  }
  const shown = occupied.length > 0 ? occupied : [null];
  const hold = options.hold && previous != null && previous.length > 0;
  return resolveDeskRow(previous, shown, hold);
}
