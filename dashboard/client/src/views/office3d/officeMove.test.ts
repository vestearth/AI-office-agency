import { describe, expect, it } from 'vitest';
import { ZONES } from '../commandZones';
import { FLOOR_TOP, deskLocalX } from './officeLook';
import { SEAT_Y } from './officeCharacters';
import { buildOfficePoses } from './officeLayout';
import { ROOM_LAYOUT, officeDesks } from './officeSelection';
import { summarizeZones as zoneStats } from '../commandZones';
import {
  actorRootY,
  classifyTasks,
  commitRoomDesks,
  deskHoldForRoom,
  officeSnapshotSettled,
  planMove,
  planTravelSeconds,
  roomFront,
  roomRect,
  standY,
  type CharacterPlace,
  type MovePlan,
  type MovePoint,
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

function interior(a: MovePoint, b: MovePoint): boolean {
  const roles = `${a.role}:${b.role}`;
  return roles === 'seat:door' || roles === 'door:seat';
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

  it('celebrates at the old desk, then leaves through that room front when the task is Done', () => {
    const seated = place('M', 'assigned', 'running');
    const plan = planMove(seated, place('M', 'done', 'completed'), live);
    expect(plan).toMatchObject({ action: 'leave', celebrate: true, vanish: true, gait: 'walk' });
    expect(plan!.points.map((point) => point.role)).toEqual(['seat', 'door']);
    expect(near(plan!.points[0], seated.seat!)).toBe(true);
    expect(near(plan!.points[1], roomFront('dev'))).toBe(true);
    expect(near(plan!.points[1], roomFront('done'))).toBe(false);
  });

  it('vanishes in place when the task is Aborted', () => {
    const plan = planMove(place('M', 'assigned', 'running'), place('M', 'aborted', 'cancelled'), live);
    expect(plan).toMatchObject({ action: 'vanish', celebrate: false, vanish: true, gait: 'none', points: [] });
    expect(planTravelSeconds(plan!)).toBe(0);
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

function devTasks(ids: string[]): OfficeTask[] {
  return ids.map((taskId, index) => task({
    taskId,
    phase: 'assigned',
    status: 'running',
    updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
  }));
}

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
