import { describe, expect, it } from 'vitest';
import type { DecisionAction } from '../../../../shared/types';
import { inBangkok } from '../../testing/inBangkok';
import { DECOR_PLACEMENTS } from './officeDecor';
import { ROOM_D, ROOM_W } from './officeLook';
import {
  BOX_SLIDE_SECONDS,
  REVIEW,
  REVIEW_LINE_CAP,
  REVIEW_SPOT_CAP,
  reviewAgeDays,
  reviewBoard,
  reviewClickIntent,
  reviewOrder,
  reviewPanelStatus,
  reviewReadout,
  reviewStanding,
  stepBoxes,
  type BoxState,
} from './officeReview';
import type { OfficeTask } from './officeSelection';

const DAY = 86_400_000;
const NOW = new Date('2026-10-24T12:00:00Z');
const ago = (days: number, extraHours = 0) => new Date(NOW.getTime() - days * DAY - extraHours * 3_600_000).toISOString();

const waiting = (taskId: string, days: number, over: Partial<OfficeTask> = {}): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'in_review',
  status: 'waiting_review',
  needsReview: true,
  actionKind: 'awaiting_review',
  statusUpdatedAt: ago(days),
  ...over,
});

const decided = (taskId: string, decision: DecisionAction, over: Partial<OfficeTask> = {}): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'in_review',
  status: 'waiting_review',
  needsReview: false,
  actionKind: 'decision_pending',
  decisionPending: true,
  latestDecision: { decision, actor: 'earth', decidedAt: ago(0, 1) },
  statusUpdatedAt: ago(2),
  ...over,
});

const other = (taskId: string, actionKind: NonNullable<OfficeTask['actionKind']>): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'review',
  status: 'waiting_review',
  needsReview: false,
  actionKind,
  statusUpdatedAt: ago(1),
});

describe('review age', () => {
  it('floors whole days since the last status change, the formula the server uses for idle', () => {
    expect(reviewAgeDays(ago(9), NOW)).toBe(9);
    expect(reviewAgeDays(ago(1, 23), NOW)).toBe(1);
    expect(reviewAgeDays(ago(0, 5), NOW)).toBe(0);
    expect(reviewAgeDays(null, NOW)).toBeNull();
    expect(reviewAgeDays('not a date', NOW)).toBeNull();
    expect(reviewAgeDays(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe(0);
  });
});

describe('a date-only status change in Bangkok', () => {
  inBangkok();

  it('ages from local midnight, as the server counts idle from midnight in the office time zone', () => {
    // 03:00 local on the 24th: from UTC midnight the 16th was 7.8 days ago, from local midnight 8.
    expect(reviewAgeDays('2026-10-16', new Date(2026, 9, 24, 3))).toBe(8);
    expect(reviewAgeDays('2026-10-16', new Date(2026, 9, 24, 23))).toBe(8);
  });

  it('takes its place in line from the same local midnight, so the gate box is never the younger one', () => {
    // 01:00 local on the 24th: the 22nd began 2 days ago, the stamp 1.9 days ago. Read as UTC
    // midnight, the 22nd would queue behind the stamp.
    const now = new Date(2026, 9, 24, 1);
    const board = reviewBoard([
      waiting('STAMP', 0, { statusUpdatedAt: new Date(now.getTime() - 1.9 * DAY).toISOString() }),
      waiting('DATE', 0, { statusUpdatedAt: '2026-10-22' }),
    ], now);
    expect(board.waiting.map((entry) => [entry.task.taskId, entry.ageDays])).toEqual([['DATE', 2], ['STAMP', 1]]);
  });
});

describe('waiting order', () => {
  it('puts the longest wait at the gate, ties by task id, and a task with no time last', () => {
    const board = reviewBoard([
      waiting('TASK-B', 1),
      waiting('TASK-EAR-390', 9),
      waiting('TASK-NONE', 0, { statusUpdatedAt: undefined }),
      waiting('TASK-A', 1, { statusUpdatedAt: ago(1) }),
    ], NOW);
    expect(board.waiting.map((entry) => entry.task.taskId)).toEqual(['TASK-EAR-390', 'TASK-A', 'TASK-B', 'TASK-NONE']);
    expect(board.waiting[0].spot?.kind).toBe('line');
    expect(board.waiting[0].spot?.index).toBe(0);
  });

  it('seats the oldest box nearest the gate', () => {
    const board = reviewBoard([waiting('OLD', 5), waiting('NEW', 1), waiting('MID', 3)], NOW);
    const xs = board.waiting.map((entry) => entry.spot!.box!.x);
    expect(xs[0]).toBeGreaterThan(xs[1]);
    expect(xs[1]).toBeGreaterThan(xs[2]);
    expect(xs[0]).toBeLessThan(REVIEW.gate.x);
  });

  it('orders the side list the same way so arrow keys reach every box on the line', () => {
    const mixed = [other('O1', 'completion_held'), decided('D1', 'approve'), waiting('W2', 1), waiting('W1', 4)];
    expect(reviewOrder(mixed).map((task) => task.taskId)).toEqual(['W1', 'W2', 'D1', 'O1']);
  });
});

describe('overdue', () => {
  it('tags only the tasks the server marked idle and reads the threshold from the task', () => {
    const board = reviewBoard([
      waiting('LATE', 9, { idle: { days: 9, thresholdDays: 7 } }),
      waiting('FRESH', 2),
      waiting('LATE-14', 20, { idle: { days: 20, thresholdDays: 14 } }),
    ], NOW);
    const by = (id: string) => board.waiting.find((entry) => entry.task.taskId === id)!;
    expect(by('LATE').overdue).toEqual({ thresholdDays: 7 });
    expect(by('FRESH').overdue).toBeNull();
    expect(by('LATE-14').overdue).toEqual({ thresholdDays: 14 });
    expect(board.tags.map((tag) => tag.taskId).sort()).toEqual(['LATE', 'LATE-14']);
    const readout = reviewReadout(board, NOW);
    expect(readout.waiting.find((line) => line.taskId === 'LATE')?.badge).toBe('over 7d');
    expect(readout.waiting.find((line) => line.taskId === 'LATE-14')?.badge).toBe('over 14d');
    expect(readout.waiting.find((line) => line.taskId === 'FRESH')?.badge).toBeNull();
  });

  it('hangs the tag above its own box', () => {
    const board = reviewBoard([waiting('LATE', 9, { idle: { days: 9, thresholdDays: 7 } })], NOW);
    const box = board.waiting[0].spot!.box!;
    expect(board.tags[0]).toMatchObject({ taskId: 'LATE', x: box.x, z: box.z });
    expect(board.tags[0].y).toBeGreaterThan(box.y);
  });
});

describe('the line', () => {
  it('holds four waiting boxes, each with a robot; a fifth is listed but has none', () => {
    expect(REVIEW_LINE_CAP).toBe(4);
    const five = ['A', 'B', 'C', 'D', 'E'].map((id, index) => waiting(id, 9 - index));
    const board = reviewBoard(five, NOW);
    expect(board.waiting).toHaveLength(5);
    expect(board.waiting.filter((entry) => entry.spot).map((entry) => entry.task.taskId)).toEqual(['A', 'B', 'C', 'D']);
    expect(board.waiting[4].spot).toBeNull();
    expect(board.waitingCount).toBe(5);
    expect(reviewStanding(five).map((slot) => slot.taskId)).toEqual(['A', 'B', 'C', 'D']);
    expect(reviewReadout(board, NOW).waiting.map((line) => line.taskId)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('closes up: when the gate box leaves, the others move one place toward the gate', () => {
    const before = reviewBoard([waiting('A', 9), waiting('B', 5), waiting('C', 3)], NOW);
    const after = reviewBoard([waiting('B', 5), waiting('C', 3)], NOW);
    const at = (board: ReturnType<typeof reviewBoard>, id: string) => board.waiting.find((entry) => entry.task.taskId === id)!.spot!;
    expect(at(after, 'B').index).toBe(0);
    expect(at(after, 'B').box!.x).toBeGreaterThan(at(before, 'B').box!.x);
    expect(at(after, 'C').box!.x).toBeGreaterThan(at(before, 'C').box!.x);
    expect(at(after, 'B').robot.x).toBeGreaterThan(at(before, 'B').robot.x);
  });

  it('stands each robot in front of its own box', () => {
    const board = reviewBoard([waiting('A', 9), waiting('B', 5)], NOW);
    for (const entry of board.waiting) {
      const spot = entry.spot!;
      expect(Math.abs(spot.robot.x - spot.box!.x)).toBeLessThanOrEqual(0.3);
      expect(spot.robot.z).toBeGreaterThan(spot.box!.z);
    }
  });
});

describe('decided boxes', () => {
  const spots = (decision: DecisionAction) => reviewBoard([decided('D', decision)], NOW).decided[0].spot!;

  it('leaves the line at once and goes to the place for its decision', () => {
    const board = reviewBoard([waiting('W', 3), decided('D', 'approve')], NOW);
    expect(board.waiting.map((entry) => entry.task.taskId)).toEqual(['W']);
    expect(spots('approve').kind).toBe('approve');
    expect(spots('request_changes').kind).toBe('changes');
    expect(spots('escalate').kind).toBe('shelf');
    expect(spots('reject').kind).toBe('bin');
  });

  it('puts an approved box through the gate, past the gate x', () => {
    expect(spots('approve').box!.x).toBeGreaterThan(REVIEW.gate.x);
    expect(spots('approve').box!.z).toBe(REVIEW.belt.z);
  });

  it('puts the return rack at the start end of the line, off the line itself', () => {
    const rack = spots('request_changes').box!;
    expect(rack.x).toBeLessThan(Math.min(...REVIEW.lineX));
    expect(rack.z).toBeGreaterThan(REVIEW.belt.z + 0.3);
  });

  it('takes no more than two boxes per spot; a third is listed without a box or robot', () => {
    expect(REVIEW_SPOT_CAP).toBe(2);
    const board = reviewBoard([
      decided('R1', 'reject', { latestDecision: { decision: 'reject', actor: 'e', decidedAt: ago(0, 3) } }),
      decided('R2', 'reject', { latestDecision: { decision: 'reject', actor: 'e', decidedAt: ago(0, 2) } }),
      decided('R3', 'reject', { latestDecision: { decision: 'reject', actor: 'e', decidedAt: ago(0, 1) } }),
      decided('A1', 'approve'),
    ], NOW);
    const bin = board.decided.filter((entry) => entry.decision === 'reject');
    expect(bin.map((entry) => entry.task.taskId)).toEqual(['R1', 'R2', 'R3']);
    expect(bin.filter((entry) => entry.spot).map((entry) => entry.task.taskId)).toEqual(['R1', 'R2']);
    expect(bin[2].spot).toBeNull();
    expect(board.decided.find((entry) => entry.task.taskId === 'A1')?.spot?.kind).toBe('approve');
  });

  it('does not count in the chip, and shows decided · <decision> in the readout', () => {
    const board = reviewBoard([waiting('W', 3), decided('D', 'escalate')], NOW);
    expect(board.waitingCount).toBe(1);
    const readout = reviewReadout(board, NOW);
    expect(readout.header).toBe('awaiting review · 1');
    expect(readout.decided.map((line) => line.text)).toEqual(['D · decided · escalate']);
    expect(readout.decided[0].clickable).toBe(true);
  });

  it('keeps the held approval past the gate and reads gates x/y', () => {
    const held = decided('HELD', 'approve', { gates: { readable: true, total: 2, resolved: 1, passable: 0 } });
    const clear = decided('CLEAR', 'approve', { gates: { readable: true, total: 1, resolved: 1, passable: 1 } });
    const board = reviewBoard([held, clear], NOW);
    const readout = reviewReadout(board, NOW);
    expect(board.decided.find((entry) => entry.task.taskId === 'HELD')?.spot?.kind).toBe('approve');
    expect(readout.decided.find((line) => line.taskId === 'HELD')?.text).toBe('HELD · decided · approve · gates 1/2');
    expect(readout.decided.find((line) => line.taskId === 'CLEAR')?.text).toBe('CLEAR · decided · approve');
  });

  it('a decision recorded but no latestDecision cannot place a box', () => {
    const board = reviewBoard([decided('ODD', 'approve', { latestDecision: undefined })], NOW);
    expect(board.decided).toHaveLength(0);
    expect(board.others.map((entry) => entry.task.taskId)).toEqual(['ODD']);
  });
});

describe('other kinds', () => {
  const board = reviewBoard([
    waiting('W', 3),
    other('X1', 'completion_held'),
    other('X2', 'authorization_required'),
    other('X3', 'gates_unreadable'),
    other('X4', 'workflow_exception'),
    other('X5', 'artifact_drift'),
  ], NOW);

  it('gives no box, a side spot for up to two, and lists them under not waiting for a decision', () => {
    expect(board.others).toHaveLength(5);
    expect(board.others.every((entry) => entry.spot?.box == null)).toBe(true);
    expect(board.others.filter((entry) => entry.spot).map((entry) => entry.task.taskId)).toEqual(['X1', 'X2']);
    expect(board.waitingCount).toBe(1);
    const readout = reviewReadout(board, NOW);
    expect(readout.othersHeading).toBe('not waiting for a decision');
    expect(readout.others.map((line) => line.text)).toEqual([
      'X1 · Completion held',
      'X2 · Authorization required',
      'X3 · Gate unreadable',
      'X4 · Workflow exceptions',
      'X5 · Artifact drift',
    ]);
  });

  it('opens the card with Open in Monitor, not the panel', () => {
    for (const entry of board.others) {
      expect(reviewClickIntent(entry.task, 'box')).toBe('card');
      expect(reviewClickIntent(entry.task, 'readout')).toBe('card');
    }
  });

  it('has no heading and no footer hint when there is nothing to show', () => {
    const empty = reviewReadout(reviewBoard([], NOW), NOW);
    expect(empty.header).toBe('awaiting review · 0');
    expect(empty.othersHeading).toBeNull();
    expect(empty.footer).toBeNull();
  });
});

describe('clicks', () => {
  it('a box or a readout line opens the panel for waiting and decided tasks, decided ones again', () => {
    expect(reviewClickIntent(waiting('W', 2), 'box')).toBe('panel');
    expect(reviewClickIntent(waiting('W', 2), 'readout')).toBe('panel');
    expect(reviewClickIntent(decided('D', 'reject'), 'box')).toBe('panel');
    expect(reviewClickIntent(decided('D', 'reject'), 'readout')).toBe('panel');
  });

  it('the selection card button opens it, and the side list never does', () => {
    expect(reviewClickIntent(waiting('W', 2), 'card')).toBe('panel');
    expect(reviewClickIntent(waiting('W', 2), 'list')).toBe('select');
    expect(reviewClickIntent(decided('D', 'reject'), 'list')).toBe('select');
    expect(reviewClickIntent(other('X', 'completion_held'), 'list')).toBe('select');
  });

  it('labels the panel with the Command vocabulary and amber while a decision is due', () => {
    expect(reviewPanelStatus(waiting('W', 2))).toEqual({ label: 'In review', color: '#f59e0b' });
    expect(reviewPanelStatus(decided('D', 'approve')).color).not.toBe('#f59e0b');
  });
});

describe('standing places', () => {
  it('stands robots on the line, at the decided spots and at the side, none for a box without a spot', () => {
    const tasks = [
      waiting('W1', 5), waiting('W2', 3), decided('D', 'approve'), other('X', 'completion_held'),
    ];
    const slots = reviewStanding(tasks);
    expect(slots.map((slot) => slot.taskId)).toEqual(['W1', 'W2', 'D', 'X']);
    expect(slots.every((slot) => Number.isFinite(slot.x) && Number.isFinite(slot.z))).toBe(true);
  });

  it('keeps every spot inside the room and every pair of robots apart', () => {
    const everyone: OfficeTask[] = [
      ...['A', 'B', 'C', 'D'].map((id, index) => waiting(id, 9 - index)),
      ...(['approve', 'request_changes', 'escalate', 'reject'] as const).flatMap((decision) => [
        decided(`${decision}-1`, decision, { latestDecision: { decision, actor: 'e', decidedAt: ago(0, 3) } }),
        decided(`${decision}-2`, decision, { latestDecision: { decision, actor: 'e', decidedAt: ago(0, 2) } }),
      ]),
      other('X1', 'completion_held'),
      other('X2', 'workflow_exception'),
    ];
    const slots = reviewStanding(everyone);
    expect(slots).toHaveLength(14);
    for (const slot of slots) {
      expect(Math.abs(slot.x)).toBeLessThanOrEqual(ROOM_W / 2 - 0.27);
      expect(slot.z).toBeGreaterThan(-ROOM_D / 2);
      expect(slot.z).toBeLessThan(ROOM_D / 2);
    }
    for (let a = 0; a < slots.length; a += 1) {
      for (let b = a + 1; b < slots.length; b += 1) {
        expect(Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z)).toBeGreaterThanOrEqual(0.53);
      }
    }
    const board = reviewBoard(everyone, NOW);
    const boxes = [...board.waiting, ...board.decided].flatMap((entry) => (entry.spot?.box ? [entry.spot.box] : []));
    expect(boxes).toHaveLength(12);
    for (const box of boxes) {
      expect(Math.abs(box.x)).toBeLessThanOrEqual(ROOM_W / 2 - 0.15);
      expect(box.z).toBeGreaterThan(-ROOM_D / 2);
    }
  });
});

describe('visibility from the default camera', () => {
  // The default camera looks from +x +z at about 32 degrees down (OfficeScene: position 24, 20, 20.5 off the aim).
  const lateral = (x: number, z: number) => 0.648 * x - 0.76 * z;
  const depth = (x: number, z: number) => 0.76 * x + 0.65 * z;
  const RISE = 0.62;
  const ROBOT_HALF = 0.36;
  const ROBOT_TOP = 0.92;
  const BOX_MID = 0.14;

  const full: OfficeTask[] = [
    ...['A', 'B', 'C', 'D'].map((id, index) => waiting(id, 9 - index)),
    ...(['approve', 'request_changes', 'escalate', 'reject'] as const).flatMap((decision) => [
      decided(`${decision}-1`, decision, { latestDecision: { decision, actor: 'e', decidedAt: ago(0, 3) } }),
      decided(`${decision}-2`, decision, { latestDecision: { decision, actor: 'e', decidedAt: ago(0, 2) } }),
    ]),
    other('X1', 'completion_held'),
    other('X2', 'workflow_exception'),
  ];

  it('never hides a box behind a robot, with every spot taken', () => {
    const board = reviewBoard(full, NOW);
    const entries = [...board.waiting, ...board.decided, ...board.others].filter((entry) => entry.spot);
    const boxes = entries.flatMap((entry) => (entry.spot!.box ? [{ id: entry.task.taskId, ...entry.spot!.box }] : []));
    const hidden: string[] = [];
    for (const box of boxes) {
      for (const entry of entries) {
        const robot = entry.spot!.robot;
        const ahead = depth(robot.x, robot.z) - depth(box.x, box.z);
        if (ahead <= 0 || Math.abs(lateral(robot.x, robot.z) - lateral(box.x, box.z)) >= ROBOT_HALF) continue;
        if (box.y + BOX_MID + RISE * ahead < ROBOT_TOP) hidden.push(`${box.id} behind ${entry.task.taskId}`);
      }
    }
    expect(hidden).toEqual([]);
  });

  it('stands the waiting boxes on a belt at waist height so a robot beside the line does not cover them', () => {
    const board = reviewBoard(full, NOW);
    const heights = board.waiting.flatMap((entry) => (entry.spot?.box ? [entry.spot.box.y] : []));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.45);
  });
});

describe('the room', () => {
  it('no longer carries the decor table and chairs', () => {
    expect(DECOR_PLACEMENTS.filter((item) => item.zoneId === 'review')).toEqual([]);
  });

  it('adds only simple shapes for the conveyor, gate, rack, shelf and bin', () => {
    expect(REVIEW.props.length).toBeGreaterThan(8);
    for (const prop of REVIEW.props) {
      expect(['wood', 'metal', 'fabric']).toContain(prop.bucket);
      expect(Math.abs(prop.x) + prop.w / 2).toBeLessThanOrEqual(ROOM_W / 2);
      expect(prop.z - prop.d / 2).toBeGreaterThanOrEqual(-ROOM_D / 2);
      expect(prop.z + prop.d / 2).toBeLessThanOrEqual(ROOM_D / 2);
    }
  });
});

describe('box motion', () => {
  const target = (taskId: string, x: number, lift = 0): { taskId: string; x: number; y: number; z: number; rotY: number; lift: number } => ({
    taskId, x, y: 0.16, z: -1.38, rotY: 0, lift,
  });
  const settle = (targets: ReturnType<typeof target>[], states = new Map<string, BoxState>()) =>
    stepBoxes(states, targets, { snap: true, dt: 0 });

  it('places boxes where they belong with no sliding on first load, snap or reduced motion', () => {
    const first = stepBoxes(new Map(), [target('A', 0.5), target('B', -0.1)], { snap: false, dt: 0.016 });
    expect(first.get('A')).toMatchObject({ x: 0.5, y: 0.16, sliding: false });
    const moved = stepBoxes(first, [target('A', 1.35), target('B', 0.5)], { snap: true, dt: 0.016 });
    expect(moved.get('A')).toMatchObject({ x: 1.35, sliding: false });
    expect(moved.get('B')).toMatchObject({ x: 0.5, sliding: false });
  });

  it('slides a box to its new place in about a second', () => {
    const start = settle([target('A', 0.5)]);
    const mid = stepBoxes(start, [target('A', 1.35)], { snap: false, dt: BOX_SLIDE_SECONDS / 2 });
    const a = mid.get('A')!;
    expect(a.sliding).toBe(true);
    expect(a.x).toBeGreaterThan(0.5);
    expect(a.x).toBeLessThan(1.35);
    const done = stepBoxes(mid, [target('A', 1.35)], { snap: false, dt: BOX_SLIDE_SECONDS });
    expect(done.get('A')).toMatchObject({ x: 1.35, sliding: false });
    expect(BOX_SLIDE_SECONDS).toBeGreaterThanOrEqual(0.6);
    expect(BOX_SLIDE_SECONDS).toBeLessThanOrEqual(1.2);
  });

  it('lifts a box on its way to the rack, shelf or bin and drops boxes that left', () => {
    const start = settle([target('A', 0.5), target('B', -0.1)]);
    const mid = stepBoxes(start, [target('A', 1.0, 0.2)], { snap: false, dt: BOX_SLIDE_SECONDS / 2 });
    expect(mid.get('A')!.y).toBeGreaterThan(0.16);
    expect(mid.has('B')).toBe(false);
  });

  it('a new box does not fly in', () => {
    const start = settle([target('A', 0.5)]);
    const next = stepBoxes(start, [target('A', 0.5), target('N', -1.3)], { snap: false, dt: 0.016 });
    expect(next.get('N')).toMatchObject({ x: -1.3, sliding: false });
  });
});
