import { describe, expect, it } from 'vitest';
import { ZONES, ZONE_BY_ID, summarizeZones } from '../commandZones';
import { buildOfficePoses } from './officeLayout';
import { lampShadeEmissive, roomGlows, roomLightLevel, type RoomBrief } from './officeNight';
import type { OfficeTask } from './officeSelection';

const dev = ZONE_BY_ID.get('dev')!;
const done = ZONE_BY_ID.get('done')!;
const blocked = ZONE_BY_ID.get('blocked')!;
const inbox = ZONE_BY_ID.get('inbox')!;
const escalation = ZONE_BY_ID.get('escalation')!;
const idle: RoomBrief = { count: 1, attention: false, active: false };

describe('room light level', () => {
  it('uses 1 for an active room or one that needs a person', () => {
    expect(roomLightLevel(dev, { count: 2, attention: false, active: true })).toBe(1);
    expect(roomLightLevel(dev, { count: 2, attention: true, active: false })).toBe(1);
    expect(roomLightLevel(blocked, { count: 1, attention: false, active: false })).toBe(1);
  });

  it('uses 0.7 for a room that has work but is idle', () => {
    expect(roomLightLevel(dev, idle)).toBe(0.7);
  });

  it('uses 0 for an empty room and for a terminal room', () => {
    expect(roomLightLevel(dev, { count: 0, attention: false, active: false })).toBe(0);
    expect(roomLightLevel(done, { count: 4, attention: false, active: false })).toBe(0);
    const glows = roomGlows(summarizeZones<OfficeTask>([]), null, null);
    expect(glows).toHaveLength(ZONES.length);
    expect(glows.every((room) => room.level === 0)).toBe(true);
  });
});

describe('lamp shades', () => {
  it('stay dark in an empty room and in a terminal room', () => {
    expect(lampShadeEmissive(escalation, { count: 0 })).toBe(0);
    expect(lampShadeEmissive(inbox, { count: 0 })).toBe(0);
    expect(lampShadeEmissive(done, { count: 5 })).toBe(0);
  });

  it('emit while the room has tasks', () => {
    expect(lampShadeEmissive(inbox, { count: 1 })).toBe(1.4);
    expect(lampShadeEmissive(escalation, { count: 2 })).toBe(1.4);
  });
});

describe('desk screens', () => {
  it('face the chair instead of showing the monitor back', () => {
    const task: OfficeTask = {
      taskId: 'TASK-DEV-1',
      title: 'A desk',
      phase: 'assigned',
      status: 'running',
      needsReview: false,
    };
    const stats = summarizeZones([task]);
    const poses = buildOfficePoses([task], stats, null, null);
    const deskScreens = [...poses.screenOn, ...poses.screenOff].filter((pose) => pose.kind === 'desk');
    expect(deskScreens.length).toBeGreaterThan(0);
    expect(deskScreens.every((pose) => pose.rotY === 0)).toBe(true);
  });
});
