import { describe, expect, it } from 'vitest';
import { ZONES } from '../commandZones';
import { FLOOR_TOP, deskLocalX } from './officeLook';
import { CHARACTER_HEIGHT, SEAT_Y, SLOT_Z_OFFSET } from './officeCharacters';
import { COUNTER_BLOCK, COUNTER_TOP_Y, PICKUP_SPOTS, RECEPTION, deskZ, envelopeOnCounter, receptionWorld, segmentHitsCounter, takenPickupSpots } from './officeReception';
import { buildOfficePoses } from './officeLayout';
import { LOUNGE_SEAT_COUNT, SIT_SECONDS, loungeSeatWorld } from './officeLounge';
import { ABORTED, DROP_SPOT_COUNT, THROW_SECONDS, dropSpotWorld, heapSlots, pickDropSpot, takenDropSpots } from './officeAborted';
import { BLOCKED } from './officeBlocked';
import { ROOM_LAYOUT, officeDesks } from './officeSelection';
import { summarizeZones as zoneStats } from '../commandZones';
import {
  actorRootY,
  classifyTasks,
  commitRoomDesks,
  deskHoldForRoom,
  officeSnapshotSettled,
  WALK_SPEED,
  planMove,
  planTravelSeconds,
  resumeMove,
  roomFront,
  roomRect,
  standY,
  type CharacterPlace,
  type MovePlan,
  type MovePoint,
  pickPickupSpot,
} from './officeMove';
import type { OfficeTask } from './officeSelection';

const task = (over: Partial<OfficeTask> & Pick<OfficeTask, 'taskId' | 'phase' | 'status'>): OfficeTask => ({
  title: over.taskId,
  needsReview: false,
  ...over,
});

const live = { reducedMotion: false, initial: false };
const boot = { reducedMotion: false, initial: true };
const reduced = { reducedMotion: true, initial: false };

function place(taskId: string, phase: OfficeTask['phase'], status: OfficeTask['status'], extra: Partial<OfficeTask> = {}): CharacterPlace {
  const [found] = classifyTasks([task({ taskId, phase, status, ...extra })]);
  return found;
}

function near(point: { x: number; z: number }, target: { x: number; z: number }): boolean {
  return Math.hypot(point.x - target.x, point.z - target.z) < 0.001;
}

function segmentStaysAtInbox(a: MovePoint, b: MovePoint): boolean {
  const inbox = roomRect('inbox');
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.12));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const inInbox = x > inbox.minX + 0.02 && x < inbox.maxX - 0.02 && z > inbox.minZ + 0.02 && z < inbox.maxZ - 0.02;
    const apron = x > inbox.minX && x < inbox.maxX && z >= inbox.maxZ - 0.05 && z <= inbox.maxZ + 0.8;
    if (!inInbox && !apron) return false;
  }
  return true;
}

/** A walk inside one room, between its seats and the front: it stays on the slab or the apron in front of it. */
function segmentStaysAtRoom(zoneId: string, a: MovePoint, b: MovePoint): boolean {
  const blocked = roomRect(zoneId);
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.12));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const inRoom = x > blocked.minX + 0.02 && x < blocked.maxX - 0.02 && z > blocked.minZ + 0.02 && z < blocked.maxZ - 0.02;
    const apron = x > blocked.minX && x < blocked.maxX && z >= blocked.maxZ - 0.05 && z <= blocked.maxZ + 0.8;
    if (!inRoom && !apron) return false;
  }
  return true;
}

/** The waiting room's and the help desk's seats walk to the front inside their own room. */
function segmentStaysAtBlocked(a: MovePoint, b: MovePoint): boolean {
  return segmentStaysAtRoom('blocked', a, b) || segmentStaysAtRoom('escalation', a, b);
}

function interior(a: MovePoint, b: MovePoint): boolean {
  if (a.role === 'inside' || b.role === 'inside' || a.role === 'press' || b.role === 'press') return segmentStaysAtBlocked(a, b);
  if (segmentHitsCounter(a, b)) return false;
  const roles = `${a.role}:${b.role}`;
  if (roles === 'seat:door' || roles === 'door:seat') return true;
  if (!segmentStaysAtInbox(a, b)) return false;
  const pair = [a.role, b.role].sort().join(':');
  return pair === 'door:pickup' || pair === 'aisle:pickup' || pair === 'pickup:seat' || pair === 'aisle:door' || pair === 'aisle:seat' || pair === 'aisle:aisle';
}

function crossesRoom(a: MovePoint, b: MovePoint): string | null {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.15));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const zone of ZONES) {
      const rect = roomRect(zone.id);
      const inside = x > rect.minX + 0.02 && x < rect.maxX - 0.02 && z > rect.minZ + 0.02 && z < rect.maxZ - 0.02;
      if (inside) return zone.id;
    }
  }
  return null;
}

function aisleIsClear(plan: MovePlan): void {
  for (let index = 1; index < plan.points.length; index += 1) {
    const from = plan.points[index - 1];
    const to = plan.points[index];
    if (interior(from, to)) continue;
    expect(crossesRoom(from, to), `${from.role}->${to.role}`).toBeNull();
  }
}

/** Aisles up to the Aborted front stay out of every room; past the front only the Aborted room may be entered. */
function abortedWalkIsClear(plan: MovePlan): void {
  const front = plan.points.findIndex((point) => point.role === 'door' && near(point, roomFront('aborted')));
  expect(front).toBeGreaterThan(0);
  for (let index = 1; index < plan.points.length; index += 1) {
    const from = plan.points[index - 1];
    const to = plan.points[index];
    const entered = crossesRoom(from, to);
    if (index > front) expect(entered === null || entered === 'aborted', `${from.role}->${to.role}`).toBe(true);
    else if (!interior(from, to)) expect(entered, `${from.role}->${to.role}`).toBeNull();
  }
}

function footprint(x: number, z: number, width: number, depth: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return { minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2 };
}

function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz || 1e-12;
  const t = Math.min(1, Math.max(0, ((px - ax) * abx + (pz - az) * abz) / len2));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function distSegSeg(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  const ux = bx - ax;
  const uz = bz - az;
  const vx = dx - cx;
  const vz = dz - cz;
  const wx = ax - cx;
  const wz = az - cz;
  const a = ux * ux + uz * uz;
  const b = ux * vx + uz * vz;
  const c = vx * vx + vz * vz;
  const d = ux * wx + uz * wz;
  const e = vx * wx + vz * wz;
  const denom = a * c - b * b;
  let sN: number;
  let sD = denom;
  let tN: number;
  let tD = denom;
  if (denom < 1e-9) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0;
    else if (-d > a) sN = sD;
    else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0;
    else if (-d + b > a) sN = sD;
    else {
      sN = -d + b;
      sD = a;
    }
  }
  const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD;
  const tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD;
  return Math.hypot(wx + sc * ux - tc * vx, wz + sc * uz - tc * vz);
}

function distSegRect(
  ax: number, az: number, bx: number, bz: number,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number },
): number {
  const edges: Array<[number, number, number, number]> = [
    [rect.minX, rect.minZ, rect.maxX, rect.minZ],
    [rect.maxX, rect.minZ, rect.maxX, rect.maxZ],
    [rect.maxX, rect.maxZ, rect.minX, rect.maxZ],
    [rect.minX, rect.maxZ, rect.minX, rect.minZ],
  ];
  return Math.min(...edges.map(([cx, cz, dx, dz]) => distSegSeg(ax, az, bx, bz, cx, cz, dx, dz)));
}

function carriesEnvelope(plan: MovePlan | null): boolean {
  return Boolean(plan?.points.some((point) => point.role === 'pickup'));
}

function walkSeconds(plan: MovePlan): number {
  let distance = 0;
  for (let index = 1; index < plan.points.length; index += 1) {
    distance += Math.hypot(plan.points[index].x - plan.points[index - 1].x, plan.points[index].z - plan.points[index - 1].z);
  }
  const speed = plan.gait === 'sprint' ? 8 : WALK_SPEED;
  return distance / speed;
}

describe('move planner', () => {
  it('walks a zone change out the front, along the aisle, and in the target front', () => {
    const plan = planMove(place('M', 'assigned', 'running'), place('M', 'in_review', 'waiting_review'), live);
    expect(plan?.action).toBe('walk');
    expect(plan?.gait).toBe('walk');
    expect(plan?.celebrate).toBe(false);
    expect(plan?.vanish).toBe(false);
    const doors = plan!.points.filter((point) => point.role === 'door');
    expect(doors.some((point) => near(point, roomFront('dev')))).toBe(true);
    expect(doors.some((point) => near(point, roomFront('review')))).toBe(true);
    expect(plan!.points.some((point) => point.role === 'aisle')).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('seat');
    const seconds = planTravelSeconds(plan!);
    expect(seconds).toBeGreaterThanOrEqual(2);
    expect(seconds).toBeLessThanOrEqual(4);
    aisleIsClear(plan!);
  });

  it('sprints a long route and still finishes in about 2-4s without cutting rooms', () => {
    const plan = planMove(place('M', 'escalated', 'running'), place('M', 'blocked', 'blocked'), live);
    expect(plan?.action).toBe('walk');
    expect(plan?.gait).toBe('sprint');
    expect(plan!.points.some((point) => near(point, roomFront('escalation')))).toBe(true);
    expect(plan!.points.some((point) => near(point, roomFront('blocked')))).toBe(true);
    const seconds = planTravelSeconds(plan!);
    expect(seconds).toBeGreaterThanOrEqual(2);
    expect(seconds).toBeLessThanOrEqual(4);
    aisleIsClear(plan!);
  });

  it('brings a new task in through the Inbox front', () => {
    const inbox = planMove(null, place('N', 'pending', 'queued'), live);
    expect(inbox?.action).toBe('enter');
    expect(near(inbox!.points[0], roomFront('inbox'))).toBe(true);
    expect(inbox!.points.at(-1)?.role).toBe('seat');
    const dev = planMove(null, place('N', 'assigned', 'running'), live);
    expect(dev?.action).toBe('enter');
    expect(near(dev!.points[0], roomFront('inbox'))).toBe(true);
    expect(dev!.points.some((point) => near(point, roomFront('dev')))).toBe(true);
    aisleIsClear(dev!);
  });

  it('stops a new task at the Inbox counter before the seat', () => {
    const inbox = planMove(null, place('N', 'pending', 'queued'), live)!;
    expect(inbox.points[0].role).toBe('door');
    expect(inbox.points[1]?.role).toBe('pickup');
    expect(inbox.points.at(-1)?.role).toBe('seat');
    expect(carriesEnvelope(inbox)).toBe(true);
    aisleIsClear(inbox);
    const dev = planMove(null, place('N', 'assigned', 'running'), live)!;
    expect(dev.points[1]?.role).toBe('pickup');
    expect(dev.points.some((point) => near(point, roomFront('dev')))).toBe(true);
    aisleIsClear(dev);
  });

  it('adds the pickup to an overflow route that is not the Inbox', () => {
    const crowd = [0, 1, 2, 3, 4].map((index) => task({
      taskId: `R${index}`,
      phase: 'in_review',
      status: 'waiting_review',
      updatedAt: `2026-10-0${index + 1}T00:00:00Z`,
    }));
    const hidden = classifyTasks(crowd).find((item) => item.taskId === 'R4');
    expect(hidden?.drawn).toBe(false);
    const plan = planMove(null, hidden!, live)!;
    expect(plan.action).toBe('overflow');
    expect(plan.vanish).toBe(true);
    expect(near(plan.points[0], roomFront('inbox'))).toBe(true);
    expect(plan.points[1]?.role).toBe('pickup');
    expect(plan.points.some((point) => near(point, roomFront('review')))).toBe(true);
    aisleIsClear(plan);
  });

  it('pauses about a second at the pickup and skips the envelope otherwise', () => {
    const liveEnter = planMove(null, place('N', 'pending', 'queued'), live)!;
    expect(liveEnter.points.filter((point) => point.role === 'pickup')).toHaveLength(1);
    expect(planTravelSeconds(liveEnter) - walkSeconds(liveEnter)).toBeCloseTo(1, 1);
    expect(carriesEnvelope(planMove(null, place('N', 'pending', 'queued'), boot))).toBe(false);
    expect(carriesEnvelope(planMove(null, place('N', 'pending', 'queued'), reduced))).toBe(false);
    expect(carriesEnvelope(planMove(null, place('N', 'pending', 'queued'), { ...live, snap: true }))).toBe(false);
  });

  it('keeps three pick-up spots and gives a skipper no envelope', () => {
    const ids = ['A', 'B', 'C', 'D'];
    const plans = ids.map((id, index) => planMove(null, place(id, 'pending', 'queued'), {
      ...live,
      pickupSpot: index < 3 ? index : null,
    })!);
    const spots = plans.slice(0, 3).map((plan) => plan.points.find((point) => point.role === 'pickup'));
    expect(spots.every((point) => point)).toBe(true);
    expect(new Set(spots.map((point) => `${point!.x.toFixed(2)}:${point!.z.toFixed(2)}`)).size).toBe(3);
    expect(plans[3].points.some((point) => point.role === 'pickup')).toBe(false);
    expect(carriesEnvelope(plans[3])).toBe(false);
    aisleIsClear(plans[3]);
  });

  it('does not walk an arrival into a full Inbox, then picks up when a desk frees', () => {
    const crowd = [0, 1, 2, 3, 4].map((index) => task({
      taskId: `IN${index}`,
      phase: 'pending',
      status: 'queued',
      updatedAt: `2026-10-0${index + 1}T00:00:00Z`,
    }));
    const hidden = classifyTasks(crowd).find((item) => item.taskId === 'IN4');
    expect(hidden?.drawn).toBe(false);
    const arrived = planMove(null, hidden!, live)!;
    expect(arrived.points).toHaveLength(0);
    expect(carriesEnvelope(arrived)).toBe(false);
    const revealed = classifyTasks(crowd.filter((item) => item.taskId !== 'IN0')).find((item) => item.taskId === 'IN4');
    expect(revealed?.drawn).toBe(true);
    const plan = planMove(hidden!, revealed!, live)!;
    expect(plan.action).toBe('enter');
    expect(near(plan.points[0], roomFront('inbox'))).toBe(true);
    expect(plan.points[1]?.role).toBe('pickup');
    expect(plan.points.at(-1)?.role).toBe('seat');
    aisleIsClear(plan);
  });

  it('rejects a shortcut through the counter and a segment that leaves through a side wall', () => {
    const door: MovePoint = { ...roomFront('inbox'), role: 'door' };
    const seat: MovePoint = {
      x: ROOM_LAYOUT.inbox.x,
      z: ROOM_LAYOUT.inbox.z + deskZ('inbox') + SLOT_Z_OFFSET,
      role: 'seat',
    };
    const throughCounter = { points: [door, seat] } as MovePlan;
    expect(() => aisleIsClear(throughCounter)).toThrow();
    const intoDev: MovePoint = { x: ROOM_LAYOUT.dev.x, z: ROOM_LAYOUT.dev.z, role: 'pickup' };
    expect(() => aisleIsClear({ points: [door, intoDev] } as MovePlan)).toThrow();
  });

  it.each([1, 2, 3, 4])('keeps every Inbox route a body-width from seated robots and the counter with %i task(s)', (count) => {
    const body = 1.6 * (CHARACTER_HEIGHT / 2.7);
    const crowd = Array.from({ length: count }, (_, index) => task({
      taskId: `IN${index}`,
      phase: 'pending',
      status: 'queued',
      updatedAt: `2026-10-0${index + 1}T00:00:00Z`,
    }));
    const places = classifyTasks(crowd);
    const seats = places.map((item) => item.seat!);
    const poses = buildOfficePoses(crowd, zoneStats(crowd), null, null);
    const others = [
      ...poses.lamp.filter((pose) => pose.zoneId === 'inbox').map((pose) => footprint(pose.x, pose.z, 0.152 * (pose.sx ?? 1), 0.1756 * (pose.sz ?? 1))),
      ...poses.plant.map((pose) => footprint(pose.x, pose.z, 0.2121 * (pose.sx ?? 1), 0.2415 * (pose.sz ?? 1))),
      footprint(
        ROOM_LAYOUT.inbox.x + RECEPTION.shelf.x,
        ROOM_LAYOUT.inbox.z + RECEPTION.shelf.z,
        0.8 * RECEPTION.shelf.scale,
        0.25 * RECEPTION.shelf.scale,
      ),
    ];
    const plans = places.flatMap((item) => {
      const departs = planMove(item, place('OUT', 'assigned', 'running'), live);
      return [0, 1, 2, null].map((spot) => planMove(null, item, { ...live, pickupSpot: spot })).concat(departs);
    });
    let robots = Infinity;
    let counter = Infinity;
    let furniture = Infinity;
    for (const plan of plans) {
      expect(plan?.points.length).toBeGreaterThan(1);
      const own = plan!.points.find((point) => point.role === 'seat');
      for (let index = 1; index < plan!.points.length; index += 1) {
        const from = plan!.points[index - 1];
        const to = plan!.points[index];
        for (const seat of seats) {
          if (own && Math.hypot(seat.x - own.x, seat.z - own.z) < 0.05) continue;
          robots = Math.min(robots, distPointSeg(seat.x, seat.z, from.x, from.z, to.x, to.z));
        }
        counter = Math.min(counter, distSegRect(
          from.x - ROOM_LAYOUT.inbox.x,
          from.z - ROOM_LAYOUT.inbox.z,
          to.x - ROOM_LAYOUT.inbox.x,
          to.z - ROOM_LAYOUT.inbox.z,
          COUNTER_BLOCK,
        ));
        for (const obstacle of others) furniture = Math.min(furniture, distSegRect(from.x, from.z, to.x, to.z, obstacle));
      }
    }
    console.info(`inbox clearance ${count} task(s): seated robot ${robots.toFixed(3)} counter ${counter.toFixed(3)} other furniture ${furniture.toFixed(3)}`);
    expect(robots, 'nearest seated robot').toBeGreaterThanOrEqual(body + 0.03);
    expect(counter, 'nearest counter edge').toBeGreaterThanOrEqual(body / 2);
    expect(furniture, 'nearest lamp, shelf, or plant').toBeGreaterThanOrEqual(body / 2);
  });

  it('keeps every waiting-room route a body-width from seated robots and the bench with a full room', () => {
    const body = 1.6 * (CHARACTER_HEIGHT / 2.7);
    const room = [
      ...Array.from({ length: 4 }, (_, index) => task({ taskId: `E${index}`, phase: 'blocked', status: 'blocked', waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: `2026-10-0${index + 1}T00:00:00Z` })),
      ...Array.from({ length: 3 }, (_, index) => task({ taskId: `O${index}`, phase: 'blocked', status: 'blocked', waitsOn: [{ kind: 'aws_permission' }], statusUpdatedAt: `2026-10-0${index + 1}T00:00:00Z` })),
    ];
    const places = classifyTasks(room);
    expect(places.every((item) => item.drawn && item.seat)).toBe(true);
    const seats = places.map((item) => item.seat!);
    const layout = ROOM_LAYOUT.blocked;
    const bench = footprint(layout.x + BLOCKED.benchFrame.x, layout.z + BLOCKED.benchFrame.z, 0.42 * BLOCKED.benchFrame.stretch[0], 0.2 * BLOCKED.benchFrame.stretch[2]);
    let robots = Infinity;
    let frame = Infinity;
    for (const item of places) {
      const away = planMove(item, place('OUT', 'assigned', 'running'), live)!;
      const back = planMove(place('IN', 'assigned', 'running'), { ...item, drawn: true }, { ...live })!;
      for (const plan of [away, back]) {
        expect(plan.points.length).toBeGreaterThan(1);
        const own = item.seat!;
        const onBench = own.z - layout.z > BLOCKED.bench[0].z - 0.3;
        for (let index = 1; index < plan.points.length; index += 1) {
          const from = plan.points[index - 1];
          const to = plan.points[index];
          for (const seat of seats) {
            if (Math.hypot(seat.x - own.x, seat.z - own.z) < 0.05) continue;
            robots = Math.min(robots, distPointSeg(seat.x, seat.z, from.x, from.z, to.x, to.z));
          }
          // A bench robot starts on the bench, so only the chair routes keep clear of its frame.
          if (!onBench) frame = Math.min(frame, distSegRect(from.x, from.z, to.x, to.z, bench));
        }
      }
    }
    console.info(`blocked clearance: seated robot ${robots.toFixed(3)} bench ${frame.toFixed(3)}`);
    expect(robots, 'nearest seated robot').toBeGreaterThanOrEqual(body + 0.03);
    expect(frame, 'nearest bench edge').toBeGreaterThanOrEqual(body / 2);
  });

  it('picks a free counter spot on the seat side first and skips when all three are taken', () => {
    const left = { x: ROOM_LAYOUT.inbox.x - 0.95 };
    const right = { x: ROOM_LAYOUT.inbox.x + 0.95 };
    const centre = { x: ROOM_LAYOUT.inbox.x };
    expect(pickPickupSpot(left, new Set())).toBe(0);
    expect(pickPickupSpot(right, new Set())).toBe(2);
    expect(pickPickupSpot(centre, new Set())).toBe(2);
    expect(pickPickupSpot(null, new Set())).toBe(0);
    expect(pickPickupSpot(left, new Set([0]))).toBe(1);
    expect(pickPickupSpot(left, new Set([0, 1]))).toBe(2);
    expect(pickPickupSpot(right, new Set([2, 1]))).toBe(0);
    expect(pickPickupSpot(left, new Set([0, 1, 2]))).toBeNull();
  });

  describe('pickup spots across data rounds', () => {
    type Walker = { dead: boolean; envelope: string; envelopeX: number };
    const seat = { x: ROOM_LAYOUT.inbox.x - 0.95 };

    /** One syncActors pass: claim a spot per arrival, and each claimant keeps its envelope on the counter. */
    function round(walkers: Walker[], arrivals: number): (number | null)[] {
      const taken = takenPickupSpots(walkers);
      const spots: (number | null)[] = [];
      for (let index = 0; index < arrivals; index += 1) {
        const spot = pickPickupSpot(seat, taken);
        spots.push(spot);
        if (spot === null) continue;
        taken.add(spot);
        walkers.push({ dead: false, envelope: 'counter', envelopeX: envelopeOnCounter(receptionWorld(PICKUP_SPOTS[spot])).x });
      }
      return spots;
    }

    it('gives a second round a different spot while the first walker is still at the counter', () => {
      const walkers: Walker[] = [];
      expect(round(walkers, 1)).toEqual([0]);
      expect(round(walkers, 1)).toEqual([1]);
      expect(round(walkers, 1)).toEqual([2]);
    });

    it('skips the pickup, with no envelope, once all three spots are in use', () => {
      const walkers: Walker[] = [];
      round(walkers, 3);
      expect(round(walkers, 1)).toEqual([null]);
      expect(walkers).toHaveLength(3);
      const plan = planMove(null, place('N', 'pending', 'queued'), { ...live, pickupSpot: null })!;
      expect(carriesEnvelope(plan)).toBe(false);
      expect(plan.points.some((point) => point.role === 'pickup')).toBe(false);
    });

    it('frees a spot once its walker has the envelope or is gone', () => {
      const walkers: Walker[] = [];
      round(walkers, 3);
      walkers[0].envelope = 'carry';
      walkers[1].dead = true;
      expect([...takenPickupSpots(walkers)]).toEqual([2]);
      expect(round(walkers, 1)).toEqual([0]);
    });
  });

  it('rests an unclaimed envelope on the counter top, in front of the screen row', () => {
    for (let spot = 0; spot < PICKUP_SPOTS.length; spot += 1) {
      const pickup = receptionWorld(PICKUP_SPOTS[spot]);
      const rest = envelopeOnCounter(pickup);
      expect(rest.x - ROOM_LAYOUT.inbox.x, `spot ${spot} x`).toBeGreaterThanOrEqual(COUNTER_BLOCK.minX);
      expect(rest.x - ROOM_LAYOUT.inbox.x, `spot ${spot} x`).toBeLessThanOrEqual(COUNTER_BLOCK.maxX);
      expect(rest.z - ROOM_LAYOUT.inbox.z, `spot ${spot} z`).toBeGreaterThanOrEqual(COUNTER_BLOCK.minZ);
      expect(rest.z - ROOM_LAYOUT.inbox.z, `spot ${spot} z`).toBeLessThanOrEqual(COUNTER_BLOCK.maxZ);
      expect(rest.y).toBeGreaterThan(COUNTER_TOP_Y);
      expect(rest.y).toBeLessThan(COUNTER_TOP_Y + 0.1);
    }
  });

  it('celebrates, walks the aisle into the lounge, sits, then vanishes', () => {
    const seated = place('M', 'assigned', 'running');
    const plan = planMove(seated, place('M', 'done', 'completed'), live);
    expect(plan).toMatchObject({ action: 'leave', celebrate: true, vanish: true, gait: 'walk', sitSeconds: SIT_SECONDS });
    expect(near(plan!.points[0], seated.seat!)).toBe(true);
    expect(near(plan!.points[1], roomFront('dev'))).toBe(true);
    expect(plan!.points.some((point) => near(point, roomFront('done')))).toBe(true);
    expect(near(plan!.points.at(-1)!, loungeSeatWorld(0))).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('seat');
    aisleIsClear(plan!);
    const second = planMove(seated, place('M', 'done', 'completed'), { ...live, loungeTaken: 1 });
    expect(near(second!.points.at(-1)!, loungeSeatWorld(1))).toBe(true);
  });

  it('vanishes at the Done door when the sofa already holds three', () => {
    const plan = planMove(
      place('M', 'assigned', 'running'),
      place('M', 'done', 'completed'),
      { ...live, loungeTaken: LOUNGE_SEAT_COUNT },
    );
    expect(plan).toMatchObject({ action: 'leave', celebrate: true, vanish: true, sitSeconds: 0 });
    expect(near(plan!.points.at(-1)!, roomFront('done'))).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('door');
    aisleIsClear(plan!);
  });

  it('sits in seat 0 when seats 1 and 2 are already taken', () => {
    const plan = planMove(
      place('M', 'assigned', 'running'),
      place('M', 'done', 'completed'),
      { ...live, loungeTaken: 2, takenSeats: new Set([1, 2]) },
    );
    expect(plan?.seatIndex).toBe(0);
    expect(near(plan!.points.at(-1)!, loungeSeatWorld(0))).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('seat');
  });

  it('does not give two deliveries the same lounge seat', () => {
    const first = planMove(place('A', 'assigned', 'running'), place('A', 'done', 'completed'), {
      ...live,
      takenSeats: new Set<number>(),
    });
    const second = planMove(place('B', 'in_review', 'waiting_review'), place('B', 'done', 'completed'), {
      ...live,
      takenSeats: new Set([first?.seatIndex ?? 0]),
    });
    expect(second?.seatIndex).not.toBe(first?.seatIndex);
    expect(new Set([first?.seatIndex, second?.seatIndex]).size).toBe(2);
  });

  it('vanishes at the desk for reduced motion and for a hidden-tab snap', () => {
    const from = place('M', 'assigned', 'running');
    const done = place('M', 'done', 'completed');
    for (const options of [reduced, { reducedMotion: false, initial: false, snap: true }]) {
      const plan = planMove(from, done, options);
      expect(plan).toMatchObject({ action: 'instant', vanish: true, gait: 'none', points: [], sitSeconds: 0 });
      expect(planTravelSeconds(plan!)).toBe(0);
    }
    const snapped = planMove(from, place('M', 'in_review', 'waiting_review'), { reducedMotion: false, initial: false, snap: true });
    expect(snapped?.action).toBe('instant');
    expect(snapped?.gait).toBe('none');
    expect(snapped?.points.every((point) => point.role === 'seat')).toBe(true);
  });

  it('places no robot in the lounge on the first snapshot', () => {
    expect(planMove(null, place('M', 'done', 'completed'), boot)).toBeNull();
    expect(planMove(place('M', 'assigned', 'running'), place('M', 'done', 'completed'), boot)).toBeNull();
  });

  it('vanishes in place when an Aborted task had no drawn robot', () => {
    const plan = planMove({ ...place('M', 'assigned', 'running'), seat: null }, place('M', 'aborted', 'cancelled'), live);
    expect(plan).toMatchObject({ action: 'vanish', celebrate: false, vanish: true, gait: 'none', points: [] });
    expect(planTravelSeconds(plan!)).toBe(0);
    const unseen = planMove({ ...place('M', 'assigned', 'running'), seat: null, drawn: false }, place('M', 'aborted', 'cancelled'), live);
    expect(unseen).toMatchObject({ action: 'vanish', vanish: true, points: [] });
  });

  describe('throwing aborted work away', () => {
    const seated = () => place('M', 'assigned', 'running');
    const aborted = () => place('M', 'aborted', 'cancelled');

    it('walks out the front, in the Aborted front, to a drop spot, pauses about a second, then vanishes', () => {
      const plan = planMove(seated(), aborted(), { ...live, dropSpot: 1 });
      expect(plan).toMatchObject({ action: 'leave', celebrate: false, vanish: true, gait: 'walk', sitSeconds: 0, dropSpot: 1 });
      expect(near(plan!.points[0], seated().seat!)).toBe(true);
      expect(near(plan!.points[1], roomFront('dev'))).toBe(true);
      expect(plan!.points.some((point) => near(point, roomFront('aborted')) && point.role === 'door')).toBe(true);
      const last = plan!.points.at(-1)!;
      expect(last.role).toBe('throw');
      expect(near(last, dropSpotWorld(1))).toBe(true);
      expect(plan!.points.filter((point) => point.role === 'throw')).toHaveLength(1);
      expect(THROW_SECONDS).toBe(1);
      expect(planTravelSeconds(plan!)).toBeGreaterThanOrEqual(THROW_SECONDS + 1);
      abortedWalkIsClear(plan!);
    });

    it('enters the room through the middle lane, never through the heap or the crates', () => {
      for (let spot = 0; spot < DROP_SPOT_COUNT; spot += 1) {
        const plan = planMove(seated(), aborted(), { ...live, dropSpot: spot })!;
        const inside = plan.points.filter((point) => point.z < roomRect('aborted').maxZ);
        const room = ROOM_LAYOUT.aborted;
        for (const point of inside) {
          const local = { x: point.x - room.x, z: point.z - room.z };
          for (const slot of heapSlots(36)) expect(Math.hypot(slot.x - local.x, slot.z - local.z)).toBeGreaterThan(slot.r + 0.27);
          for (const crate of ABORTED.crates) expect(Math.hypot(crate.x - local.x, crate.z - local.z)).toBeGreaterThan(0.35 + 0.27);
        }
      }
    });

    it('does not emote or celebrate at the desk', () => {
      const plan = planMove(seated(), aborted(), { ...live, dropSpot: 0 });
      expect(plan?.celebrate).toBe(false);
      expect(plan?.points.every((point) => ['seat', 'door', 'aisle', 'throw'].includes(point.role))).toBe(true);
    });

    it('vanishes at the Aborted front when all three drop spots are taken', () => {
      const plan = planMove(seated(), aborted(), { ...live, dropSpot: null });
      expect(plan).toMatchObject({ action: 'leave', celebrate: false, vanish: true, dropSpot: null });
      expect(plan!.points.at(-1)?.role).toBe('door');
      expect(near(plan!.points.at(-1)!, roomFront('aborted'))).toBe(true);
      expect(plan!.points.some((point) => point.role === 'throw')).toBe(false);
      abortedWalkIsClear(plan!);
    });

    it('walks every aborted robot from the Inbox desks too', () => {
      const from = classifyTasks([task({ taskId: 'I', phase: 'pending', status: 'queued' })])[0];
      const plan = planMove(from, aborted(), { ...live, dropSpot: 2 });
      expect(plan?.action).toBe('leave');
      expect(plan!.points.at(-1)?.role).toBe('throw');
    });

    it('does not walk on a snap, the first load or reduced motion', () => {
      expect(planMove(seated(), aborted(), { ...live, snap: true })).toMatchObject({ action: 'instant', vanish: true, points: [] });
      expect(planMove(seated(), aborted(), reduced)).toMatchObject({ action: 'instant', vanish: true, points: [] });
      expect(planMove(seated(), aborted(), boot)).toBeNull();
      expect(planMove(null, aborted(), boot)).toBeNull();
      expect(planMove(null, aborted(), live)).toBeNull();
    });

    it('picks the free drop spot nearest the desk and skips when all three are taken', () => {
      const left = { x: ROOM_LAYOUT.dev.x };
      const right = { x: ROOM_LAYOUT.aborted.x + 2 };
      expect(pickDropSpot(left, new Set())).toBe(0);
      expect(pickDropSpot(right, new Set())).toBe(2);
      expect(pickDropSpot(left, new Set([0]))).toBe(1);
      expect(pickDropSpot(left, new Set([0, 1]))).toBe(2);
      expect(pickDropSpot(right, new Set([2, 1]))).toBe(0);
      expect(pickDropSpot(null, new Set())).toBe(0);
      expect(pickDropSpot(left, new Set([0, 1, 2]))).toBeNull();
    });

    describe('drop spots across data rounds', () => {
      type Walker = { dead: boolean; dropSpot: number | null };
      const seat = { x: ROOM_LAYOUT.dev.x };

      /** One syncActors pass: every abort claims a spot, and its walker holds it until the box is thrown. */
      function round(walkers: Walker[], aborts: number): (number | null)[] {
        const taken = takenDropSpots(walkers);
        const spots: (number | null)[] = [];
        for (let index = 0; index < aborts; index += 1) {
          const spot = pickDropSpot(seat, taken);
          spots.push(spot);
          if (spot === null) continue;
          taken.add(spot);
          walkers.push({ dead: false, dropSpot: spot });
        }
        return spots;
      }

      it('gives a later round a different spot while the first walker is still walking or throwing', () => {
        const walkers: Walker[] = [];
        const first = round(walkers, 1)[0]!;
        const second = round(walkers, 1)[0]!;
        const third = round(walkers, 1)[0]!;
        expect(new Set([first, second, third]).size).toBe(3);
      });

      it('sends the fourth robot to vanish at the front, with no throw', () => {
        const walkers: Walker[] = [];
        round(walkers, 3);
        expect(round(walkers, 1)).toEqual([null]);
        expect(walkers).toHaveLength(3);
        const plan = planMove(seated(), aborted(), { ...live, dropSpot: null })!;
        expect(plan.points.some((point) => point.role === 'throw')).toBe(false);
      });

      it('frees a spot once the box is thrown or the walker is gone', () => {
        const walkers: Walker[] = [];
        round(walkers, 3);
        walkers[0].dropSpot = null;
        walkers[1].dead = true;
        expect([...takenDropSpots(walkers)]).toEqual([walkers[2].dropSpot]);
        expect(round(walkers, 1)[0]).not.toBe(walkers[2].dropSpot);
      });
    });
  });

  it('walks a fifth task to the full room front and vanishes', () => {
    const seated = place('M', 'pending', 'queued');
    const crowd = [
      task({ taskId: 'M', phase: 'assigned', status: 'running', updatedAt: '2026-10-20T00:00:00Z' }),
      ...[0, 1, 2, 3].map((index) => task({
        taskId: `D${index}`,
        phase: 'assigned',
        status: 'running',
        updatedAt: `2026-10-0${index + 1}T00:00:00Z`,
      })),
    ];
    const next = classifyTasks(crowd).find((item) => item.taskId === 'M');
    expect(next?.drawn).toBe(false);
    const plan = planMove(seated, next!, live);
    expect(plan).toMatchObject({ action: 'overflow', vanish: true, celebrate: false });
    expect(near(plan!.points.at(-1)!, roomFront('dev'))).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('door');
    expect(plan!.points.some((point) => point.role === 'seat' && near(point, roomFront('dev')))).toBe(false);
    aisleIsClear(plan!);
  });

  it('does not move when reduced motion is on', () => {
    const plan = planMove(place('M', 'assigned', 'running'), place('M', 'in_review', 'waiting_review'), reduced);
    expect(plan?.action).toBe('instant');
    expect(plan?.gait).toBe('none');
    expect(plan?.celebrate).toBe(false);
    expect(plan?.points.every((point) => point.role === 'seat')).toBe(true);
    expect(plan!.points.length).toBeLessThanOrEqual(1);
    expect(planTravelSeconds(plan!)).toBe(0);
    const gone = planMove(place('M', 'assigned', 'running'), place('M', 'aborted', 'cancelled'), reduced);
    expect(gone).toMatchObject({ action: 'instant', vanish: true, points: [] });
  });

  it('seats the first snapshot instead of replaying every arrival', () => {
    const plan = planMove(null, place('M', 'assigned', 'running'), boot);
    expect(plan?.action).toBe('stay');
    expect(plan?.gait).toBe('none');
    expect(plan?.points).toHaveLength(1);
  });

  it('seats a remount even when the previous place was another room', () => {
    const prev = place('M', 'assigned', 'running');
    const next = place('M', 'in_review', 'waiting_review');
    const plan = planMove(prev, next, boot);
    expect(plan).toMatchObject({ action: 'stay', gait: 'none', celebrate: false, vanish: false });
    expect(plan!.points).toEqual([{ x: next.seat!.x, z: next.seat!.z, role: 'seat' }]);
  });

  it('walks in through that room front when a freed desk reveals the task', () => {
    const crowd = [
      task({ taskId: 'M', phase: 'assigned', status: 'running', updatedAt: '2026-10-20T00:00:00Z' }),
      ...[0, 1, 2, 3].map((index) => task({
        taskId: `D${index}`,
        phase: 'assigned',
        status: 'running',
        updatedAt: `2026-10-0${index + 1}T00:00:00Z`,
      })),
    ];
    const hidden = classifyTasks(crowd).find((item) => item.taskId === 'M');
    expect(hidden?.drawn).toBe(false);
    const revealed = classifyTasks(crowd.filter((item) => item.taskId !== 'D0')).find((item) => item.taskId === 'M');
    expect(revealed?.drawn).toBe(true);
    const plan = planMove(hidden!, revealed!, live);
    expect(plan).toMatchObject({ action: 'enter', celebrate: false, vanish: false, gait: 'walk' });
    expect(near(plan!.points[0], roomFront('dev'))).toBe(true);
    expect(plan!.points.at(-1)?.role).toBe('seat');
    expect(plan!.points.some((point) => near(point, roomFront('inbox')))).toBe(false);
  });

  it('stands on the room slab, stands on the aisle floor, and celebrates at the standing height', () => {
    const seat = place('M', 'assigned', 'running').seat!;
    const door = roomFront('dev');
    const sitDrop = 0.2;
    const dev = roomRect('dev');
    expect(seat.x).toBeGreaterThanOrEqual(dev.minX);
    expect(seat.x).toBeLessThanOrEqual(dev.maxX);
    expect(seat.z).toBeGreaterThanOrEqual(dev.minZ);
    expect(seat.z).toBeLessThanOrEqual(dev.maxZ);
    expect(standY(seat.x, seat.z)).toBe(FLOOR_TOP);
    expect(standY(door.x, door.z)).toBe(0);
    expect(actorRootY(seat.x, seat.z, 'sit', sitDrop)).toBeCloseTo(SEAT_Y - sitDrop);
    expect(actorRootY(seat.x, seat.z, 'stand', sitDrop)).toBe(FLOOR_TOP);
    expect(actorRootY(door.x, door.z, 'stand', sitDrop)).toBe(0);
    expect(actorRootY(seat.x, seat.z, 'celebrate', sitDrop)).toBe(FLOOR_TOP);
    expect(actorRootY(seat.x, seat.z, 'celebrate', sitDrop)).toBe(actorRootY(seat.x, seat.z, 'stand', sitDrop));
  });

  it('seats the first successful load when the first fetch failed', () => {
    const tasks = [
      task({ taskId: 'A', phase: 'assigned', status: 'running' }),
      task({ taskId: 'B', phase: 'pending', status: 'queued' }),
    ];
    expect(officeSnapshotSettled(null)).toBe(false);
    let booted = false;
    const prev = new Map<string, CharacterPlace>();
    if (officeSnapshotSettled(null)) booted = true;
    expect(booted).toBe(false);
    const loadedAt = '2026-10-22T08:00:00.000Z';
    expect(officeSnapshotSettled(loadedAt)).toBe(true);
    const plans = classifyTasks(tasks).map((item) => planMove(prev.get(item.taskId) ?? null, item, {
      reducedMotion: false,
      initial: !booted,
    }));
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan?.action).toBe('stay');
      expect(plan!.points).toHaveLength(1);
      expect(plan!.points[0]?.role).toBe('seat');
      expect(plan!.points.some((point) => near(point, roomFront('inbox')))).toBe(false);
    }
  });

  it('stays seated when desks in the same room are re-laid', () => {
    const from = place('M', 'assigned', 'running');
    const to: CharacterPlace = { ...from, seat: { x: from.seat!.x + 0.95, z: from.seat!.z } };
    const plan = planMove(from, to, live);
    expect(plan?.action).toBe('stay');
    expect(plan?.gait).toBe('none');
    expect(plan?.points).toEqual([{ x: to.seat!.x, z: to.seat!.z, role: 'seat' }]);
    expect(planTravelSeconds(plan!)).toBe(0);
  });
});

function rowGap(row: readonly { localX: number }[]): number {
  const xs = row.map((desk) => desk.localX).sort((a, b) => a - b);
  let gap = Infinity;
  for (let index = 1; index < xs.length; index += 1) gap = Math.min(gap, xs[index] - xs[index - 1]);
  return gap;
}

function devTasks(ids: string[]): OfficeTask[] {
  return ids.map((taskId, index) => task({
    taskId,
    phase: 'assigned',
    status: 'running',
    updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
  }));
}

describe('replan', () => {
  it('continues from the current point and joins the nearest waypoint', () => {
    const walking = planMove(place('M', 'assigned', 'running'), place('M', 'in_review', 'waiting_review'), live)!;
    const door = walking.points.find((point) => point.role === 'door' && near(point, roomFront('review')));
    expect(door).toBeTruthy();
    const here = { x: door!.x, z: door!.z - 0.4 };
    const redirected = planMove(place('M', 'assigned', 'running'), place('M', 'blocked', 'blocked'), live)!;
    const resumed = resumeMove(here, redirected);
    expect(resumed.points[0].x).toBeCloseTo(here.x);
    expect(resumed.points[0].z).toBeCloseTo(here.z);
    expect(near(resumed.points[0], redirected.points[0])).toBe(false);
    const nearest = [...redirected.points].sort((a, b) => (
      Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z)
    ))[0];
    const join = resumed.points.findIndex((point) => near(point, nearest));
    expect(join).toBeGreaterThan(0);
    const rest = redirected.points.slice(redirected.points.findIndex((point) => near(point, nearest)));
    expect(resumed.points.slice(join)).toEqual(rest);
  });
});

describe('desk row hold', () => {
  it('keeps a seated robot still while a new task walks in', () => {
    const before = devTasks(['A']);
    const previous = commitRoomDesks('dev', before, undefined, null, { hold: false, retainTaskIds: [] });
    expect(previous).toEqual([{ taskId: 'A', localX: 0 }]);
    const held = commitRoomDesks('dev', devTasks(['A', 'B']), undefined, previous, { hold: true, retainTaskIds: [] });
    expect(held.find((desk) => desk.taskId === 'A')?.localX).toBe(0);
    expect(held.find((desk) => desk.taskId === 'B')?.localX).not.toBeCloseTo(deskLocalX(1, 2));
    const seated = classifyTasks(before).find((item) => item.taskId === 'A')!;
    const still = classifyTasks(devTasks(['A', 'B']), undefined, { dev: held }).find((item) => item.taskId === 'A')!;
    expect(still.seat?.x).toBeCloseTo(seated.seat!.x);
    expect(planMove(seated, still, live)?.action).toBe('stay');
  });

  it('keeps the celebrating desk until that robot is gone, then recenters', () => {
    const previous = commitRoomDesks('dev', devTasks(['A', 'B']), undefined, null, { hold: false, retainTaskIds: [] });
    const ax = previous.find((desk) => desk.taskId === 'A')!.localX;
    const bx = previous.find((desk) => desk.taskId === 'B')!.localX;
    const held = commitRoomDesks('dev', devTasks(['A']), undefined, previous, { hold: true, retainTaskIds: ['B'] });
    expect(held.find((desk) => desk.taskId === 'A')?.localX).toBeCloseTo(ax);
    expect(held.find((desk) => desk.taskId === 'B')?.localX).toBeCloseTo(bx);
    const quiet = commitRoomDesks('dev', devTasks(['A']), undefined, held, { hold: false, retainTaskIds: [] });
    expect(quiet).toEqual([{ taskId: 'A', localX: 0 }]);
  });

  it('stays seated when a quiet room recenters under a robot', () => {
    const from = place('M', 'assigned', 'running');
    const to: CharacterPlace = { ...from, seat: { x: from.seat!.x + 0.6, z: from.seat!.z } };
    const plan = planMove(from, to, live);
    expect(plan?.action).toBe('stay');
    expect(plan?.gait).toBe('none');
    expect(plan?.points).toEqual([{ x: to.seat!.x, z: to.seat!.z, role: 'seat' }]);
  });

  it('recenters to the phase-1 spacing once the room is quiet', () => {
    const row = commitRoomDesks(
      'dev',
      devTasks(['A', 'B']),
      undefined,
      [{ taskId: 'A', localX: 0 }, { taskId: 'B', localX: 1.2 }],
      { hold: false, retainTaskIds: [] },
    );
    expect(row.map((desk) => desk.localX)).toEqual([deskLocalX(0, 2), deskLocalX(1, 2)]);
  });

  it('holds the leaving desk while that robot is still in the room or still walking', () => {
    const previous = [{ taskId: 'A', localX: -0.6 }, { taskId: 'B', localX: 0.6 }];
    const seated = deskHoldForRoom(
      'dev',
      previous,
      ['A'],
      new Map([['B', { zoneId: 'dev' }]]),
      new Map([['B', { moving: false, dead: false }]]),
    );
    expect(seated).toEqual({ hold: true, retainTaskIds: ['B'] });
    const walking = deskHoldForRoom(
      'dev',
      previous,
      ['A'],
      new Map([['B', { zoneId: 'done' }]]),
      new Map([['B', { moving: true, dead: false }]]),
    );
    expect(walking.hold).toBe(true);
    expect(walking.retainTaskIds).toEqual(['B']);
    const gone = deskHoldForRoom(
      'dev',
      previous,
      ['A'],
      new Map([['B', { zoneId: 'done' }]]),
      new Map([['B', { moving: false, dead: true }]]),
    );
    expect(gone).toEqual({ hold: false, retainTaskIds: [] });
    const delivering = deskHoldForRoom(
      'dev',
      previous,
      ['A'],
      new Map([['B', { zoneId: 'dev' }]]),
      new Map([['B', { moving: true, dead: false, delivering: true, leftOrigin: false }]]),
    );
    expect(delivering.retainTaskIds).toEqual(['B']);
    const left = deskHoldForRoom(
      'dev',
      previous,
      ['A'],
      new Map([['B', { zoneId: 'dev' }]]),
      new Map([['B', { moving: true, dead: false, delivering: true, leftOrigin: true }]]),
    );
    expect(left).toEqual({ hold: false, retainTaskIds: [] });
  });

  it('waits to draw a promoted task while a full room still holds the leaving desk', () => {
    const previous = commitRoomDesks('dev', devTasks(['A', 'B', 'C', 'D']), undefined, null, { hold: false, retainTaskIds: [] });
    const held = commitRoomDesks(
      'dev',
      devTasks(['A', 'C', 'D', 'E']),
      undefined,
      previous,
      { hold: true, retainTaskIds: ['B'] },
    );
    expect(held).toHaveLength(4);
    expect(held.map((desk) => desk.taskId)).not.toContain('E');
    expect(rowGap(held)).toBeGreaterThanOrEqual(0.6);
    const waiting = classifyTasks(devTasks(['A', 'C', 'D', 'E']), undefined, { dev: held }).find((item) => item.taskId === 'E')!;
    expect(waiting.drawn).toBe(false);
    const released = deskHoldForRoom(
      'dev',
      held,
      ['A', 'C', 'D', 'E'],
      new Map([['B', { zoneId: 'done' }]]),
      new Map([['B', { moving: false, dead: true }]]),
    );
    expect(released).toEqual({ hold: false, retainTaskIds: [] });
    const quiet = commitRoomDesks('dev', devTasks(['A', 'C', 'D', 'E']), undefined, held, { hold: false, retainTaskIds: [] });
    expect(quiet.map((desk) => desk.taskId).sort()).toEqual(['A', 'C', 'D', 'E']);
    expect(rowGap(quiet)).toBeGreaterThanOrEqual(0.6);
    const seated = classifyTasks(devTasks(['A', 'C', 'D', 'E']), undefined, { dev: quiet }).find((item) => item.taskId === 'E')!;
    const enter = planMove(waiting, seated, live);
    expect(enter?.action).toBe('enter');
    expect(enter?.points[0]).toEqual({ ...roomFront('dev'), role: 'door' });
    const stayerBefore = classifyTasks(devTasks(['A', 'C', 'D', 'E']), undefined, { dev: held }).find((item) => item.taskId === 'A')!;
    const stayerAfter = classifyTasks(devTasks(['A', 'C', 'D', 'E']), undefined, { dev: quiet }).find((item) => item.taskId === 'A')!;
    expect(planMove(stayerBefore, stayerAfter, live)?.action).toBe('stay');
  });

  it('holds the row when a task is new, and draws that held row', () => {
    const previous = [{ taskId: 'A', localX: 0 }];
    expect(deskHoldForRoom('dev', previous, ['A', 'B'], new Map(), new Map()).hold).toBe(true);
    const held = commitRoomDesks('dev', devTasks(['A', 'B']), undefined, previous, { hold: true, retainTaskIds: [] });
    const tasks = devTasks(['A', 'B']);
    const poses = buildOfficePoses(tasks, zoneStats(tasks), null, null, { dev: held });
    const desks = poses.desk.filter((desk) => desk.zoneId === 'dev');
    expect(desks.find((desk) => desk.taskId === 'A')?.x).toBeCloseTo(ROOM_LAYOUT.dev.x);
    expect(desks.find((desk) => desk.taskId === 'B')?.x).not.toBeCloseTo(ROOM_LAYOUT.dev.x + deskLocalX(1, 2));
    expect(officeDesks('dev', tasks, zoneStats(tasks), { dev: held }).map((desk) => desk.taskId)).toEqual(
      held.map((desk) => desk.taskId),
    );
  });
});
