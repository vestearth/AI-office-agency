import { describe, expect, it } from 'vitest';
import { ZONES, ZONE_BY_ID, ZONE_COLORS, summarizeZones } from '../commandZones';
import { buildOfficePoses } from './officeLayout';
import { ABORTED_LIGHT } from './officeAborted';
import { LOUNGE_LIGHT, LOUNGE_LIGHT_LEVEL, loungeLightAllowed } from './officeLounge';
import { lampShadeEmissive, poolItems, roomGlows, roomLightLevel, shadeEmissiveFor, splitLampPoses, type RoomBrief } from './officeNight';
import type { OfficeTask } from './officeSelection';

const dev = ZONE_BY_ID.get('dev')!;
const done = ZONE_BY_ID.get('done')!;
const aborted = ZONE_BY_ID.get('aborted')!;
const blocked = ZONE_BY_ID.get('blocked')!;
const inbox = ZONE_BY_ID.get('inbox')!;
const escalation = ZONE_BY_ID.get('escalation')!;
const idle: RoomBrief = { count: 1, attention: false, active: false };
const quiet: RoomBrief = { count: 4, attention: false, active: false };

describe('room light level', () => {
  it('uses 1 for an active room or one that needs a person', () => {
    expect(roomLightLevel(dev, { count: 2, attention: false, active: true })).toBe(1);
    expect(roomLightLevel(dev, { count: 2, attention: true, active: false })).toBe(1);
    expect(roomLightLevel(blocked, { count: 1, attention: false, active: false })).toBe(1);
  });

  it('uses 0.7 for a room that has work but is idle', () => {
    expect(roomLightLevel(dev, idle)).toBe(0.7);
  });

  it('uses 0 for an empty room', () => {
    expect(roomLightLevel(dev, { count: 0, attention: false, active: false })).toBe(0);
    const glows = roomGlows(summarizeZones<OfficeTask>([]), null, null, 0);
    expect(glows).toHaveLength(ZONES.length);
    expect(glows.every((room) => room.level === 0)).toBe(true);
  });

  it('lights Aborted dimly whenever it holds tasks, in a neutral color that passes the palette rule', () => {
    expect(roomLightLevel(aborted, { count: 0, attention: false, active: false }, 3)).toBe(0);
    expect(roomLightLevel(aborted, { ...quiet, count: 4 })).toBe(LOUNGE_LIGHT_LEVEL);
    expect(loungeLightAllowed(ABORTED_LIGHT)).toBe(true);
    const tasks: OfficeTask[] = [{ taskId: 'TASK-AB-1', title: 'Dropped', phase: 'aborted', status: 'cancelled', needsReview: false }];
    const lit = roomGlows(summarizeZones(tasks), null, null, 0).find((room) => room.zoneId === 'aborted')!;
    expect(lit.level).toBe(LOUNGE_LIGHT_LEVEL);
    expect(lit.light).toBe(ABORTED_LIGHT);
    expect(lit.tone).toBe(ZONE_COLORS.gray);
    const dark = roomGlows(summarizeZones<OfficeTask>([]), null, null, 0).find((room) => room.zoneId === 'aborted')!;
    expect(dark.level).toBe(0);
  });

  it('lights Done only when at least one task closed today', () => {
    expect(roomLightLevel(done, quiet, 0)).toBe(0);
    expect(roomLightLevel(done, { count: 0, attention: false, active: false }, 2)).toBe(LOUNGE_LIGHT_LEVEL);
    expect(roomLightLevel(done, quiet, 1)).toBe(LOUNGE_LIGHT_LEVEL);
    const tasks: OfficeTask[] = [{
      taskId: 'TASK-DONE-1',
      title: 'Shipped',
      phase: 'done',
      status: 'completed',
      needsReview: false,
    }];
    const [glow] = roomGlows(summarizeZones(tasks), null, null, 2).filter((room) => room.zoneId === 'done');
    expect(glow.level).toBe(LOUNGE_LIGHT_LEVEL);
    expect(glow.light).toBe(LOUNGE_LIGHT);
    expect(glow.tone).toBe(ZONE_COLORS.gray);
    const dark = roomGlows(summarizeZones(tasks), null, null, 0).find((room) => room.zoneId === 'done');
    expect(dark?.level).toBe(0);
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

  it('puts only occupied rooms on the lit material, and an empty office has no halo', () => {
    const lamps = [{ zoneId: 'inbox' }, { zoneId: 'escalation' }, { zoneId: 'done' }];
    const empty = summarizeZones<OfficeTask>([]);
    const emptyGlows = roomGlows(empty, null, null);
    expect(poolItems(emptyGlows).steady).toHaveLength(0);
    expect(poolItems(emptyGlows).pulse).toHaveLength(0);
    expect(splitLampPoses(lamps, empty)).toEqual({ lit: [], dark: lamps });
    expect(shadeEmissiveFor('devops', empty)).toBe(0);

    const busy = summarizeZones<OfficeTask>([{
      taskId: 'TASK-IN-1',
      title: 'Queued',
      phase: 'pending',
      status: 'running',
      needsReview: false,
    }]);
    const split = splitLampPoses(lamps, busy);
    expect(split.lit.map((lamp) => lamp.zoneId)).toEqual(['inbox']);
    expect(split.dark.map((lamp) => lamp.zoneId)).toEqual(['escalation', 'done']);
    expect(shadeEmissiveFor('devops', busy)).toBe(0);
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
