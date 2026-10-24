import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import {
  BEACON_COLOR,
  ESCALATION,
  beaconLit,
  escalationCard,
  escalationLines,
  escalationSeating,
  escalationSpotOf,
} from './officeEscalation';
import { EscalationBlock, EscalationReadout } from './OfficeEscalationViews';
import { buildWaitQueue, queueLines } from './officeBlocked';
import { FACING_Y, characterSlots } from './officeCharacters';
import { DECOR_PLACEMENTS, escalationFixtures, placedDecorBucket } from './officeDecor';
import { buildOfficePoses } from './officeLayout';
import { classifyTasks, planMove, planTravelSeconds, roomFront } from './officeMove';
import { chipValue, visibleReadouts } from './officeLabels';
import { splitLampPoses } from './officeNight';
import {
  ROOM_LAYOUT,
  deskSelectionForTask,
  officeDesks,
  officeTasksFromApi,
  type OfficeTask,
} from './officeSelection';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const TRANSITION_AT = '2026-10-12T09:00:00Z';

function task(taskId: string, phase: OfficeTask['phase'], over: Partial<OfficeTask> = {}): OfficeTask {
  return { taskId, title: taskId, phase, status: 'blocked', needsReview: false, ...over };
}

function escalated(taskId: string, days: number, over: Partial<OfficeTask> = {}): OfficeTask {
  return task(taskId, 'escalated', { statusUpdatedAt: ago(days), ...over });
}

const into = (from: string, agent: string, reason: string | null, to = 'escalated') => ({
  lastTransition: { agent, phase: `${from} -> ${to}`, reason, at: TRANSITION_AT },
} as Partial<OfficeTask>);

const ids = (lines: { taskId: string }[]) => lines.map((line) => line.taskId);

describe('seats', () => {
  it('gives the desk to the task that has waited longest, then two bench seats', () => {
    const tasks = [escalated('E-3', 1), escalated('E-1', 9), escalated('E-2', 4), escalated('E-4', 2)];
    const seating = escalationSeating(tasks);
    expect(seating.desk).toBe('E-1');
    expect(seating.bench).toEqual(['E-2', 'E-4']);
    expect(seating.standing).toEqual([]);
  });

  it('breaks a tie on the task id and puts a task with no date last', () => {
    const tasks = [task('E-9', 'escalated'), escalated('E-2', 3), escalated('E-1', 3)];
    const seating = escalationSeating(tasks);
    expect(seating.desk).toBe('E-1');
    expect(seating.bench).toEqual(['E-2', 'E-9']);
  });

  it('stands free-roam-complete tasks beside the desk, two at most, and never at the desk', () => {
    const tasks = [
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(1) }),
      task('F-2', 'free_roam_complete', { statusUpdatedAt: ago(3) }),
      task('F-3', 'free_roam_complete', { statusUpdatedAt: ago(2) }),
    ];
    const seating = escalationSeating(tasks);
    expect(seating.desk).toBeNull();
    expect(seating.bench).toEqual([]);
    expect(seating.standing).toEqual(['F-2', 'F-3']);
  });

  it('leaves a task beyond its spots without a robot, still counted and listed', () => {
    const tasks = [
      ...[1, 2, 3, 4, 5].map((n) => escalated(`E-${n}`, 10 - n)),
      ...[1, 2, 3].map((n) => task(`F-${n}`, 'free_roam_complete', { statusUpdatedAt: ago(n) })),
    ];
    const slots = characterSlots(tasks).filter((slot) => slot.zoneId === 'escalation');
    expect(slots.map((slot) => slot.taskId).sort()).toEqual(['E-1', 'E-2', 'E-3', 'F-2', 'F-3']);
    expect(escalationLines(tasks, NOW)).toHaveLength(8);
    expect(summarizeZones(tasks).get('escalation')?.count).toBe(8);
    expect(chipValue('escalation', { stats: summarizeZones(tasks), closedToday: 0, abortedTotal: 0, waitingOnEarth: 0 })).toBe(8);
  });

  it('seats the desk robot on the far side facing Earth, the bench facing the desk, standing robots upright', () => {
    const tasks = [
      escalated('E-1', 9), escalated('E-2', 5),
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(2) }),
    ];
    const layout = ROOM_LAYOUT.escalation;
    const slots = new Map(characterSlots(tasks).filter((slot) => slot.zoneId === 'escalation').map((slot) => [slot.taskId, slot]));
    const desk = slots.get('E-1')!;
    expect(desk.x).toBeCloseTo(layout.x + ESCALATION.seat.x);
    expect(desk.z).toBeCloseTo(layout.z + ESCALATION.seat.z);
    expect(desk.rotY).toBeCloseTo(0);
    expect(desk.stance).toBe('sit');
    expect(desk.posture).toBe('waiting');
    const bench = slots.get('E-2')!;
    expect(bench.z).toBeGreaterThan(desk.z);
    expect(bench.rotY).toBe(FACING_Y);
    expect(bench.posture).toBe('waiting');
    const standing = slots.get('F-1')!;
    expect(standing.stance).toBe('stand');
    expect(standing.posture).toBe('standing');
    expect(Math.abs(standing.x - desk.x)).toBeGreaterThan(1);
  });

  it('draws no shared desk row for the room and lists its seats for the side list and the keyboard', () => {
    const tasks = [escalated('E-1', 9), escalated('E-2', 5)];
    expect(officeDesks('escalation', tasks).map((desk) => desk.taskId)).toEqual(['E-1', 'E-2']);
    expect(officeDesks('escalation', []).map((desk) => desk.taskId)).toEqual([null]);
    expect(deskSelectionForTask('E-2', tasks)).toEqual({ kind: 'desk', zoneId: 'escalation', taskId: 'E-2' });
  });

  it('names each spot from the seat position', () => {
    const layout = ROOM_LAYOUT.escalation;
    expect(escalationSpotOf({ x: layout.x + ESCALATION.seat.x, z: layout.z + ESCALATION.seat.z })).toBe('desk');
    expect(escalationSpotOf({ x: layout.x + ESCALATION.bench[1].x, z: layout.z + ESCALATION.bench[1].z + 0.04 })).toBe('bench');
    expect(escalationSpotOf({ x: layout.x + ESCALATION.stand[0].x, z: layout.z + ESCALATION.stand[0].z })).toBe('stand');
    expect(escalationSpotOf({ x: layout.x + 0.01, z: layout.z + 1.3 })).toBeNull();
  });
});

describe('where it came from and why', () => {
  it('reads the room from the phase before the arrow and the role from the transition, nothing else', () => {
    const lines = escalationLines([
      escalated('E-1', 3, into('assigned', 'dev-2', 'execution budget exhausted at the dev gate')),
    ], NOW);
    expect(lines[0].from).toBe('Dev Bay · dev-2');
    expect(lines[0].reason).toBe('execution budget exhausted at the dev gate');
    expect(lines[0].reasonLabel).toBe('reason');
  });

  it('does not read the reason text for the room: a reason that names Review does not move the origin', () => {
    const [line] = escalationLines([
      escalated('E-1', 1, into('assigned', 'dev', 'sent back from review twice')),
    ], NOW);
    expect(line.from).toBe('Dev Bay · dev');
  });

  it('leaves the from part out when the last transition is not into the current phase', () => {
    const [line] = escalationLines([
      escalated('E-1', 1, { lastTransition: { agent: 'dev', phase: 'assigned -> review', reason: 'an older, unrelated reason', at: TRANSITION_AT } }),
    ], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBeNull();
    expect(line.reasonLabel).toBeNull();
  });

  it('leaves everything out when there is no transition at all', () => {
    const [line] = escalationLines([escalated('E-1', 1, { lastTransition: null })], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBeNull();
  });

  it('labels a transition inside the room as the latest note and drops the from part', () => {
    const [line] = escalationLines([
      escalated('E-1', 1, into('escalated', 'free-roam', 'split into two follow-ups')),
    ], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBe('split into two follow-ups');
    expect(line.reasonLabel).toBe('latest note');
  });

  it('shows the reason as written, folded and cut to two readout lines', () => {
    const long = `${'loop guard tripped '.repeat(12)}end`;
    const [line] = escalationLines([escalated('E-1', 1, into('assigned', 'dev', `  ${long}\n `))], NOW);
    expect(line.reason!.length).toBeLessThanOrEqual(91);
    expect(line.reason!.endsWith('…')).toBe(true);
    expect(line.reason).not.toContain('\n');
    const card = escalationCard(escalated('E-1', 1, into('assigned', 'dev', long)), NOW)!;
    expect(card.reason).toBe(long.trim());
  });

  it("uses Earth's decision note when the Escalate button sent it, and says who and from where", () => {
    const [line] = escalationLines([
      escalated('E-1', 2, {
        ...into('review', 'orchestrator', 'human decision: escalate by earth'),
        latestDecision: { decision: 'escalate', actor: 'earth', note: 'Security finding, needs a second pair of eyes.', decidedAt: '2026-10-12T08:59:00Z' },
        decisionPending: false,
      }),
    ], NOW);
    expect(line.from).toBe('from Review · escalated by earth');
    expect(line.reason).toBe('Security finding, needs a second pair of eyes.');
    expect(line.reasonLabel).toBe('reason');
  });

  it('counts an Escalate decision made in the same second as the history row, which keeps no milliseconds', () => {
    // decidedAt keeps milliseconds (routes/decisions.ts); reconcile-decision.rb writes the row to the second.
    const lineAt = (decidedAt: string) => escalationLines([
      escalated('E-1', 2, {
        ...into('review', 'orchestrator', 'human decision: escalate by earth'),
        latestDecision: { decision: 'escalate', actor: 'earth', note: 'Earth note', decidedAt },
        decisionPending: false,
      }),
    ], NOW)[0];
    expect(TRANSITION_AT).toBe('2026-10-12T09:00:00Z');
    expect(lineAt('2026-10-12T09:00:00.500Z').from).toBe('from Review · escalated by earth');
    expect(lineAt('2026-10-12T09:00:00.999Z').reason).toBe('Earth note');
    expect(lineAt('2026-10-12T09:00:01.000Z').reason).toBe('human decision: escalate by earth');
  });

  it('does not use the decision note unless every structured condition holds', () => {
    const base = {
      ...into('review', 'orchestrator', 'human decision: escalate by earth'),
      latestDecision: { decision: 'escalate' as const, actor: 'earth', note: 'Earth note', decidedAt: '2026-10-12T08:59:00Z' },
      decisionPending: false,
    };
    const lineOf = (over: Partial<OfficeTask>) => escalationLines([escalated('E-1', 2, { ...base, ...over })], NOW)[0];
    expect(lineOf({ decisionPending: true }).reason).toBe('human decision: escalate by earth');
    expect(lineOf({ latestDecision: { ...base.latestDecision, decision: 'reject' } }).reason).toBe('human decision: escalate by earth');
    expect(lineOf({ latestDecision: { ...base.latestDecision, decidedAt: '2026-10-13T00:00:00Z' } }).reason).toBe('human decision: escalate by earth');
    expect(lineOf({ ...into('review', 'dev', 'role handed off') }).reason).toBe('role handed off');
    expect(lineOf({ latestDecision: null }).from).toBe('Review · orchestrator');
  });

  it('counts whole days from statusUpdatedAt and lists the longest wait first', () => {
    const lines = escalationLines([escalated('E-2', 1), escalated('E-1', 17), task('E-3', 'escalated')], NOW);
    expect(ids(lines)).toEqual(['E-1', 'E-2', 'E-3']);
    expect(lines.map((line) => line.days)).toEqual([17, 1, null]);
  });

  it('says the free-roam task waits for a handoff instead of showing a reason', () => {
    const lines = escalationLines([
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(0), ...into('escalated', 'free-roam', 'finished my part', 'free_roam_complete') }),
    ], NOW);
    expect(lines[0].kind).toBe('handoff');
    expect(lines[0].reason).toBe('free-roam done · waiting for handoff');
    expect(lines[0].reasonLabel).toBeNull();
    expect(lines[0].from).toBeNull();
  });

  it('lists escalated tasks before handoffs and only tasks of this room', () => {
    const lines = escalationLines([
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(9) }),
      escalated('E-1', 1),
      task('D-1', 'assigned'),
    ], NOW);
    expect(ids(lines)).toEqual(['E-1', 'F-1']);
  });
});

describe('the card', () => {
  it('carries the full reason, the origin and how long, for an escalated task', () => {
    const card = escalationCard(escalated('E-1', 4, into('assigned', 'dev-2', 'runner has no write access')), NOW)!;
    expect(card).toMatchObject({ heading: 'Escalated', from: 'Dev Bay · dev-2', reason: 'runner has no write access', reasonLabel: 'reason', days: 4 });
  });

  it('has no card for a task outside the room', () => {
    expect(escalationCard(task('D-1', 'assigned'), NOW)).toBeNull();
  });

  it('renders the full reason with an Open in Monitor button, including an Escalate-button note', () => {
    const item = escalated('E-1', 2, {
      ...into('review', 'orchestrator', 'human decision: escalate by earth'),
      latestDecision: { decision: 'escalate', actor: 'earth', note: 'Security finding: please look at the token handling before this goes on.', decidedAt: '2026-10-12T08:59:00Z' },
      decisionPending: false,
    });
    const html = renderToStaticMarkup(React.createElement(EscalationBlock, { taskId: 'E-1', card: escalationCard(item, NOW)! }));
    expect(html).toContain('Security finding: please look at the token handling before this goes on.');
    expect(html).toContain('from Review · escalated by earth');
    expect(html).toContain('Open in Monitor');
  });

  it('renders the handoff card without a reason block', () => {
    const item = task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(0) });
    const html = renderToStaticMarkup(React.createElement(EscalationBlock, { taskId: 'F-1', card: escalationCard(item, NOW)! }));
    expect(html).toContain('free-roam done · waiting for handoff');
    expect(html).toContain('Open in Monitor');
  });
});

describe('the readout', () => {
  it('renders one clickable line per task with the id, origin, days and reason', () => {
    const lines = escalationLines([
      escalated('E-1', 3, into('assigned', 'dev-2', 'budget ran out')),
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(0) }),
    ], NOW);
    const html = renderToStaticMarkup(React.createElement(EscalationReadout, { lines, selectedTaskId: 'E-1', onPick: () => undefined }));
    expect(html).toContain('data-readout="escalation"');
    expect(html).toContain('data-task="E-1"');
    expect(html).toContain('data-task="F-1"');
    expect(html).toContain('Dev Bay · dev-2');
    expect(html).toContain('3d');
    expect(html).toContain('budget ran out');
    expect(html).toContain('free-roam done · waiting for handoff');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('aria-pressed="true"');
  });

  it('stays visible while one of its tasks is selected, unlike a room that the card already covers', () => {
    expect([...visibleReadouts({ focus: 'escalation', selection: { zoneId: 'escalation', kind: 'desk' }, tvHot: false })]).toEqual(['escalation']);
    expect([...visibleReadouts({ focus: 'escalation', selection: { zoneId: 'escalation', kind: 'room' }, tvHot: false })]).toEqual([]);
    expect([...visibleReadouts({ focus: 'escalation', selection: null, tvHot: false })]).toEqual(['escalation']);
  });
});

describe('the Blocked overlap', () => {
  it('lists an escalated task that waits on Earth in the Blocked queue tagged Escalation, and keeps it at the help desk', () => {
    const tasks = [
      escalated('E-1', 6, { waitsOn: [{ kind: 'operator_decision' }] }),
      escalated('E-2', 2),
    ];
    const lines = queueLines(buildWaitQueue(tasks, NOW));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ taskId: 'E-1', roomTag: 'Escalation', side: 'earth' });
    expect(escalationSeating(tasks).desk).toBe('E-1');
    expect(ids(escalationLines(tasks, NOW))).toEqual(['E-1', 'E-2']);
  });
});

describe('the beacon', () => {
  it('is lit with at least one escalated task', () => {
    expect(beaconLit([escalated('E-1', 1)])).toBe(true);
    expect(beaconLit([escalated('E-1', 1), task('F-1', 'free_roam_complete')])).toBe(true);
  });

  it('is off for an empty room and for a room that holds only handoffs', () => {
    expect(beaconLit([])).toBe(false);
    expect(beaconLit([task('D-1', 'assigned')])).toBe(false);
    expect(beaconLit([task('F-1', 'free_roam_complete'), task('F-2', 'free_roam_complete')])).toBe(false);
  });

  it('is a warm white that is not a status color (saturation below 0.15)', () => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(BEACON_COLOR.slice(at, at + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect((max - min) / max).toBeLessThan(0.15);
    expect(r).toBeGreaterThanOrEqual(b);
  });
});

describe('the furniture', () => {
  it('has no shared desk row, side table or coat rack, and the help desk is the only desk', () => {
    const escalationDecor = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'escalation').map((item) => item.file);
    expect(escalationDecor).not.toContain('sideTable');
    expect(escalationDecor).not.toContain('coatRackStanding');
    for (const file of ['bookcaseClosed', 'cabinetBedDrawer', 'lampRoundFloor', 'benchCushionLow', 'chair']) {
      expect(escalationDecor).toContain(file);
    }
    const tasks = [1, 2, 3, 4].map((n) => escalated(`E-${n}`, n));
    const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
    expect(poses.desk.filter((pose) => pose.zoneId === 'escalation')).toHaveLength(1);
    expect(poses.lamp.filter((pose) => pose.zoneId === 'escalation')).toHaveLength(1);
  });

  it('merges the incident board, rug and button shapes into the decor buckets', () => {
    const shapes = escalationFixtures();
    expect(Object.keys(shapes).length).toBeGreaterThan(0);
    for (const list of Object.values(shapes)) {
      for (const geometry of list ?? []) expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
    expect(Object.keys(shapes).every((bucket) => ['wood', 'metal', 'fabric'].includes(bucket))).toBe(true);
  });

  it('keeps the floor lamp off the shared glowing shade material', () => {
    expect(placedDecorBucket('escalation', 'shade')).not.toBe('shade');
    expect(placedDecorBucket('devops', 'shade')).toBe('shade');
  });

  it('lights the desk lamp only while Escalation holds a task, whatever DevOps does', () => {
    const empty = [task('O-1', 'devops_needed', { status: 'running' })];
    const emptyStats = summarizeZones(empty);
    const emptyLamps = buildOfficePoses(empty, emptyStats, null, null).lamp.filter((pose) => pose.zoneId === 'escalation');
    expect(splitLampPoses(emptyLamps, emptyStats).lit).toHaveLength(0);
    const busy = [...empty, escalated('E-1', 1)];
    const busyStats = summarizeZones(busy);
    const busyLamps = buildOfficePoses(busy, busyStats, null, null).lamp.filter((pose) => pose.zoneId === 'escalation');
    expect(splitLampPoses(busyLamps, busyStats).lit).toHaveLength(1);
  });

  it('makes the seats click targets that select their task, and the empty help desk a room target', () => {
    const tasks = [
      escalated('E-1', 9), escalated('E-2', 5),
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(2) }),
    ];
    const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
    const inRoom = (list: typeof poses.desk) => list.filter((pose) => pose.zoneId === 'escalation');
    const clickable = [...inRoom(poses.desk), ...inRoom(poses.chair), ...inRoom(poses.benchHit)]
      .filter((pose) => pose.kind === 'desk')
      .map((pose) => pose.taskId);
    expect(new Set(clickable)).toEqual(new Set(['E-1', 'E-2', 'F-1']));
    const empty = buildOfficePoses([], summarizeZones([]), null, null);
    expect(inRoom(empty.desk)[0].kind).toBe('room');
  });
});

describe('movement', () => {
  const layout = ROOM_LAYOUT.escalation;
  const place = (tasks: OfficeTask[], taskId: string) => classifyTasks(tasks).find((item) => item.taskId === taskId)!;
  const options = { reducedMotion: false, initial: false };

  it('walks a new arrival in by the front, presses the call button, then sits at the desk', () => {
    const before = [task('E-1', 'assigned', { status: 'running' })];
    const after = [escalated('E-1', 0)];
    const plan = planMove(place(before, 'E-1'), place(after, 'E-1'), options)!;
    const roles = plan.points.map((point) => point.role);
    expect(roles).toContain('press');
    expect(roles.indexOf('press')).toBeLessThan(roles.lastIndexOf('seat'));
    expect(plan.points[plan.points.length - 1].role).toBe('seat');
    expect(plan.points.some((point) => point.role === 'door' && Math.abs(point.z - roomFront('escalation').z) < 0.01)).toBe(true);
    const seat = plan.points[plan.points.length - 1];
    expect(seat.x).toBeCloseTo(layout.x + ESCALATION.seat.x);
    const press = plan.points.find((point) => point.role === 'press')!;
    expect(press.x).toBeCloseTo(layout.x + ESCALATION.press.x);
    expect(press.z).toBeCloseTo(layout.z + ESCALATION.press.z);
    expect(planTravelSeconds(plan)).toBeGreaterThan(planTravelSeconds({ ...plan, points: plan.points.filter((point) => point.role !== 'press') }));
  });

  it('keeps clear of the desk and the bench on the way to the far-side seat', () => {
    const plan = planMove(place([task('E-1', 'assigned', { status: 'running' })], 'E-1'), place([escalated('E-1', 0)], 'E-1'), options)!;
    const inside = plan.points.filter((point) => point.z < layout.z + 1.6);
    for (const point of inside) {
      const localX = point.x - layout.x;
      const localZ = point.z - layout.z;
      const overDesk = Math.abs(localX - ESCALATION.desk.x) < 0.62 && Math.abs(localZ - ESCALATION.desk.z) < 0.5;
      expect(overDesk && point.role !== 'seat').toBe(false);
    }
  });

  it('sends a bench arrival to the bench and a handoff to its standing spot, with no button press', () => {
    const base = [
      escalated('E-1', 9), escalated('E-2', 5),
      task('F-1', 'free_roam_complete', { statusUpdatedAt: ago(1) }),
    ];
    const outside = base.map((item) => ({ ...item, phase: 'assigned' as const, status: 'running' as const }));
    const bench = planMove(place(outside, 'E-2'), place(base, 'E-2'), options)!;
    expect(bench.points.map((point) => point.role)).not.toContain('press');
    expect(escalationSpotOf(bench.points[bench.points.length - 1])).toBe('bench');
    const stand = planMove(place(outside, 'F-1'), place(base, 'F-1'), options)!;
    expect(stand.points.map((point) => point.role)).not.toContain('press');
    expect(escalationSpotOf(stand.points[stand.points.length - 1])).toBe('stand');
  });

  it('leaves the way it came: back out the lane, never through the desk', () => {
    const tasks = [escalated('E-1', 9)];
    const plan = planMove(place(tasks, 'E-1'), place([task('E-1', 'assigned', { status: 'running' })], 'E-1'), options)!;
    expect(plan.points[0].role).toBe('seat');
    expect(plan.points[plan.points.length - 1].role === 'door' || plan.points[plan.points.length - 1].role === 'seat').toBe(true);
    for (const point of plan.points.slice(1, 4)) {
      if (point.z - layout.z < 1.6) expect(Math.abs(point.x - layout.x - ESCALATION.desk.x) > 0.62 || point.z - layout.z > 0.2).toBe(true);
    }
  });

  it('shows no walk and no button press on first load, with snap, or under reduced motion', () => {
    const tasks = [escalated('E-1', 9), escalated('E-2', 5)];
    const next = place(tasks, 'E-1');
    const first = planMove(null, next, { reducedMotion: false, initial: true })!;
    expect(first.action).toBe('stay');
    expect(first.points.map((point) => point.role)).toEqual(['seat']);
    const snapped = planMove(place([task('E-1', 'assigned', { status: 'running' })], 'E-1'), next, { reducedMotion: false, initial: false, snap: true })!;
    expect(snapped.action).toBe('instant');
    expect(snapped.points.map((point) => point.role)).toEqual(['seat']);
    const reduced = planMove(place([task('E-1', 'assigned', { status: 'running' })], 'E-1'), next, { reducedMotion: true, initial: false })!;
    expect(reduced.action).toBe('instant');
    expect(reduced.points.map((point) => point.role)).toEqual(['seat']);
  });

  it('re-seats in place when the order changes, without a walk', () => {
    const before = [escalated('E-1', 9), escalated('E-2', 5)];
    const after = [escalated('E-1', 9), escalated('E-2', 5), escalated('E-0', 12)];
    const plan = planMove(place(before, 'E-1'), place(after, 'E-1'), options)!;
    expect(plan.action).toBe('stay');
  });
});

describe('the data', () => {
  it('keeps the latest decision and whether it is still pending from the review model', () => {
    const latestDecision = { decision: 'escalate' as const, actor: 'earth', note: 'Look at this.', decidedAt: '2026-10-12T08:59:00Z' };
    const [item] = officeTasksFromApi(
      [{ taskId: 'E-1', title: 'E-1', phase: 'escalated', needsReview: false, latestDecision, decisionPending: false }],
      [],
    );
    expect(item.latestDecision).toEqual(latestDecision);
    expect(item.decisionPending).toBe(false);
  });
});
