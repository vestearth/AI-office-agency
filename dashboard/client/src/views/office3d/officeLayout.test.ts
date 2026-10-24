import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import { buildOfficePoses } from './officeLayout';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';
import { REVIEW } from './officeReview';

const review = (taskId: string, over: Partial<OfficeTask> = {}): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'in_review',
  status: 'waiting_review',
  needsReview: true,
  statusUpdatedAt: '2026-10-20T00:00:00Z',
  ...over,
});

const posesFor = (tasks: OfficeTask[]) => buildOfficePoses(tasks, summarizeZones(tasks), null, null);
const inReview = <T extends { zoneId: string }>(list: T[]) => list.filter((pose) => pose.zoneId === 'review');

describe('Review room furniture', () => {
  const tasks = [review('A'), review('B', { statusUpdatedAt: '2026-10-22T00:00:00Z' })];

  it('has no desks, chairs or desk screens, with tasks or without', () => {
    for (const set of [tasks, []]) {
      const poses = posesFor(set);
      expect(inReview(poses.desk)).toEqual([]);
      expect(inReview(poses.chair)).toEqual([]);
      expect([...poses.screenOn, ...poses.screenOff].filter((pose) => pose.zoneId === 'review' && pose.kind === 'desk')).toEqual([]);
    }
  });

  it('keeps the glass side walls', () => {
    const poses = posesFor(tasks);
    expect(inReview(poses.glass)).toHaveLength(2);
    expect(inReview(poses.glassEdge)).toHaveLength(2);
  });

  it('replaces the big back-wall screen with a small lit panel at the gate while the room holds tasks', () => {
    const lit = inReview(posesFor(tasks).screenOn);
    expect(lit).toHaveLength(1);
    const layout = ROOM_LAYOUT.review;
    expect(lit[0].x).toBeCloseTo(layout.x + REVIEW.gate.x);
    expect(lit[0].sx).toBeLessThan(2.3);
    const dark = inReview(posesFor([]).screenOff);
    expect(dark).toHaveLength(1);
    expect(inReview(posesFor([]).screenOn)).toEqual([]);
  });
});

describe('Review standing spots of tasks that are not waiting for a decision', () => {
  const other = (taskId: string, actionKind: OfficeTask['actionKind']): OfficeTask => ({
    taskId, title: taskId, phase: 'review', status: 'waiting_review', needsReview: false, actionKind, statusUpdatedAt: '2026-10-20T00:00:00Z',
  });

  it('gives each spot a click box for its task, at most two, and none for a waiting or decided task', () => {
    const tasks = [
      review('W'), other('X1', 'completion_held'), other('X2', 'authorization_required'), other('X3', 'workflow_exception'),
      { ...review('D'), needsReview: false, decisionPending: true, latestDecision: { decision: 'reject' as const, actor: 'e', decidedAt: '2026-10-24T00:00:00Z' } },
    ];
    const hits = inReview(posesFor(tasks).benchHit);
    expect(hits.map((hit) => hit.taskId)).toEqual(['X1', 'X2']);
    for (const hit of hits) expect(hit.kind).toBe('desk');
  });
});
