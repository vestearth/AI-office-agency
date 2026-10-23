import { describe, expect, it } from 'vitest';
import { ZONE_BY_ID, summarizeZones, zonePreview } from '../commandZones';
import { DECOR_PLACEMENTS, placedDecorBucket } from './officeDecor';
import { buildOfficePoses, selectionAnchor } from './officeLayout';
import {
  LOUNGE,
  LOUNGE_LIGHT,
  PILE_CAP,
  loungeLightAllowed,
  loungeReadout,
  msUntilNextLocalMidnight,
  officeLocalDay,
  pileSlots,
  type LoungeFlow,
} from './officeLounge';
import type { OfficeTask } from './officeSelection';

const BEFORE_MIDNIGHT = new Date('2026-10-23T16:30:00Z');
const AFTER_MIDNIGHT = new Date('2026-10-23T17:30:00Z');

function flow(days: { date: string; closed: number }[]): LoungeFlow {
  return { throughput: { days } };
}

const doneTask = (taskId: string, updatedAt: string): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'done',
  status: 'completed',
  needsReview: false,
  updatedAt,
});

describe('lounge readout', () => {
  it('reads today from the office time zone and shows the three newest done ids', () => {
    const readout = loungeReadout(
      flow([{ date: '2026-10-23', closed: 4 }, { date: '2026-10-22', closed: 9 }]),
      ['NEW', 'MID', 'OLD', 'OLDER'],
      BEFORE_MIDNIGHT,
    );
    expect(officeLocalDay(BEFORE_MIDNIGHT)).toBe('2026-10-23');
    expect(readout).toMatchObject({
      closed: 4,
      label: '4',
      recentIds: ['NEW', 'MID', 'OLD'],
      tableTaskId: 'NEW',
      pile: 4,
      lit: true,
    });
  });

  it('treats a missing day as zero and a failed flow as unknown', () => {
    expect(loungeReadout(flow([]), ['NEW'], BEFORE_MIDNIGHT)).toMatchObject({
      closed: 0,
      label: '0',
      pile: 0,
      lit: false,
      tableTaskId: 'NEW',
    });
    expect(loungeReadout(null, ['NEW'], BEFORE_MIDNIGHT)).toMatchObject({
      closed: null,
      label: '–',
      recentIds: ['NEW'],
      tableTaskId: 'NEW',
      pile: 0,
      lit: false,
    });
  });

  it('caps the pile at 12 and still reports the real count', () => {
    const readout = loungeReadout(flow([{ date: '2026-10-23', closed: 20 }]), [], BEFORE_MIDNIGHT);
    expect(readout.closed).toBe(20);
    expect(readout.label).toBe('20');
    expect(readout.pile).toBe(PILE_CAP);
    expect(pileSlots(readout.pile)).toHaveLength(PILE_CAP);
    expect(pileSlots(0)).toEqual([]);
  });

  it('rolls the count and the pile over at Asia/Bangkok midnight', () => {
    const today = flow([{ date: '2026-10-23', closed: 4 }]);
    expect(officeLocalDay(AFTER_MIDNIGHT)).toBe('2026-10-24');
    expect(msUntilNextLocalMidnight(BEFORE_MIDNIGHT)).toBe(30 * 60 * 1000);
    expect(loungeReadout(today, ['NEW'], AFTER_MIDNIGHT)).toMatchObject({
      closed: 0,
      label: '0',
      pile: 0,
      lit: false,
      tableTaskId: 'NEW',
    });
  });
});

describe('lounge light palette', () => {
  it('keeps the warm white off every status hue', () => {
    expect(loungeLightAllowed(LOUNGE_LIGHT)).toBe(true);
    expect(loungeLightAllowed('#22c55e')).toBe(false);
    expect(loungeLightAllowed('#ef4444')).toBe(false);
  });
});

describe('done room furniture', () => {
  it('replaces the done desks and the old bookcase with the lounge set', () => {
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'done').map((item) => item.file);
    expect(files).toEqual([
      'loungeSofa',
      'loungeChair',
      'loungeSofaOttoman',
      'tableCoffee',
      'cabinetTelevisionDoors',
      'lampRoundFloor',
    ]);
    expect(placedDecorBucket('done', 'shade')).toBe('loungeShade');
    expect(placedDecorBucket('devops', 'shade')).toBe('shade');
    const tasks = [doneTask('NEW', '2026-10-23T10:00:00Z')];
    const stats = summarizeZones(tasks);
    const poses = buildOfficePoses(tasks, stats, null, null);
    expect(poses.desk.filter((pose) => pose.zoneId === 'done')).toHaveLength(0);
    expect(poses.chair.filter((pose) => pose.zoneId === 'done')).toHaveLength(0);
  });

  it('anchors the latest done task on the coffee table and the rest on the TV', () => {
    const tasks = [
      doneTask('OLD', '2026-10-20T00:00:00Z'),
      doneTask('NEW', '2026-10-23T10:00:00Z'),
    ];
    const stats = summarizeZones(tasks);
    const ordered = zonePreview(ZONE_BY_ID.get('done')!, tasks, tasks.length);
    expect(ordered.map((task) => task.taskId)).toEqual(['NEW', 'OLD']);
    const latest = selectionAnchor({ kind: 'desk', zoneId: 'done', taskId: 'NEW' }, tasks, stats);
    const older = selectionAnchor({ kind: 'desk', zoneId: 'done', taskId: 'OLD' }, tasks, stats);
    expect(latest).toEqual([LOUNGE.table.x, 0.95, LOUNGE.table.z]);
    expect(older).toEqual([LOUNGE.tv.x, 0.95, LOUNGE.tv.z]);
  });
});
