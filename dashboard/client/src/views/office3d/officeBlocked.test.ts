import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inBangkok } from '../../testing/inBangkok';
import { summarizeZones } from '../commandZones';
import {
  BAR_CAP,
  BENCH_COUNT,
  BLINK_STEPS,
  BLOCKED,
  CHAIR_COUNT,
  blockedChip,
  blockedSeating,
  boardBars,
  buildWaitQueue,
  litBars,
  queueLines,
  waitCard,
} from './officeBlocked';
import { BlockedReadout, WaitBlock } from './OfficeWaitViews';
import { characterSlots } from './officeCharacters';
import { DECOR_PLACEMENTS, blockedFixtures } from './officeDecor';
import { barPoses, buildOfficePoses } from './officeLayout';
import { classifyTasks, planMove, roomFront } from './officeMove';
import {
  ROOM_LAYOUT,
  deskSelectionForTask,
  describeOfficeSelection,
  officeDesks,
  officeTasksFromApi,
  type OfficeTask,
} from './officeSelection';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 3_600_000;
const ago = (days: number, hours = 0) => new Date(NOW - days * 24 * HOUR - hours * HOUR).toISOString();
const GRANT = 'ruby scripts/record-authorization.rb --task TASK-EAR-402 grant <name>';

function task(taskId: string, phase: OfficeTask['phase'], over: Partial<OfficeTask> = {}): OfficeTask {
  return { taskId, title: taskId, phase, status: 'blocked', needsReview: false, ...over };
}

/** The 2026-10-24 live data from the design doc: six wait on Earth, two on others in Blocked, one on QA in Dev Bay. */
function live(): OfficeTask[] {
  return [
    task('TASK-VS-004', 'assigned', { status: 'running', waitsOn: [{ kind: 'operator_decision' }, { kind: 'operator_approval' }], statusUpdatedAt: ago(29), recommendedAction: 'Record the decision.' }),
    task('TASK-EAR-391', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }], statusUpdatedAt: ago(15), recommendedAction: 'Resolve the recorded blocker before dispatching another role.' }),
    task('TASK-EAR-368', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(14), recommendedAction: 'Resolve the recorded blocker before dispatching another role.' }),
    task('TASK-EAR-309', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(12), recommendedAction: null }),
    task('TASK-EAR-402', 'blocked', { waitsOn: [{ kind: 'prod_run' }], isReleaseTrain: true, actionKind: 'authorization_required', statusUpdatedAt: ago(9, 4), recommendedAction: GRANT }),
    task('TASK-EAR-406', 'assigned', { status: 'running', waitsOn: [{ kind: 'operator_approval' }, { kind: 'prod_run', ref: 'TASK-EAR-402' }], isReleaseTrain: true, actionKind: 'authorization_required', statusUpdatedAt: ago(9, 1), recommendedAction: GRANT }),
    task('TASK-EAR-369', 'blocked', { waitsOn: [{ kind: 'aws_permission' }], statusUpdatedAt: ago(12, 3) }),
    task('TASK-EAR-349', 'blocked', { waitsOn: [{ kind: 'aws_permission' }], statusUpdatedAt: ago(12) }),
    task('TASK-EAR-384', 'assigned', { status: 'running', waitsOn: [{ kind: 'qa' }], statusUpdatedAt: ago(5) }),
  ];
}

const ids = (lines: { taskId: string }[]) => lines.map((line) => line.taskId);

describe('who waits on Earth', () => {
  const queueOf = (item: OfficeTask) => buildWaitQueue([item], NOW);

  it.each([
    ['prod_run', 'prod run'],
    ['operator_decision', 'decision'],
    ['operator_approval', 'approval'],
  ] as const)('counts a %s wait as waiting on Earth', (kind, label) => {
    const queue = queueOf(task('T', 'blocked', { waitsOn: [{ kind }] }));
    expect(queue.earth).toHaveLength(1);
    expect(queue.earth[0].label).toBe(label);
    expect(queue.others).toHaveLength(0);
  });

  it("counts a release train's own prod run as waiting on Earth", () => {
    const queue = queueOf(task('TRAIN', 'blocked', { waitsOn: [{ kind: 'prod_run' }], isReleaseTrain: true }));
    expect(ids(queue.earth)).toEqual(['TRAIN']);
  });

  it('counts the authorization_required action kind and labels it "grant"', () => {
    const queue = queueOf(task('G', 'blocked', { actionKind: 'authorization_required' }));
    expect(queue.earth[0].label).toBe('grant');
    const both = queueOf(task('G2', 'blocked', { waitsOn: [{ kind: 'prod_run' }], actionKind: 'authorization_required' }));
    expect(both.earth[0].label).toBe('prod run, grant');
  });

  it.each([
    ['aws_permission', 'AWS permission'],
    ['qa', 'QA'],
    ['external', 'external party'],
  ] as const)('counts a %s wait as waiting on others', (kind, label) => {
    const queue = queueOf(task('T', 'blocked', { waitsOn: [{ kind }] }));
    expect(queue.earth).toHaveLength(0);
    expect(queue.others).toHaveLength(1);
    expect(queue.others[0]).toMatchObject({ label, recorded: true });
  });

  it('puts a task with an Earth wait and an AWS wait on the Earth side', () => {
    const queue = queueOf(task('MIX', 'blocked', { waitsOn: [{ kind: 'aws_permission' }, { kind: 'operator_approval' }] }));
    expect(queue.earth[0].label).toBe('approval');
  });

  it('lists a Blocked task with no wait as "wait not recorded" and does not count it on Earth', () => {
    const queue = queueOf(task('NONE', 'blocked', { waitsOn: [] }));
    expect(queue.earth).toHaveLength(0);
    expect(queue.others).toEqual([expect.objectContaining({ taskId: 'NONE', label: 'wait not recorded', recorded: false })]);
    expect(blockedChip(queue)).toBeNull();
  });

  it('reads only structured fields, never the reason or the command text', () => {
    const queue = queueOf(task('TEXT', 'blocked', {
      waitsOn: [{ kind: 'aws_permission' }],
      recommendedAction: 'ruby scripts/record-authorization.rb grant operator approval prod run',
    }));
    expect(queue.earth).toHaveLength(0);
    expect(queue.others[0].label).toBe('AWS permission');
  });

  it('never lists a finished task, even with a stale wait', () => {
    const queue = buildWaitQueue([
      task('DONE', 'done', { status: 'completed', waitsOn: [{ kind: 'prod_run' }] }),
      task('GONE', 'aborted', { status: 'cancelled', waitsOn: [{ kind: 'operator_approval' }] }),
    ], NOW);
    expect(queueLines(queue)).toHaveLength(0);
  });
});

describe('waiting on you across rooms', () => {
  it('lists the live data: six on Earth, two on others, and leaves the QA wait in Dev Bay out', () => {
    const queue = buildWaitQueue(live(), NOW);
    expect(ids(queue.earth)).toEqual(['TASK-VS-004', 'TASK-EAR-368', 'TASK-EAR-309', 'TASK-EAR-402', 'TASK-EAR-391', 'TASK-EAR-406']);
    expect(ids(queue.others)).toEqual(['TASK-EAR-369', 'TASK-EAR-349']);
    expect(queueLines(queue).some((line) => line.taskId === 'TASK-EAR-384')).toBe(false);
  });

  it('tags a task from another room with its room name and leaves Blocked tasks untagged', () => {
    const queue = buildWaitQueue(live(), NOW);
    const tag = (taskId: string) => queue.earth.find((line) => line.taskId === taskId)?.roomTag;
    expect(tag('TASK-EAR-406')).toBe('Dev Bay');
    expect(tag('TASK-VS-004')).toBe('Dev Bay');
    expect(tag('TASK-EAR-402')).toBeNull();
  });

  it('keeps the robot of a task that waits on Earth in its own room', () => {
    const slots = characterSlots(live());
    expect(slots.find((slot) => slot.taskId === 'TASK-EAR-406')?.zoneId).toBe('dev');
    expect(slots.find((slot) => slot.taskId === 'TASK-VS-004')?.zoneId).toBe('dev');
    expect(blockedSeating(live()).chairs).not.toContain('TASK-EAR-406');
  });

  it('does not list a task in another room that waits only on others', () => {
    const queue = buildWaitQueue([task('QA-ONLY', 'assigned', { status: 'running', waitsOn: [{ kind: 'qa' }] })], NOW);
    expect(queueLines(queue)).toHaveLength(0);
  });

  it('does not list a task in another room with no wait and no grant', () => {
    expect(queueLines(buildWaitQueue([task('FREE', 'assigned', { status: 'running' })], NOW))).toHaveLength(0);
  });

  describe('in Bangkok', () => {
    inBangkok();

    it('reads a date-only statusUpdatedAt as local midnight, the basis of the side panel\'s Oldest wait', () => {
      // 01:00 local on the 24th: a date-only value read as UTC midnight would give 8 days in Bangkok.
      const early = new Date(2026, 9, 24, 1).getTime();
      const queue = buildWaitQueue([task('DATE-ONLY', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: '2026-10-15' })], early);
      expect(queue.earth[0].days).toBe(9);
      const late = new Date(2026, 9, 24, 23).getTime();
      expect(buildWaitQueue([task('DATE-ONLY', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: '2026-10-15' })], late).earth[0].days).toBe(9);
    });
  });

  it('keeps a full timestamp as the instant it names', () => {
    const queue = buildWaitQueue([task('STAMP', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: '2026-10-15T00:00:00Z' })], Date.parse('2026-10-24T00:00:00Z'));
    expect(queue.earth[0].days).toBe(9);
  });

  it('measures the wait in whole days from statusUpdatedAt', () => {
    const queue = buildWaitQueue(live(), NOW);
    const days = (taskId: string) => queue.earth.find((line) => line.taskId === taskId)?.days;
    expect(days('TASK-VS-004')).toBe(29);
    expect(days('TASK-EAR-402')).toBe(9);
    const missing = buildWaitQueue([task('NODATE', 'blocked', { waitsOn: [{ kind: 'prod_run' }] })], NOW);
    expect(missing.earth[0].days).toBeNull();
  });
});

describe('chains and order', () => {
  it('puts a task whose only wait is a listed task under it, with its own age', () => {
    const queue = buildWaitQueue(live(), NOW);
    const parent = queue.earth.findIndex((line) => line.taskId === 'TASK-EAR-402');
    expect(queue.earth[parent + 1]).toMatchObject({ taskId: 'TASK-EAR-391', parentId: 'TASK-EAR-402', depth: 1, days: 15 });
    expect(queue.earth[parent]).toMatchObject({ parentId: null, depth: 0, days: 9 });
  });

  it('keeps a task with its own Earth wait on its own line (TASK-EAR-406)', () => {
    const queue = buildWaitQueue(live(), NOW);
    expect(queue.earth.find((line) => line.taskId === 'TASK-EAR-406')).toMatchObject({ parentId: null, depth: 0 });
  });

  it('gives a task its own line when the task it references is not listed', () => {
    const queue = buildWaitQueue([
      task('CHILD', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'CLOSED' }], statusUpdatedAt: ago(3) }),
      task('CLOSED', 'done', { status: 'completed' }),
    ], NOW);
    expect(queue.earth).toEqual([expect.objectContaining({ taskId: 'CHILD', parentId: null, depth: 0 })]);
  });

  it('keeps a task whose every wait references the same listed task, but not one that also waits elsewhere', () => {
    const queue = buildWaitQueue([
      task('PARENT', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(2) }),
      task('ALL-REF', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'PARENT' }, { kind: 'operator_approval', ref: 'PARENT' }], statusUpdatedAt: ago(8) }),
      task('SPLIT', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'PARENT' }, { kind: 'operator_decision' }], statusUpdatedAt: ago(7) }),
    ], NOW);
    const parentOf = (taskId: string) => queue.earth.find((line) => line.taskId === taskId)?.parentId;
    expect(parentOf('ALL-REF')).toBe('PARENT');
    expect(parentOf('SPLIT')).toBeNull();
  });

  it('lists two tasks that wait on each other instead of dropping both', () => {
    const queue = buildWaitQueue([
      task('A', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'B' }], statusUpdatedAt: ago(5) }),
      task('B', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'A' }], statusUpdatedAt: ago(3) }),
    ], NOW);
    expect(ids(queue.earth).sort()).toEqual(['A', 'B']);
    expect(queue.earth.filter((line) => line.parentId === null)).toHaveLength(1);
  });

  it('does not chain a task to itself', () => {
    const queue = buildWaitQueue([task('SELF', 'blocked', { waitsOn: [{ kind: 'prod_run', ref: 'SELF' }] })], NOW);
    expect(queue.earth[0].parentId).toBeNull();
  });

  it('orders the longest wait first, a missing date last, the task id on a tie', () => {
    const when = ago(4);
    const queue = buildWaitQueue([
      task('NODATE', 'blocked', { waitsOn: [{ kind: 'prod_run' }] }),
      task('B-TIE', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: when }),
      task('A-TIE', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: when }),
      task('OLD', 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(20) }),
    ], NOW);
    expect(ids(queue.earth)).toEqual(['OLD', 'A-TIE', 'B-TIE', 'NODATE']);
  });
});

describe('chip and board bars', () => {
  it('is the number waiting on Earth, from every room', () => {
    expect(blockedChip(buildWaitQueue(live(), NOW))).toBe(6);
  });

  it('hides at zero even while tasks wait on others', () => {
    const queue = buildWaitQueue(live().filter((item) => item.waitsOn?.[0]?.kind === 'aws_permission'), NOW);
    expect(queue.others).toHaveLength(2);
    expect(blockedChip(queue)).toBeNull();
  });

  it('lights one bar per task waiting on Earth, up to the cap', () => {
    expect(boardBars(0)).toBe(0);
    expect(boardBars(6)).toBe(6);
    expect(boardBars(BAR_CAP + 5)).toBe(BAR_CAP);
    expect(barPoses(6)).toHaveLength(6);
    expect(barPoses(BAR_CAP + 5)).toHaveLength(BAR_CAP);
    expect(barPoses(0)).toHaveLength(0);
  });

  it('blinks the bar that goes out, then leaves it dark; reduced motion just turns it off', () => {
    expect(litBars(5, 1, 0, false)).toBe(6);
    expect(litBars(5, 1, 1, false)).toBe(5);
    expect(litBars(5, 1, 2, false)).toBe(6);
    expect(litBars(5, 1, BLINK_STEPS, false)).toBe(5);
    expect(litBars(5, 1, 0, true)).toBe(5);
    expect(litBars(5, 0, 0, false)).toBe(5);
  });

  it('draws the bars in warm white on the back wall, in front of the board', () => {
    const bars = barPoses(3);
    expect(bars.every((pose) => pose.color === '#f3ecdf')).toBe(true);
    expect(bars.every((pose) => pose.z < ROOM_LAYOUT.blocked.z && pose.z > ROOM_LAYOUT.blocked.z + BLOCKED.board.z - 0.05)).toBe(true);
    expect(new Set(bars.map((pose) => pose.x)).size).toBe(3);
  });
});

describe('the selection card', () => {
  const queue = buildWaitQueue(live(), NOW);
  const byId = new Map(live().map((item) => [item.taskId, item]));
  const card = (taskId: string) => waitCard(byId.get(taskId)!, queue)!;
  const html = (taskId: string, goTo = () => undefined) => renderToStaticMarkup(
    React.createElement(WaitBlock, { taskId, card: card(taskId), onGoTo: goTo }),
  );

  it('shows the wait line, the command and a Copy button when the recommended action is a shell command', () => {
    expect(card('TASK-EAR-402')).toMatchObject({ heading: 'Waiting on you', days: 9, command: GRANT, goTo: null });
    const markup = html('TASK-EAR-402');
    expect(markup).toContain('Waiting on you · 9d · approval to run prod, an authorization grant');
    expect(markup).toContain('record-authorization.rb');
    expect(markup).toContain('Copy command');
    expect(markup).not.toContain('No command recorded');
  });

  it('shows the same block for a task in another room (TASK-EAR-406 in Dev Bay)', () => {
    const markup = html('TASK-EAR-406');
    expect(markup).toContain('Copy command');
    expect(markup).toContain('Open in Monitor');
  });

  it('offers a button to the task a chained task waits on instead of a command', () => {
    expect(card('TASK-EAR-391')).toMatchObject({ command: null, goTo: 'TASK-EAR-402' });
    const markup = html('TASK-EAR-391');
    expect(markup).toContain('Waiting on TASK-EAR-402');
    expect(markup).toContain('Go to TASK-EAR-402');
    expect(markup).not.toContain('Copy command');
    expect(markup).not.toContain('No command recorded');
  });

  it('says plainly that no command is recorded, and never shows prose as a command', () => {
    expect(card('TASK-EAR-368').command).toBeNull();
    const markup = html('TASK-EAR-368');
    expect(markup).toContain('No command recorded for this wait');
    expect(markup).not.toContain('Copy command');
    expect(markup).not.toContain('Resolve the recorded blocker');
  });

  it('never invents a command from another task', () => {
    expect(card('TASK-EAR-309').command).toBeNull();
    expect(card('TASK-VS-004').command).toBeNull();
  });

  it('gives every waiting task an Open in Monitor button', () => {
    for (const line of queueLines(queue)) {
      expect(html(line.taskId), line.taskId).toContain('Open in Monitor');
    }
  });

  it('says who the others are and names a missing wait', () => {
    expect(card('TASK-EAR-369')).toMatchObject({ heading: 'Waiting on others', detail: 'an AWS permission' });
    const none = waitCard(task('NONE', 'blocked'), buildWaitQueue([task('NONE', 'blocked')], NOW))!;
    expect(none.heading).toBe('Wait not recorded');
  });

  it('has no card block for a task that is not waiting', () => {
    expect(waitCard(task('FREE', 'assigned', { status: 'running' }), queue)).toBeNull();
    expect(waitCard(byId.get('TASK-EAR-384')!, queue)).toBeNull();
  });
});

describe('the readout', () => {
  const queue = buildWaitQueue(live(), NOW);
  const markup = (selected: string | null) => renderToStaticMarkup(
    React.createElement(BlockedReadout, { queue, selectedTaskId: selected, onPick: () => undefined }),
  );

  it('heads the Earth queue, one line per task, then the others dimmer', () => {
    const html = markup(null);
    expect(html).toContain('waiting on you · 6');
    expect(html).toContain('waiting on others · 2');
    for (const line of queueLines(queue)) expect(html).toContain(`data-task="${line.taskId}"`);
    expect(html.indexOf('waiting on you')).toBeLessThan(html.indexOf('TASK-VS-004'));
    expect(html.indexOf('TASK-EAR-406')).toBeLessThan(html.indexOf('waiting on others'));
    expect(html.indexOf('waiting on others')).toBeLessThan(html.indexOf('TASK-EAR-369'));
  });

  it('shows id, what it waits on, days, and the room of a task from another room', () => {
    const html = markup(null);
    expect(html).toMatch(/TASK-EAR-406<\/span><span class="what">prod run, approval, grant<\/span><span class="age">9d<\/span><span class="room">Dev Bay<\/span>/);
    expect(html).toMatch(/TASK-EAR-369<\/span><span class="what">AWS permission<\/span><span class="age">12d<\/span>/);
  });

  it('highlights the selected line and only that one', () => {
    const html = markup('TASK-EAR-402');
    expect(html.match(/data-on="1"/g)).toHaveLength(1);
    expect(html).toMatch(/data-on="1" data-task="TASK-EAR-402"/);
    expect(markup(null)).not.toContain('data-on');
  });

  it('indents a chained task under its parent', () => {
    expect(markup(null)).toMatch(/data-task="TASK-EAR-391" aria-pressed="false" style="padding-left:14px"/);
  });

  it('shows an empty Earth queue with the header and no lines', () => {
    const html = renderToStaticMarkup(React.createElement(BlockedReadout, {
      queue: buildWaitQueue([], NOW),
      selectedTaskId: null,
      onPick: () => undefined,
    }));
    expect(html).toContain('waiting on you · 0');
    expect(html).not.toContain('waiting on others');
  });
});

describe('the room card order', () => {
  it('lists the Earth queue first (other rooms tagged), then the others, in readout order', () => {
    const detail = describeOfficeSelection({ kind: 'room', zoneId: 'blocked' }, live());
    expect(detail.tasks.map((line) => line.taskId)).toEqual([
      'TASK-VS-004', 'TASK-EAR-368', 'TASK-EAR-309', 'TASK-EAR-402', 'TASK-EAR-391', 'TASK-EAR-406', 'TASK-EAR-369', 'TASK-EAR-349',
    ]);
    expect(detail.tasks.find((line) => line.taskId === 'TASK-EAR-406')?.roomTag).toBe('Dev Bay');
    expect(detail.tasks.find((line) => line.taskId === 'TASK-EAR-402')?.roomTag).toBeUndefined();
  });
});

describe('data from the read model', () => {
  it('keeps waitsOn, isReleaseTrain, actionKind and recommendedAction on the office task', () => {
    const [mapped] = officeTasksFromApi([{
      taskId: 'T',
      title: 'T',
      phase: 'blocked',
      needsReview: false,
      waitsOn: [{ kind: 'prod_run', ref: 'X' }],
      isReleaseTrain: true,
      actionKind: 'authorization_required',
      recommendedAction: GRANT,
    }], []);
    expect(mapped).toMatchObject({
      waitsOn: [{ kind: 'prod_run', ref: 'X' }],
      isReleaseTrain: true,
      actionKind: 'authorization_required',
      recommendedAction: GRANT,
    });
  });
});

describe('the room', () => {
  const tasks = live();
  const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
  const inBlocked = (list: { zoneId: string }[]) => list.filter((pose) => pose.zoneId === 'blocked');

  it('has no desks or screens in Blocked', () => {
    expect(inBlocked(poses.desk)).toHaveLength(0);
    expect(inBlocked(poses.screenOn)).toHaveLength(0);
    expect(inBlocked(poses.screenOff)).toHaveLength(0);
  });

  it('puts four chairs facing the back wall and a click box on each of three bench seats', () => {
    const chairs = inBlocked(poses.chair);
    expect(chairs).toHaveLength(CHAIR_COUNT);
    expect(chairs.every((pose) => Math.abs(pose.rotY - Math.PI) < 1e-9)).toBe(true);
    expect(inBlocked(poses.benchHit)).toHaveLength(BENCH_COUNT);
  });

  it('removes the old cardboard boxes and adds the bench, with the board, clock and door as plain shapes', () => {
    const blocked = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'blocked');
    expect(blocked.some((item) => item.file.startsWith('cardboardBox'))).toBe(false);
    expect(blocked.map((item) => item.file)).toEqual(['benchCushionLow']);
    const shapes = blockedFixtures();
    expect(shapes.metal?.length).toBeGreaterThan(0);
    expect(shapes.wood?.length).toBeGreaterThan(0);
    for (const geometry of [...(shapes.metal ?? []), ...(shapes.wood ?? [])]) {
      expect(geometry.getAttribute('uv')).toBeUndefined();
      expect(geometry.index).toBeNull();
    }
  });

  it('keeps the front row empty and the board dark when nothing waits on Earth', () => {
    const empty = buildOfficePoses([], summarizeZones([]), null, null);
    expect(inBlocked(empty.chair).every((pose) => pose.taskId === null)).toBe(true);
    expect(barPoses(boardBars(buildWaitQueue([], NOW).earth.length))).toHaveLength(0);
  });
});

describe('seats', () => {
  it('seats the Earth queue on the chairs, longest wait first, and the others on the bench', () => {
    expect(blockedSeating(live())).toEqual({
      chairs: ['TASK-EAR-391', 'TASK-EAR-368', 'TASK-EAR-309', 'TASK-EAR-402'],
      bench: ['TASK-EAR-369', 'TASK-EAR-349'],
    });
  });

  it('draws one robot per seat in Blocked: up to four on chairs and three on the bench', () => {
    const crowd: OfficeTask[] = [
      ...Array.from({ length: 6 }, (_, index) => task(`E${index}`, 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(10 - index) })),
      ...Array.from({ length: 5 }, (_, index) => task(`O${index}`, 'blocked', { waitsOn: [{ kind: 'aws_permission' }], statusUpdatedAt: ago(10 - index) })),
    ];
    const seating = blockedSeating(crowd);
    expect(seating.chairs).toEqual(['E0', 'E1', 'E2', 'E3']);
    expect(seating.bench).toEqual(['O0', 'O1', 'O2']);
    const slots = characterSlots(crowd).filter((slot) => slot.zoneId === 'blocked');
    expect(slots).toHaveLength(7);
    expect(slots.every((slot) => slot.posture === 'blocked')).toBe(true);
  });

  it('leaves a task past its group seats without a robot, still counted and listed', () => {
    const crowd = Array.from({ length: 6 }, (_, index) => task(`E${index}`, 'blocked', { waitsOn: [{ kind: 'prod_run' }], statusUpdatedAt: ago(10 - index) }));
    const slots = characterSlots(crowd);
    expect(slots.some((slot) => slot.taskId === 'E5')).toBe(false);
    const place = classifyTasks(crowd).find((item) => item.taskId === 'E5')!;
    expect(place.drawn).toBe(false);
    const queue = buildWaitQueue(crowd, NOW);
    expect(ids(queue.earth)).toContain('E5');
    expect(blockedChip(queue)).toBe(6);
    expect(describeOfficeSelection({ kind: 'room', zoneId: 'blocked' }, crowd).tasks).toHaveLength(6);
  });

  it('seats the chairs and the bench in their own spots, chairs facing the board', () => {
    const slots = characterSlots(live()).filter((slot) => slot.zoneId === 'blocked');
    const layout = ROOM_LAYOUT.blocked;
    const slot = (taskId: string) => slots.find((item) => item.taskId === taskId)!;
    expect(slot('TASK-EAR-391').x).toBeCloseTo(layout.x + BLOCKED.chairs[0].x);
    expect(slot('TASK-EAR-402').x).toBeCloseTo(layout.x + BLOCKED.chairs[3].x);
    expect(slot('TASK-EAR-402').z).toBeCloseTo(layout.z + BLOCKED.chairs[3].z + BLOCKED.seatOffsetZ);
    expect(slot('TASK-EAR-369').z).toBeCloseTo(layout.z + BLOCKED.bench[0].z + BLOCKED.seatOffsetZ);
    expect(slot('TASK-EAR-369').z).toBeGreaterThan(slot('TASK-EAR-391').z);
  });

  it('re-seats a task that changes group in place, with no walk', () => {
    const before = live();
    const after = before.map((item) => (item.taskId === 'TASK-EAR-368'
      ? { ...item, waitsOn: [{ kind: 'aws_permission' as const }] }
      : item));
    const prev = classifyTasks(before).find((item) => item.taskId === 'TASK-EAR-368')!;
    const next = classifyTasks(after).find((item) => item.taskId === 'TASK-EAR-368')!;
    expect(prev.seat).not.toEqual(next.seat);
    const plan = planMove(prev, next, { reducedMotion: false, initial: false })!;
    expect(plan.action).toBe('stay');
    expect(plan.gait).toBe('none');
    expect(plan.points).toEqual([{ x: next.seat!.x, z: next.seat!.z, role: 'seat' }]);
  });

  it('stands a robot up and walks it out the room front when its task leaves Blocked', () => {
    const before = live();
    const after = before.map((item) => (item.taskId === 'TASK-EAR-309' ? { ...item, phase: 'assigned' as const, waitsOn: [] } : item));
    const prev = classifyTasks(before).find((item) => item.taskId === 'TASK-EAR-309')!;
    const next = classifyTasks(after).find((item) => item.taskId === 'TASK-EAR-309')!;
    const plan = planMove(prev, next, { reducedMotion: false, initial: false })!;
    expect(plan.action).toBe('walk');
    const front = roomFront('blocked');
    const door = plan.points.findIndex((point) => point.role === 'door' && Math.hypot(point.x - front.x, point.z - front.z) < 0.001);
    expect(door).toBeGreaterThan(0);
    expect(plan.points[0]).toMatchObject({ role: 'seat', x: prev.seat!.x, z: prev.seat!.z });
    expect(plan.points[plan.points.length - 1]).toMatchObject({ role: 'seat', x: next.seat!.x, z: next.seat!.z });
  });
});

describe('clicks', () => {
  it('selects a task from a chair, a bench seat, or a readout line the way a desk click does', () => {
    const tasks = live();
    const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
    const chair = poses.chair.find((pose) => pose.zoneId === 'blocked' && pose.taskId === 'TASK-EAR-402')!;
    const bench = poses.benchHit.find((pose) => pose.taskId === 'TASK-EAR-369')!;
    expect(chair).toMatchObject({ kind: 'desk', zoneId: 'blocked' });
    expect(bench).toMatchObject({ kind: 'desk', zoneId: 'blocked' });
    expect(deskSelectionForTask('TASK-EAR-402', tasks)).toEqual({ kind: 'desk', zoneId: 'blocked', taskId: 'TASK-EAR-402' });
    expect(deskSelectionForTask('TASK-EAR-406', tasks)).toEqual({ kind: 'desk', zoneId: 'dev', taskId: 'TASK-EAR-406' });
  });

  it('makes an empty chair select the room, not a desk with no task', () => {
    const tasks = [task('E0', 'blocked', { waitsOn: [{ kind: 'prod_run' }] })];
    const poses = buildOfficePoses(tasks, summarizeZones(tasks), null, null);
    const empty = poses.chair.filter((pose) => pose.zoneId === 'blocked' && pose.taskId === null);
    expect(empty).toHaveLength(CHAIR_COUNT - 1);
    expect(empty.every((pose) => pose.kind === 'room')).toBe(true);
  });

  it('lists the seats in the side list and the keyboard order instead of four desks', () => {
    const seats = officeDesks('blocked', live()).map((desk) => desk.taskId);
    expect(seats).toEqual(['TASK-EAR-391', 'TASK-EAR-368', 'TASK-EAR-309', 'TASK-EAR-402', 'TASK-EAR-369', 'TASK-EAR-349']);
    expect(officeDesks('blocked', [])).toEqual([expect.objectContaining({ taskId: null })]);
  });
});
