import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import { characterSlots, SLOT_Z_OFFSET } from './officeCharacters';
import { DECOR_PLACEMENTS } from './officeDecor';
import { buildOfficePoses } from './officeLayout';
import { DESK_Z } from './officeLook';
import { loungeLightAllowed } from './officeLounge';
import { ENVELOPE_COLOR, PICKUP_SPOTS, QUEUE_CAP, RECEPTION, deskZ, queueBoxCount, queueSlots } from './officeReception';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';

const inboxTask = (taskId: string): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'pending',
  status: 'queued',
  needsReview: false,
});

describe('inbox reception furniture', () => {
  it('replaces the lounge set with a counter facing the door and a back-wall shelf', () => {
    const inbox = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'inbox');
    expect(inbox.map((item) => item.file)).toEqual(['desk', 'desk', 'bookcaseClosedWide']);
    expect(inbox.some((item) => item.file.startsWith('lounge') || item.file === 'tableCoffee')).toBe(false);
    const counters = inbox.filter((item) => item.file === 'desk');
    expect(counters).toHaveLength(2);
    expect(counters.every((item) => item.z > 0.4)).toBe(true);
    const shelf = inbox.find((item) => item.file === 'bookcaseClosedWide');
    expect(shelf?.z).toBeLessThan(-1.2);
  });

  it('puts the monitor and the plant with the reception, and keeps other desk rows put', () => {
    const tasks = [inboxTask('IN'), { ...inboxTask('DEV'), taskId: 'DEV', phase: 'assigned' as const, status: 'running' }];
    const stats = summarizeZones(tasks);
    const poses = buildOfficePoses(tasks, stats, null, null);
    const screen = poses.screenOn.find((pose) => pose.zoneId === 'inbox');
    expect(screen?.kind).toBe('room');
    expect(screen?.z).toBeGreaterThan(ROOM_LAYOUT.inbox.z);
    const inboxPlants = poses.plant.filter((plant) => plant.zoneId === 'inbox');
    expect(inboxPlants).toHaveLength(1);
    expect(inboxPlants[0].z).toBeLessThan(ROOM_LAYOUT.inbox.z - 0.8);
    const inboxDesk = poses.desk.find((pose) => pose.zoneId === 'inbox');
    const devDesk = poses.desk.find((pose) => pose.zoneId === 'dev');
    expect(deskZ('inbox')).toBeLessThan(DESK_Z);
    expect(deskZ('dev')).toBe(DESK_Z);
    expect(inboxDesk?.z).toBeCloseTo(ROOM_LAYOUT.inbox.z + deskZ('inbox'));
    expect(devDesk?.z).toBeCloseTo(ROOM_LAYOUT.dev.z + DESK_Z);
    const seated = characterSlots(tasks, stats).find((slot) => slot.taskId === 'IN');
    expect(seated?.z).toBeCloseTo((inboxDesk?.z ?? 0) + SLOT_Z_OFFSET);
  });

  it('keeps the plant off the end Inbox desk', () => {
    const tasks = [0, 1, 2, 3].map((index) => inboxTask(`IN${index}`));
    const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
    const end = poses.desk.filter((pose) => pose.zoneId === 'inbox').reduce((best, pose) => (pose.x > best.x ? pose : best));
    const plant = poses.plant.find((pose) => pose.zoneId === 'inbox')!;
    const deskHalfX = (0.7345 * (end.sx ?? 1)) / 2;
    const deskHalfZ = (0.3923 * (end.sz ?? 1)) / 2;
    const plantHalfX = (0.2121 * (plant.sx ?? 1)) / 2;
    const plantHalfZ = (0.2415 * (plant.sz ?? 1)) / 2;
    const overlapX = Math.abs(plant.x - end.x) < deskHalfX + plantHalfX;
    const overlapZ = Math.abs(plant.z - end.z) < deskHalfZ + plantHalfZ;
    expect(overlapX && overlapZ).toBe(false);
  });
});

describe('inbox queue shelf', () => {
  it('counts only the tasks past the four desks and caps at six boxes', () => {
    expect(queueBoxCount(0)).toBe(0);
    expect(queueBoxCount(4)).toBe(0);
    expect(queueBoxCount(5)).toBe(1);
    expect(queueBoxCount(9)).toBe(5);
    expect(queueBoxCount(10)).toBe(QUEUE_CAP);
    expect(queueBoxCount(40)).toBe(6);
    expect(queueSlots(0)).toEqual([]);
    expect(queueSlots(queueBoxCount(10))).toHaveLength(6);
    const slots = queueSlots(6);
    const keys = slots.map((slot) => `${slot.x.toFixed(2)}:${slot.y.toFixed(2)}`);
    expect(new Set(keys).size).toBe(6);
  });

  it('keeps a queue box from standing proud of the shelf face', () => {
    const shelfFaceZ = RECEPTION.shelf.z + (0.25 * RECEPTION.shelf.scale) / 2;
    expect(queueSlots(6).every((slot) => slot.z <= shelfFaceZ)).toBe(true);
  });

  it('keeps the envelope warm-white and leaves three distinct pickup spots', () => {
    expect(loungeLightAllowed(ENVELOPE_COLOR)).toBe(true);
    expect(ENVELOPE_COLOR).toBe('#f3ecdf');
    expect(PICKUP_SPOTS).toHaveLength(3);
    expect(new Set(PICKUP_SPOTS.map((spot) => `${spot.x}:${spot.z}`)).size).toBe(3);
  });
});
