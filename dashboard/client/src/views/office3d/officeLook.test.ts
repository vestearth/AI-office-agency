import { describe, expect, it } from 'vitest';
import { ZONE_COLORS, ZONES, summarizeZones } from '../commandZones';
import { SCENE, NEON_SPINE, clampOverlay, deskLocalX, placeBeside } from './officeLook';
import { neonRuns, buildOfficePoses } from './officeLayout';
import { oldestWaitDays, roomStatLines, updatedLabel, liveColor, liveWord } from './officeRoomStats';
import type { OfficeTask } from './officeSelection';

const task = (over: Partial<OfficeTask> & Pick<OfficeTask, 'taskId' | 'phase' | 'status'>): OfficeTask => ({
  title: over.taskId,
  needsReview: false,
  ...over,
});

describe('office scene colors', () => {
  const zone = new Set(Object.values(ZONE_COLORS).map((color) => color.toLowerCase()));

  it('keeps non-status paint off the zone palette', () => {
    for (const [name, color] of Object.entries(SCENE)) {
      expect(zone.has(color.toLowerCase()), name).toBe(false);
    }
  });

  it('uses zone cyan only for the approved decorative spine', () => {
    expect(NEON_SPINE).toBe(ZONE_COLORS.cyan);
  });
});

describe('office layout', () => {
  it('spaces desks the same way phase 1 did', () => {
    expect(deskLocalX(0, 1)).toBe(0);
    expect(deskLocalX(0, 4)).toBeCloseTo(-1.425);
    expect(deskLocalX(3, 4)).toBeCloseTo(1.425);
  });

  it('keeps every room on the phase 1 layout and routes the neon spine', () => {
    const stats = summarizeZones<OfficeTask>([]);
    const runs = neonRuns(stats);
    expect(runs.filter((run) => run.spine).map((run) => run.color)).toEqual([NEON_SPINE, NEON_SPINE, NEON_SPINE]);
    expect(runs.filter((run) => !run.spine).every((run) => run.color === SCENE.neonSpur)).toBe(true);
    expect(runs.every((run) => !run.bright)).toBe(true);
    const poses = buildOfficePoses([], stats, null, null);
    expect(poses.glass).toHaveLength(2);
    // The Inbox plant and the help desk's plant.
    expect(poses.plant.map((plant) => plant.zoneId)).toEqual(['inbox', 'escalation']);
    expect(poses.rackBody).toHaveLength(3);
    expect(poses.rackBody[0].zoneId).toBe('devops');
    expect(poses.screenOn).toHaveLength(0);
    expect(poses.floorSteady).toHaveLength(ZONES.length);
    expect(poses.desk.every((desk) => desk.color === SCENE.wood)).toBe(true);
  });

  it('clamps overlay cards inside the stage', () => {
    expect(clampOverlay(-20, 10, 400, 300, 80, 40)).toEqual({ x: 0, y: 10 });
    expect(clampOverlay(390, 290, 400, 300, 80, 40)).toEqual({ x: 320, y: 260 });
  });

  it('places a selection card beside the room instead of on top of it', () => {
    const card = { w: 220, h: 110 };
    const overlaps = (x: number, y: number, box: { left: number; top: number; right: number; bottom: number }) =>
      x < box.right && x + card.w > box.left && y < box.bottom && y + card.h > box.top;
    const leftRoom = { left: 40, top: 80, right: 220, bottom: 260 };
    const right = placeBeside(leftRoom, 900, 600, card.w, card.h);
    expect(overlaps(right.x, right.y, leftRoom)).toBe(false);
    expect(right.x).toBeGreaterThanOrEqual(leftRoom.right);
    const rightRoom = { left: 640, top: 80, right: 820, bottom: 260 };
    const left = placeBeside(rightRoom, 900, 600, card.w, card.h);
    expect(overlaps(left.x, left.y, rightRoom)).toBe(false);
    expect(left.x + card.w).toBeLessThanOrEqual(rightRoom.left);
  });
});

describe('office room stats', () => {
  const review = ZONES.find((zone) => zone.id === 'review')!;
  const done = ZONES.find((zone) => zone.id === 'done')!;

  it('reads the longest wait across the phases that share a room', () => {
    expect(oldestWaitDays(review, [
      { phase: 'review', count: 1, oldestDays: 2 },
      { phase: 'in_review', count: 1, oldestDays: 9 },
      { phase: 'done', count: 4, oldestDays: 40 },
    ])).toBe(9);
    expect(oldestWaitDays(done, [{ phase: 'done', count: 1, oldestDays: null }])).toBeNull();
  });

  it('names attention in words and keeps terminal rooms on staleness', () => {
    const tasks = [task({
      taskId: 'TASK-REV-1', phase: 'in_review', status: 'waiting_review', needsReview: true, updatedAt: '2026-10-20T00:00:00Z',
    })];
    const lines = roomStatLines(review, summarizeZones(tasks).get('review'), [
      { phase: 'in_review', count: 1, oldestDays: 3 },
    ], Date.parse('2026-10-21T00:00:00Z'));
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ['Tasks', '1'],
      ['Oldest wait', '3d'],
      ['Attention', 'Needs a person'],
      ['Work', 'Queued'],
    ]);
    expect(lines[2].tone).toBe(ZONE_COLORS.amber);
    const terminal = roomStatLines(done, undefined, [], Date.parse('2026-10-21T00:00:00Z'));
    expect(terminal[3]).toMatchObject({ label: 'Stale', value: '—', tone: null });
  });

  it('keeps an open stream LIVE while the age line keeps moving', () => {
    expect(updatedLabel(null)).toBe('Waiting for tasks');
    expect(updatedLabel(new Date().toISOString())).toBe('Updated just now');
    const old = '2026-10-21T00:00:00.000Z';
    const now = Date.parse('2026-10-21T00:02:00.000Z');
    expect(updatedLabel(old, now)).toBe('Updated 2m ago');
    expect(liveWord('open', false)).toBe('LIVE');
    expect(liveWord('connecting', false)).toBe('CONNECTING');
    expect(liveWord('closed', false)).toBe('STALE');
    expect(liveWord('open', true)).toBe('STALE');
    expect(liveColor('open', false)).toBe(SCENE.live);
    expect(liveColor('closed', false)).toBe(SCENE.stale);
    expect(liveColor('open', true)).toBe(SCENE.stale);
    expect(liveColor('connecting', false)).toBe(SCENE.stale);
  });
});
