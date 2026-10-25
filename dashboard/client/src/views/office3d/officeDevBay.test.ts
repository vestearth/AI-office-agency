import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ZONE_COLORS, summarizeZones, zoneTone } from '../commandZones';
import { DevBayReadout } from './OfficeDevBayViews';
import { GatesBlock } from './OfficeDevopsViews';
import { SLOT_Z_OFFSET, characterSlots } from './officeCharacters';
import { buildWaitQueue, waitCard } from './officeBlocked';
import { DECOR_PLACEMENTS, devBayFixtures, placedDecorBucket } from './officeDecor';
import {
  AISLE_HALF, BAY_DESK_Z, CLAIM_GRACE_MS, COLUMNS, COLUMN_COUNT, COMPLETE_TEXT, DESK_TOP, DEVBAY, DEVBAY_COLORS, DEVBAY_DESK_SCALE,
  DEVBAY_TINTED, EMPTY_BOARD, HOLD_MAX_MS, NOTES_PER_COLUMN, NOTE_DOTS, NOTE_INSTANCE_CAP, NO_BOARD, NO_GATE_TEXT, NO_SIGNALS, NOTE_ROWS,
  SLIDE_MS, STACK_ROW, UNREADABLE_TEXT, WORKSTATION_COUNT, WORKSTATION_X, bayLines, bayOrder, bayWorkstations, boardCountsText,
  boardLayout, boardStand, columnOf, columnX, createBoardBus, devBayBoxes, devBayFootprints, dotStates, gatesCardFor, noteInstances,
  notePosition, readGates, rowY, stepBoard, tasksInBay, waitText, workstationX, type BoardState,
} from './officeDevBay';
import { BOARD_SEGMENTS } from './officeDevops';
import { buildOfficePoses, selectionAnchor } from './officeLayout';
import { LIST_READOUTS, READOUT_ROOMS } from './officeLabels';
import { DESK_Z, FLOOR_TOP, ROOM_D, ROOM_W, WALL_H, WALL_T, deskLocalX } from './officeLook';
import { BOARD_SECONDS, FRONT_OUTSET, classifyTasks, planBoardWalk, planMove, planTravelSeconds, roomFront, type CharacterPlace } from './officeMove';
import { DEVBAY_DESK_Z, deskZ } from './officeReception';
import { ROOM_LAYOUT, SCENE_DESK_LIMIT, deskSelectionForTask, desksForZone, officeDesks, type OfficeTask } from './officeSelection';
import { officeSnapshotSettled } from './officeMove';

type Item = { name: string; status: string; resolved: boolean };
const item = (name: string, resolved: boolean, status = resolved ? 'pass' : 'pending'): Item => ({ name, status, resolved });
const gatesOf = (items: Item[]): NonNullable<OfficeTask['gates']> => ({
  readable: true, total: items.length, resolved: items.filter((entry) => entry.resolved).length, passable: 0, items,
});
const UNREADABLE: NonNullable<OfficeTask['gates']> = { readable: false, total: 0, resolved: 0, passable: 0, items: [] };

function bay(taskId: string, gates?: OfficeTask['gates'], over: Partial<OfficeTask> = {}): OfficeTask {
  return { taskId, title: taskId, phase: 'assigned', status: 'running', needsReview: false, gates, ...over };
}
const verify = (resolved = false) => item('implementation_verification', resolved);
const staging = (resolved = false) => item('deploy_staging', resolved);
const prod = (resolved = false) => item('deploy_production', resolved);
const closeout = (resolved = false) => item('knowledge_closeout', resolved);

describe('gate columns', () => {
  const column = (items: Item[]) => columnOf(readGates({ gates: gatesOf(items) }));

  it('puts a task in the column of its next gate: the first unresolved one, in completion_gates order', () => {
    expect(column([verify(), staging(), prod()])).toBe(0);
    expect(column([verify(true), staging(), prod()])).toBe(1);
    expect(column([verify(true), staging(true), prod(), closeout()])).toBe(2);
    expect(column([verify(true), staging(true), prod(true), closeout()])).toBe(3);
    // The next gate is the first unresolved in the file's order, not the first by name.
    expect(column([verify(true), prod(), staging()])).toBe(2);
  });

  it('maps every gate name seen so far, and sends an unknown name to ตรวจ', () => {
    const expected: Record<string, number> = {
      implementation_verification: 0, product_contract: 0, shared_lib_publication: 0, train_prepared: 0,
      deploy_staging: 1, staging_acceptance: 1, authenticated_staging: 1,
      deploy_production: 2, production_acceptance: 2, prod_boot_acceptance: 2,
      knowledge_closeout: 3,
    };
    for (const [name, index] of Object.entries(expected)) expect(column([item(name, false)]), name).toBe(index);
    expect(column([item('mystery_gate', false)])).toBe(0);
    expect(bayLines([bay('T', gatesOf([item('mystery_gate', false)]))])[0].next).toBe('mystery_gate');
  });

  it('puts a task whose gates have all resolved in ครบ, and na counts as resolved', () => {
    expect(column([verify(true), closeout(true)])).toBe(4);
    expect(column([item('deploy_staging', true, 'na'), closeout(true)])).toBe(4);
    expect(COLUMNS[4].head).toBe('ครบ');
  });

  it('never calls a task ครบ while one gate is still open', () => {
    expect(column([verify(true), staging(true), prod(true), closeout(false)])).not.toBe(4);
  });

  it('puts a task with no gates, or gates that cannot be read, in the last column', () => {
    expect(columnOf(readGates({ gates: undefined }))).toBe(COLUMN_COUNT - 1);
    expect(columnOf(readGates({ gates: UNREADABLE }))).toBe(COLUMN_COUNT - 1);
    expect(columnOf(readGates({ gates: { readable: true, total: 0, resolved: 0, passable: 0, items: [] } }))).toBe(COLUMN_COUNT - 1);
    expect(columnOf(readGates({ gates: { ...UNREADABLE, total: 3, resolved: 3 } }))).toBe(COLUMN_COUNT - 1);
  });

  it('puts knowledge_closeout next in ปิดงาน, not in ครบ', () => {
    expect(column([verify(true), closeout(false)])).toBe(3);
    expect(COLUMNS[3].head).toBe('ปิดงาน');
  });

  it('reads counts only from an older server: ครบ when all resolved, ตรวจ otherwise, no gate names', () => {
    const counts = (resolved: number, total: number) => ({ readable: true, total, resolved, passable: 0 }) as unknown as OfficeTask['gates'];
    expect(columnOf(readGates({ gates: counts(1, 4) }))).toBe(0);
    expect(columnOf(readGates({ gates: counts(4, 4) }))).toBe(4);
    const [line] = bayLines([bay('T', counts(1, 4))]);
    expect(line.next).toBe('gates 1/4');
    expect(line.cells).toEqual([true, false, false, false]);
    expect(readGates({ gates: counts(1, 4) }).items).toEqual([]);
    // A list that does not match the count is not trusted either.
    const odd = { ...counts(1, 4), items: [verify(true)] } as OfficeTask['gates'];
    expect(readGates({ gates: odd }).state).toBe('counts');
  });

  it('only tasks in the Dev Bay phases are on the board', () => {
    const tasks = [bay('A'), bay('B', undefined, { phase: 'assigned_parallel' }), bay('C', undefined, { phase: 'in_review' }), bay('D', undefined, { phase: 'devops_needed' })];
    expect(tasksInBay(tasks).map((task) => task.taskId)).toEqual(['A', 'B']);
  });
});

describe('notes', () => {
  it('orders the notes of a column by task number, so TASK-9 comes before TASK-10 and dates change nothing', () => {
    const tasks = ['TASK-10', 'TASK-9', 'TASK-2'].map((id, index) => bay(id, gatesOf([verify()]), { updatedAt: `2026-10-0${index + 1}T00:00:00Z` }));
    const first = boardLayout(tasks).notes.map((note) => `${note.taskId}:${note.row}`);
    expect(first).toEqual(['TASK-2:0', 'TASK-9:1', 'TASK-10:2']);
    const redated = tasks.map((task, index) => ({ ...task, updatedAt: `2026-11-0${3 - index}T00:00:00Z` }));
    expect(boardLayout(redated).notes.map((note) => `${note.taskId}:${note.row}`)).toEqual(first);
  });

  it('draws five notes a column and a stack in the sixth slot for the rest', () => {
    const crowd = (count: number) => Array.from({ length: count }, (_, index) => bay(`T${String(index).padStart(2, '0')}`, gatesOf([verify()])));
    const five = boardLayout(crowd(5));
    expect(five.notes).toHaveLength(NOTES_PER_COLUMN);
    expect(five.stacks).toEqual([]);
    const six = boardLayout(crowd(6));
    expect(six.notes).toHaveLength(NOTES_PER_COLUMN);
    expect(six.stacks).toEqual([{ column: 0, extra: 1 }]);
    const nine = boardLayout(crowd(9));
    expect(nine.notes.map((note) => note.row)).toEqual([0, 1, 2, 3, 4]);
    expect(nine.stacks).toEqual([{ column: 0, extra: 4 }]);
    expect(nine.counts[0]).toBe(9);
    expect(STACK_ROW).toBe(NOTE_ROWS - 1);
    // The stack is drawn as pieces that select nothing.
    const pieces = noteInstances({ ...NO_BOARD, layout: nine }, null, 0).filter((piece) => piece.taskId === null);
    expect(pieces).toHaveLength(3);
    expect(pieces.every((piece) => Math.abs(piece.y - rowY(STACK_ROW)) < 0.02)).toBe(true);
  });

  it('counts every column in the head, exactly', () => {
    const tasks = [
      ...['A', 'B', 'C', 'D'].map((id) => bay(id, gatesOf([verify()]))),
      bay('E', gatesOf([verify(true), staging()])),
      bay('F', gatesOf([verify(true), staging(true), prod()])),
      ...['G', 'H', 'I'].map((id) => bay(id, gatesOf([verify(true), closeout(true)]))),
      bay('J'),
    ];
    const { counts } = boardLayout(tasks);
    expect(counts).toEqual([4, 1, 1, 0, 3, 1]);
    expect(boardCountsText(counts)).toBe('ตรวจ 4 · staging 1 · prod 1 · ปิดงาน 0 · ครบ 3 · ไม่มี 1');
    const markup = renderToStaticMarkup(React.createElement(DevBayReadout, { lines: bayLines(tasks), counts, selectedTaskId: null, onPick: () => undefined }));
    expect(markup).toContain('dev bay · 10');
    expect(markup).toContain('ตรวจ 4 · staging 1 · prod 1 · ปิดงาน 0 · ครบ 3 · ไม่มี 1');
  });

  it('draws one dot per gate, inked where it resolved', () => {
    expect(dotStates(readGates({ gates: gatesOf([verify(true), staging(), prod(true)]) }))).toEqual([true, false, true]);
    expect(dotStates(readGates({ gates: gatesOf([verify(), staging()]) }))).toEqual([false, false]);
    expect(dotStates(readGates({ gates: undefined }))).toEqual([]);
    expect(dotStates(readGates({ gates: UNREADABLE }))).toEqual([]);
  });

  it('scales a long gate list to six dots by floor, and fills them only when every gate has resolved', () => {
    const many = (resolved: number) => gatesOf(Array.from({ length: 8 }, (_, index) => item(`gate_${index}`, index < resolved)));
    const lit = (resolved: number) => dotStates(readGates({ gates: many(resolved) })).filter(Boolean).length;
    expect(dotStates(readGates({ gates: many(0) }))).toHaveLength(BOARD_SEGMENTS);
    expect(NOTE_DOTS).toBe(BOARD_SEGMENTS);
    expect(lit(0)).toBe(0);
    expect(lit(3)).toBe(2);
    expect(lit(7)).toBe(5);
    expect(lit(8)).toBe(6);
  });

  it('does not reorder the other notes when a gate resolves in an earlier column', () => {
    const before = [
      bay('A', gatesOf([verify()])),
      bay('B', gatesOf([verify()])),
      bay('C', gatesOf([verify()])),
      bay('D', gatesOf([verify(true), staging()])),
    ];
    const after = before.map((task) => (task.taskId === 'B' ? bay('B', gatesOf([verify(true), staging()])) : task));
    const rows = (layout: ReturnType<typeof boardLayout>, column: number) => layout.notes.filter((note) => note.column === column).map((note) => note.taskId);
    expect(rows(boardLayout(before), 0)).toEqual(['A', 'B', 'C']);
    expect(rows(boardLayout(after), 0)).toEqual(['A', 'C']);
    // B joins ตรวจ's neighbour by task number: D stays where it was relative to the others in its column.
    expect(rows(boardLayout(after), 1)).toEqual(['B', 'D']);
  });

  it('gives every instance of a full board a place in the mesh', () => {
    const tasks = Array.from({ length: 30 }, (_, index) => bay(`T${String(index).padStart(2, '0')}`, gatesOf([verify(), staging(), prod(), closeout(), item('a', false), item('b', false)]), { phase: 'assigned' }));
    const state = { ...NO_BOARD, layout: boardLayout(tasks) };
    expect(noteInstances(state, tasks[0].taskId, 0).length).toBeLessThanOrEqual(NOTE_INSTANCE_CAP);
  });

  it('marks the selected note with a halo and shows no other change', () => {
    const state = { ...NO_BOARD, layout: boardLayout([bay('A', gatesOf([verify()])), bay('B', gatesOf([verify()]))]) };
    const plain = noteInstances(state, null, 0);
    const picked = noteInstances(state, 'B', 0);
    expect(picked.length).toBe(plain.length + 1);
    expect(picked.filter((piece) => piece.color === DEVBAY_COLORS.halo)).toHaveLength(1);
  });
});

describe('the four workstations', () => {
  const tasksFor = (count: number) => Array.from({ length: count }, (_, index) => bay(`D-${index}`, undefined, { updatedAt: `2026-10-0${index + 1}T00:00:00Z`, currentAgent: 'dev' }));
  const posesFor = (tasks: OfficeTask[], rows?: Parameters<typeof buildOfficePoses>[4]) => buildOfficePoses(tasks, summarizeZones(tasks), null, null, rows);
  const devDesks = (poses: ReturnType<typeof posesFor>) => poses.desk.filter((pose) => pose.zoneId === 'dev').sort((a, b) => a.x - b.x);
  const layout = ROOM_LAYOUT.dev;

  it('draws four workstations at all times, two on each side of a centre aisle', () => {
    for (const count of [0, 1, 3, 4, 7]) {
      const desks = devDesks(posesFor(tasksFor(count)));
      expect(desks, `${count} tasks`).toHaveLength(WORKSTATION_COUNT);
      expect(desks.map((desk) => desk.x - layout.x)).toEqual([...WORKSTATION_X]);
      expect(desks.filter((desk) => desk.x < layout.x)).toHaveLength(2);
      expect(desks.filter((desk) => desk.x > layout.x)).toHaveLength(2);
      for (const desk of desks) expect(desk.z).toBeCloseTo(layout.z + deskZ('dev'));
      for (const desk of desks) expect(desk.sx).toBe(DEVBAY_DESK_SCALE);
    }
  });

  it('leaves an aisle a robot can walk with 0.2 to spare on each side', () => {
    const innerEdges = [WORKSTATION_X[1] + 0.7345 * DEVBAY_DESK_SCALE / 2, WORKSTATION_X[2] - 0.7345 * DEVBAY_DESK_SCALE / 2];
    expect(innerEdges[1]).toBeCloseTo(AISLE_HALF);
    expect(-innerEdges[0]).toBeCloseTo(AISLE_HALF);
    // A robot is 0.533 wide: it keeps 0.2 to either desk.
    expect(AISLE_HALF - 0.533 / 2).toBeGreaterThanOrEqual(0.2);
    // Every desk stays on the slab.
    for (const x of WORKSTATION_X) expect(Math.abs(x) + 0.7345 * DEVBAY_DESK_SCALE / 2).toBeLessThanOrEqual(ROOM_W / 2 - WALL_T / 2);
  });

  it('gives an empty workstation no robot and a dark monitor, and a seated one a lit monitor', () => {
    const tasks = tasksFor(2);
    const stats = summarizeZones(tasks);
    const poses = buildOfficePoses(tasks, stats, null, null);
    const screens = (list: typeof poses.screenOn) => list.filter((pose) => pose.zoneId === 'dev');
    expect(screens(poses.screenOn)).toHaveLength(2);
    expect(screens(poses.screenOff)).toHaveLength(2);
    expect(screens(poses.screenOff).every((pose) => pose.color !== zoneTone(zoneOf(), { count: 2, attention: false, active: true }))).toBe(true);
    expect(characterSlots(tasks, stats).filter((slot) => slot.zoneId === 'dev')).toHaveLength(2);
    expect(characterSlots([], summarizeZones([])).filter((slot) => slot.zoneId === 'dev')).toHaveLength(0);
    function zoneOf() { return { id: 'dev', label: 'Dev Bay', phases: [], agent: 'dev', kind: 'work' as const, left: 0, top: 0, room: { x: 0, y: 0, w: 0, h: 0 } }; }
  });

  it('keeps a seated task at its own workstation whoever arrives or leaves', () => {
    const first = bayWorkstations(['A', 'B']);
    expect(first.map((desk) => desk.taskId)).toEqual(['A', 'B', null, null]);
    const arrived = bayWorkstations(['C', 'A', 'B'], first);
    expect(arrived.map((desk) => desk.taskId)).toEqual(['A', 'B', 'C', null]);
    const left = bayWorkstations(['C', 'B'], arrived);
    expect(left.map((desk) => desk.taskId)).toEqual([null, 'B', 'C', null]);
    expect(left.map((desk) => desk.localX)).toEqual([...WORKSTATION_X]);
    // A leaving robot keeps its workstation until it is gone: a newcomer takes the free one or waits.
    const crowded = bayWorkstations(['A', 'B', 'C', 'D'], null);
    const held = bayWorkstations(['E', 'B', 'C', 'D'], crowded, ['A']);
    expect(held.map((desk) => desk.taskId)).toEqual(['A', 'B', 'C', 'D']);
    expect(held.some((desk) => desk.taskId === 'E')).toBe(false);
    expect(bayWorkstations(['E', 'B', 'C', 'D'], held).map((desk) => desk.taskId)).toEqual(['E', 'B', 'C', 'D']);
  });

  it('keeps every other room on the shared desk row', () => {
    const debug = Array.from({ length: 3 }, (_, index) => ({ ...bay(`G-${index}`), phase: 'debugging' as const }));
    const desks = posesFor(debug).desk.filter((pose) => pose.zoneId === 'debug').sort((a, b) => a.x - b.x);
    desks.forEach((desk, index) => expect(desk.x - ROOM_LAYOUT.debug.x).toBeCloseTo(deskLocalX(index, 3)));
    expect(desks).toHaveLength(3);
    expect(desks.every((desk) => desk.sx === 1.15 && desk.z === ROOM_LAYOUT.debug.z + DESK_Z)).toBe(true);
    expect(workstationX(0)).toBe(WORKSTATION_X[0]);
    expect(DEVBAY_DESK_Z).toBe(BAY_DESK_Z);
  });

  it('puts chairs, seats and selection anchors on the front row', () => {
    const tasks = tasksFor(3);
    const stats = summarizeZones(tasks);
    const poses = posesFor(tasks);
    for (const chair of poses.chair.filter((pose) => pose.zoneId === 'dev')) expect(chair.z).toBeCloseTo(layout.z + BAY_DESK_Z + 0.46);
    const slots = characterSlots(tasks, stats).filter((slot) => slot.zoneId === 'dev');
    expect(slots).toHaveLength(3);
    for (const slot of slots) expect(slot.z).toBeCloseTo(layout.z + BAY_DESK_Z + SLOT_Z_OFFSET);
    expect(slots.map((slot) => slot.x - layout.x).sort((a, b) => a - b)).toEqual([...WORKSTATION_X.slice(0, 3)]);
    const anchor = selectionAnchor({ kind: 'desk', zoneId: 'dev', taskId: slots[0].taskId }, tasks, stats);
    expect(anchor?.[0]).toBeCloseTo(slots[0].x);
    expect(anchor?.[2]).toBeCloseTo(layout.z + BAY_DESK_Z);
  });

  it('puts a lamp on every workstation from flat pieces on the rack mesh: no lamp mesh, no glow, no new draw call', () => {
    const poses = posesFor(tasksFor(1));
    // The shared lamp meshes are absent from a room without an Inbox lamp, so using them would add two draw calls.
    expect(poses.lamp.filter((pose) => pose.zoneId === 'dev')).toEqual([]);
    const pieces = DEVBAY_TINTED.filter((piece) => piece.part === 'lamp');
    expect(pieces).toHaveLength(WORKSTATION_COUNT * 3);
    expect(pieces.every((piece) => piece.y - piece.h / 2 >= DESK_TOP - 1e-9)).toBe(true);
    // The merged decor's shade bucket glows with DevOps: nothing of Dev Bay may join it.
    expect(Object.keys(devBayFixtures()).filter((name) => !['wood', 'metal', 'fabric'].includes(name))).toEqual([]);
    expect(DECOR_PLACEMENTS.filter((entry) => entry.zoneId === 'dev').map((entry) => entry.file).filter((file) => /lamp/i.test(file))).toEqual([]);
    expect(placedDecorBucket('dev', 'shade')).toBe('shade');
  });
});

describe('who gets a workstation', () => {
  const at = (taskId: string, updatedAt: string, over: Partial<OfficeTask> = {}) => bay(taskId, undefined, { updatedAt, ...over });

  it('seats urgent tasks first, then the newest updatedAt, then the task id', () => {
    const tasks = [
      at('A', '2026-10-01T00:00:00Z'),
      at('B', '2026-10-05T00:00:00Z'),
      at('C', '2026-10-05T00:00:00Z'),
      at('D', '2026-10-03T00:00:00Z', { needsReview: true }),
      at('E', '2026-09-01T00:00:00Z', { status: 'failed' }),
    ];
    expect(bayOrder(tasks).map((task) => task.taskId)).toEqual(['D', 'E', 'B', 'C', 'A']);
    expect(desksForZone('dev', tasks).map((desk) => desk.taskId)).toEqual(['D', 'E', 'B', 'C', 'A']);
  });

  it('keeps every other room seating its oldest first', () => {
    const tasks = [
      at('A', '2026-10-01T00:00:00Z', { phase: 'debugging' }),
      at('B', '2026-10-05T00:00:00Z', { phase: 'debugging' }),
      at('C', '2026-10-03T00:00:00Z', { phase: 'debugging' }),
    ];
    expect(desksForZone('debug', tasks).map((desk) => desk.taskId)).toEqual(['A', 'C', 'B']);
    const devops = tasks.map((task) => ({ ...task, phase: 'devops_needed' as const }));
    expect(desksForZone('devops', devops).map((desk) => desk.taskId)).toEqual(['A', 'C', 'B']);
  });

  it('lists the occupied workstations in the side list, or one empty desk', () => {
    const tasks = [at('A', '2026-10-01T00:00:00Z'), at('B', '2026-10-02T00:00:00Z')];
    const row = bayWorkstations(['B', 'A']);
    expect(officeDesks('dev', tasks, summarizeZones(tasks), { dev: row }).map((desk) => desk.taskId)).toEqual(['B', 'A']);
    expect(officeDesks('dev', [], summarizeZones([]), { dev: bayWorkstations([]) }).map((desk) => desk.taskId)).toEqual([null]);
  });

  it('keeps the task whose gate write bumped its updated_at seated, so its robot walks to the board and does not leave', () => {
    const older = Array.from({ length: 6 }, (_, index) => at(`T${index}`, `2026-10-0${index + 1}T00:00:00Z`));
    const seatedBefore = desksForZone('dev', older).slice(0, SCENE_DESK_LIMIT).map((desk) => desk.taskId);
    expect(seatedBefore).toEqual(['T5', 'T4', 'T3', 'T2']);
    // T2 is the oldest seated task. Its gate resolves, which sets updated_at to the newest.
    const bumped = older.map((task) => (task.taskId === 'T2' ? { ...task, updatedAt: '2026-10-09T00:00:00Z' } : task));
    const seatedAfter = desksForZone('dev', bumped).slice(0, SCENE_DESK_LIMIT).map((desk) => desk.taskId);
    expect(seatedAfter).toContain('T2');
    expect(new Set(seatedAfter)).toEqual(new Set(seatedBefore));
    const places = classifyTasks(bumped);
    const place = places.find((entry) => entry.taskId === 'T2')!;
    expect(place.drawn).toBe(true);
    expect(planBoardWalk(place, 0)).not.toBeNull();
    // Under the shared rule the bumped task would have been the first to leave.
    const oldestFirst = [...bumped].sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || '')).slice(0, SCENE_DESK_LIMIT).map((task) => task.taskId);
    expect(oldestFirst).not.toContain('T2');
  });
});

describe('the readout', () => {
  const render = (tasks: OfficeTask[], selected: string | null = null) => renderToStaticMarkup(React.createElement(DevBayReadout, {
    lines: bayLines(tasks), counts: boardLayout(tasks).counts, selectedTaskId: selected, onPick: () => undefined,
  }));

  it('is a list readout of the room, placed and kept up like the other lists', () => {
    expect(READOUT_ROOMS).toContain('dev');
    expect(LIST_READOUTS).toContain('dev');
    expect(render([bay('A')])).toContain('data-readout="dev"');
  });

  it('writes one line per task: id, role as written, one cell per gate and the next gate', () => {
    const tasks = [
      bay('TASK-EAR-384', gatesOf([item('product_contract', true), item('implementation_verification', true), item('authenticated_staging', false)]), { currentAgent: 'dev-2' }),
      bay('TASK-VS-041', gatesOf([verify(true), closeout(true)]), { currentAgent: 'devops' }),
      bay('TASK-VS-004', undefined, { currentAgent: 'dev' }),
      bay('TASK-X-1', UNREADABLE),
    ];
    const lines = bayLines(tasks);
    expect(lines.map((line) => line.taskId)).toEqual(['TASK-EAR-384', 'TASK-VS-004', 'TASK-VS-041', 'TASK-X-1']);
    expect(lines[0]).toMatchObject({ role: 'dev-2', cells: [true, true, false], next: 'authenticated_staging', column: 1 });
    expect(lines[1]).toMatchObject({ role: 'dev', cells: [], next: NO_GATE_TEXT, column: 5 });
    expect(lines[2]).toMatchObject({ role: 'devops', next: COMPLETE_TEXT, column: 4 });
    expect(lines[3]).toMatchObject({ role: null, next: UNREADABLE_TEXT, column: 5 });
    const markup = render(tasks);
    expect(markup.match(/data-task=/g)).toHaveLength(4);
    expect(markup).toContain('dev-2');
    expect(markup).toContain('authenticated_staging');
    expect(markup).toContain('gate ครบ · รอย้ายออก');
    expect(markup).toContain('ไม่มี gate');
    expect(markup).toContain('gates unreadable');
    expect((markup.match(/data-lit="1"/g) ?? [])).toHaveLength(4);
  });

  it('lists every task even when the board shows a stack', () => {
    const tasks = Array.from({ length: 9 }, (_, index) => bay(`T${index}`, gatesOf([verify()])));
    expect(boardLayout(tasks).notes).toHaveLength(5);
    expect(render(tasks).match(/data-task=/g)).toHaveLength(9);
  });

  it('names what a task waits on in a second line, only when waitsOn is set', () => {
    expect(waitText({ waitsOn: [{ kind: 'qa' }], actionKind: null })).toBe('รอ QA');
    expect(waitText({ waitsOn: [{ kind: 'operator_approval' }, { kind: 'prod_run' }], actionKind: null })).toBe('รอ Earth อนุมัติ, รัน prod');
    expect(waitText({ waitsOn: [{ kind: 'operator_decision' }, { kind: 'operator_approval' }], actionKind: null })).toBe('รอ Earth ตัดสินใจ, Earth อนุมัติ');
    expect(waitText({ waitsOn: [], actionKind: null })).toBeNull();
    const markup = render([bay('A', undefined, { waitsOn: [{ kind: 'qa' }] }), bay('B')]);
    expect(markup.match(/class="why"/g)).toHaveLength(1);
    expect(markup).toContain('รอ QA');
  });

  it('highlights the selected line', () => {
    expect(render([bay('A'), bay('B')], 'B')).toMatch(/data-on="1"[^>]*data-task="B"|data-task="B"[^>]*data-on="1"/);
  });

  it('shows no readout text of its own for a room with no task: the scene hides it', () => {
    expect(bayLines([])).toEqual([]);
  });
});

describe('clicks', () => {
  it('selects the task from a note, a readout line or a desk: all land on the same desk selection', () => {
    const tasks = [bay('A', gatesOf([verify()]))];
    expect(deskSelectionForTask('A', tasks)).toEqual({ kind: 'desk', zoneId: 'dev', taskId: 'A' });
    const picked = noteInstances({ ...NO_BOARD, layout: boardLayout(tasks) }, null, 0).filter((piece) => piece.taskId);
    expect(new Set(picked.map((piece) => piece.taskId))).toEqual(new Set(['A']));
    const deskPoses = buildOfficePoses(tasks, summarizeZones(tasks), null, null).desk.filter((pose) => pose.zoneId === 'dev' && pose.taskId);
    expect(deskPoses.map((pose) => pose.taskId)).toEqual(['A']);
  });

  it('lists the gates in order with their state on the card, after gates x/y, with Open in Monitor', () => {
    const task = bay('TASK-VS-041', gatesOf([verify(true), item('deploy_staging', true, 'na'), item('staging_acceptance', false), closeout(false)]));
    const card = gatesCardFor(task)!;
    expect(card.text).toBe('gates 2/4');
    expect(card.items.map((entry) => entry.name)).toEqual(['implementation_verification', 'deploy_staging', 'staging_acceptance', 'knowledge_closeout']);
    const markup = renderToStaticMarkup(React.createElement(GatesBlock, { taskId: task.taskId, text: card.text, items: card.items }));
    expect(markup).toContain('gates 2/4');
    expect(markup.indexOf('gates 2/4')).toBeLessThan(markup.indexOf('implementation_verification'));
    expect(markup.indexOf('implementation_verification')).toBeLessThan(markup.indexOf('deploy_staging'));
    expect(markup.indexOf('deploy_staging')).toBeLessThan(markup.indexOf('staging_acceptance'));
    expect(markup.indexOf('staging_acceptance')).toBeLessThan(markup.indexOf('knowledge_closeout'));
    expect(markup).toContain('data-state="pass"');
    expect(markup).toContain('data-state="na"');
    expect(markup).toContain('data-state="pending"');
    expect(markup).toContain('Open in Monitor');
  });

  it('keeps the old gates card without a list, and hides Open in Monitor when another block carries it', () => {
    const markup = renderToStaticMarkup(React.createElement(GatesBlock, { taskId: 'X', text: 'gates 0/2', showMonitor: false }));
    expect(markup).toContain('gates 0/2');
    expect(markup).not.toContain('Open in Monitor');
    expect(markup).not.toContain('o3d-gate-list');
  });

  it('gives a gates card to every Dev Bay task with gates and to every open release train, once', () => {
    const plain = bay('A', gatesOf([verify()]));
    expect(gatesCardFor(plain)?.text).toBe('gates 0/1');
    expect(gatesCardFor(bay('B'))).toBeNull();
    expect(gatesCardFor(bay('C', UNREADABLE))?.text).toBe('gates unreadable');
    const train = { ...bay('TASK-EAR-406', gatesOf([prod(), item('production_acceptance', false)])), isReleaseTrain: true };
    expect(gatesCardFor(train)?.text).toBe('gates 0/2');
    expect(gatesCardFor(train)?.items).toHaveLength(2);
    const elsewhere = { ...bay('TASK-EAR-402', gatesOf([verify(true), staging(), prod(), closeout()]), { phase: 'blocked', status: 'blocked' }), isReleaseTrain: true };
    expect(gatesCardFor(elsewhere)?.text).toBe('gates 1/4');
    expect(gatesCardFor({ ...bay('D', gatesOf([verify()]), { phase: 'in_review' }) })).toBeNull();
  });

  it('adds the waiting block for a task that waits on Earth', () => {
    const waiting = bay('TASK-VS-004', undefined, { waitsOn: [{ kind: 'operator_decision' }, { kind: 'operator_approval' }] });
    const card = waitCard(waiting, buildWaitQueue([waiting], Date.parse('2026-10-25T00:00:00Z')));
    expect(card?.heading).toBe('Waiting on you');
  });
});

describe('the moment a gate resolves', () => {
  const T0 = 1_000;
  const before = () => [bay('A', gatesOf([verify(), staging()])), bay('B', gatesOf([verify(), staging()]))];
  const resolved = () => [bay('A', gatesOf([verify(true), staging()])), bay('B', gatesOf([verify(), staging()]))];
  const run = (state: BoardState, tasks: OfficeTask[], now: number, snap = false, signals = NO_SIGNALS) => stepBoard(state, tasks, { snap, now }, signals);
  const slot = (state: BoardState, taskId: string) => state.layout.notes.find((note) => note.taskId === taskId)!;

  it('shows the board as it is on first load: no request, no slide', () => {
    const step = run(NO_BOARD, resolved(), T0, true);
    expect(step.requests).toEqual([]);
    expect(step.state.holds.size).toBe(0);
    expect(step.state.slides.size).toBe(0);
    expect(step.state.layout.notes).toHaveLength(2);
    // Even without a snap the first data has nothing to compare with.
    expect(run(NO_BOARD, resolved(), T0).requests).toEqual([]);
  });

  it('asks the task\'s robot to walk, and keeps the note in its old column with its old dots until it arrives', () => {
    const first = run(NO_BOARD, before(), T0).state;
    const step = run(first, resolved(), T0 + 100);
    expect(step.requests).toEqual([{ taskId: 'A', column: 1, fromColumn: 0 }]);
    expect(step.state.holds.has('A')).toBe(true);
    expect(slot(step.state, 'A')).toMatchObject({ column: 0, dots: [false, false] });
    expect(step.state.slides.size).toBe(0);
  });

  it('moves the note to its new column when the robot arrives, sliding once', () => {
    const first = run(NO_BOARD, before(), T0).state;
    const held = run(first, resolved(), T0 + 100).state;
    const claimed = run(held, resolved(), T0 + 150, false, { ...NO_SIGNALS, claimed: new Set(['A']) });
    expect(claimed.state.holds.get('A')?.claimed).toBe(true);
    const waiting = run(claimed.state, resolved(), T0 + 4000);
    expect(waiting.state.holds.has('A')).toBe(true);
    expect(slot(waiting.state, 'A').column).toBe(0);
    const arrived = run(waiting.state, resolved(), T0 + 4100, false, { ...NO_SIGNALS, arrived: new Set(['A']) });
    expect(arrived.requests).toEqual([]);
    expect(arrived.state.holds.size).toBe(0);
    expect(slot(arrived.state, 'A')).toMatchObject({ column: 1, row: 0, dots: [true, false] });
    const slide = arrived.state.slides.get('A')!;
    expect(slide.at).toBe(T0 + 4100);
    // The note starts at its old slot and ends at the new one.
    const start = notePosition(arrived.state, 'A', slot(arrived.state, 'A'), T0 + 4100);
    expect(start.x).toBeCloseTo(columnX(0));
    const mid = notePosition(arrived.state, 'A', slot(arrived.state, 'A'), T0 + 4100 + SLIDE_MS / 2);
    expect(mid.x).toBeGreaterThan(columnX(0));
    expect(mid.x).toBeLessThan(columnX(1));
    const end = notePosition(arrived.state, 'A', slot(arrived.state, 'A'), T0 + 4100 + SLIDE_MS);
    expect(end.x).toBeCloseTo(columnX(1));
    // Once it has arrived nothing asks for another walk.
    expect(run(arrived.state, resolved(), T0 + 5000).requests).toEqual([]);
  });

  it('only inks the dot when the column did not change, and does not slide', () => {
    const three = (a: boolean, b: boolean) => [bay('A', gatesOf([verify(a), verify2(b), staging()]))];
    function verify2(resolvedGate: boolean) { return item('product_contract', resolvedGate); }
    const first = run(NO_BOARD, three(false, false), T0).state;
    const step = run(first, three(true, false), T0 + 100);
    expect(step.requests).toEqual([{ taskId: 'A', column: 0, fromColumn: 0 }]);
    expect(slot(step.state, 'A').dots).toEqual([false, false, false]);
    const arrived = run(step.state, three(true, false), T0 + 800, false, { ...NO_SIGNALS, arrived: new Set(['A']) });
    expect(slot(arrived.state, 'A')).toMatchObject({ column: 0, row: 0, dots: [true, false, false] });
    expect(arrived.state.slides.size).toBe(0);
  });

  it('moves the note itself when no robot claims it, or the robot cannot go', () => {
    const first = run(NO_BOARD, before(), T0).state;
    const held = run(first, resolved(), T0 + 100).state;
    const early = run(held, resolved(), T0 + 100 + CLAIM_GRACE_MS - 10);
    expect(early.state.holds.has('A')).toBe(true);
    const late = run(held, resolved(), T0 + 100 + CLAIM_GRACE_MS + 10);
    expect(late.state.holds.size).toBe(0);
    expect(slot(late.state, 'A')).toMatchObject({ column: 1, dots: [true, false] });
    expect(late.state.slides.has('A')).toBe(true);
    const rejected = run(held, resolved(), T0 + 150, false, { ...NO_SIGNALS, rejected: new Set(['A']) });
    expect(rejected.state.holds.size).toBe(0);
    expect(slot(rejected.state, 'A').column).toBe(1);
    expect(rejected.state.slides.has('A')).toBe(true);
  });

  it('never freezes a note on a robot that does not come', () => {
    const first = run(NO_BOARD, before(), T0).state;
    const held = run(first, resolved(), T0 + 100).state;
    const claimed = run(held, resolved(), T0 + 120, false, { ...NO_SIGNALS, claimed: new Set(['A']) }).state;
    expect(run(claimed, resolved(), T0 + 100 + HOLD_MAX_MS - 10).state.holds.has('A')).toBe(true);
    expect(run(claimed, resolved(), T0 + 100 + HOLD_MAX_MS + 10).state.holds.size).toBe(0);
  });

  it('does not walk or slide on a snap: hidden tab, stream gap, reduced motion, or the first load', () => {
    const first = run(NO_BOARD, before(), T0).state;
    const step = run(first, resolved(), T0 + 100, true);
    expect(step.requests).toEqual([]);
    expect(step.state.holds.size).toBe(0);
    expect(step.state.slides.size).toBe(0);
    expect(slot(step.state, 'A')).toMatchObject({ column: 1, dots: [true, false] });
    // Coming back to the tab later does not replay it.
    expect(run(step.state, resolved(), T0 + 5000).requests).toEqual([]);
    // A snap also drops a note that was waiting for a robot.
    const waiting = run(run(NO_BOARD, before(), T0).state, resolved(), T0 + 100).state;
    expect(run(waiting, resolved(), T0 + 200, true).state.holds.size).toBe(0);
  });

  it('waits for one walk per task: a second gate resolving meanwhile asks for nothing more', () => {
    const three = (count: number) => [bay('A', gatesOf([verify(count > 0), item('product_contract', count > 1), staging()]))];
    const first = run(NO_BOARD, three(0), T0).state;
    const held = run(first, three(1), T0 + 100);
    expect(held.requests).toHaveLength(1);
    const again = run(held.state, three(2), T0 + 200);
    expect(again.requests).toEqual([]);
    const arrived = run(again.state, three(2), T0 + 900, false, { ...NO_SIGNALS, arrived: new Set(['A']) });
    expect(slot(arrived.state, 'A').dots).toEqual([true, true, false]);
  });

  it('plays nothing for a task that is new to the room, a gate that did not resolve, or a task that left', () => {
    const first = run(NO_BOARD, before(), T0).state;
    expect(run(first, [...before(), bay('C', gatesOf([verify(true)]))], T0 + 100).requests).toEqual([]);
    expect(run(first, [bay('A', gatesOf([verify(), staging()])), bay('B', gatesOf([verify(), staging()]))], T0 + 100).requests).toEqual([]);
    const held = run(first, resolved(), T0 + 100).state;
    const left = run(held, [{ ...resolved()[0], phase: 'in_review' }, resolved()[1]], T0 + 150);
    expect(left.state.holds.size).toBe(0);
    expect(left.state.layout.notes.map((note) => note.taskId)).toEqual(['B']);
  });

  it('slides the notes that shift up when a neighbour leaves a column', () => {
    const three = [bay('A', gatesOf([verify()])), bay('B', gatesOf([verify()])), bay('C', gatesOf([verify()]))];
    const first = run(NO_BOARD, three, T0).state;
    const step = run(first, three.filter((task) => task.taskId !== 'A'), T0 + 100);
    expect([...step.state.slides.keys()].sort()).toEqual(['B', 'C']);
    expect(run(first, three.filter((task) => task.taskId !== 'A'), T0 + 100, true).state.slides.size).toBe(0);
  });

  it('keeps the board and its instances identical for the same data', () => {
    const tasks = before();
    const one = noteInstances(run(NO_BOARD, tasks, T0).state, null, T0);
    const two = noteInstances(run(run(NO_BOARD, tasks, T0).state, tasks, T0 + 500).state, null, T0 + 500);
    expect(two).toEqual(one);
  });

  it('has an empty board for a room with no task', () => {
    expect(run(NO_BOARD, [], T0).state.layout).toEqual(EMPTY_BOARD);
    expect(createBoardBus().requests.size).toBe(0);
  });
});

describe('the walk to the board', () => {
  const layout = ROOM_LAYOUT.dev;
  const tasks = Array.from({ length: 4 }, (_, index) => bay(`W${index}`, gatesOf([verify(), staging()]), { updatedAt: `2026-10-0${4 - index}T00:00:00Z` }));
  const places = classifyTasks(tasks).filter((place) => place.zoneId === 'dev' && place.drawn);
  const hits = (part: { x: number; z: number; w: number; d: number }, x: number, z: number, pad: number) =>
    Math.abs(x - part.x) < part.w / 2 + pad && Math.abs(z - part.z) < part.d / 2 + pad;

  it('goes out of the workstation, up the centre aisle, along the board to the column and home the same way', () => {
    expect(places).toHaveLength(4);
    for (const place of places) {
      for (const column of [0, 2, 5]) {
        const plan = planBoardWalk(place, column)!;
        expect(plan.action).toBe('board');
        expect(plan.gait).toBe('walk');
        expect(plan.celebrate).toBe(false);
        expect(plan.vanish).toBe(false);
        expect(plan.points[0]).toMatchObject({ x: place.seat!.x, z: place.seat!.z, role: 'seat' });
        expect(plan.points.at(-1)).toMatchObject({ x: place.seat!.x, z: place.seat!.z, role: 'seat' });
        const at = plan.points.filter((point) => point.role === 'board');
        expect(at).toHaveLength(1);
        expect(at[0].x).toBeCloseTo(layout.x + boardStand(column).x);
        expect(at[0].z).toBeCloseTo(layout.z + DEVBAY.stand.z);
        // Up the aisle on the way there and back.
        expect(plan.points.filter((point) => Math.abs(point.x - layout.x) < 1e-9 && point.role === 'inside')).toHaveLength(2);
        expect(planTravelSeconds(plan)).toBeGreaterThan(BOARD_SECONDS);
      }
    }
  });

  it('is only for a task that has a workstation: no seat, no walk, and never another task\'s robot', () => {
    const crowd = Array.from({ length: 6 }, (_, index) => bay(`C${index}`, gatesOf([verify()]), { updatedAt: `2026-10-0${index + 1}T00:00:00Z` }));
    const all = classifyTasks(crowd);
    const undrawn = all.filter((place) => !place.drawn);
    expect(undrawn).toHaveLength(2);
    for (const place of undrawn) expect(planBoardWalk(place, 0)).toBeNull();
    const elsewhere = classifyTasks([bay('Z', gatesOf([verify()]), { phase: 'in_review' })])[0];
    expect(planBoardWalk(elsewhere, 0)).toBeNull();
  });

  it('keeps every walk clear of the furniture, the desks and the other robots', () => {
    const furniture = devBayFootprints();
    const desks = WORKSTATION_X.map((x) => ({ part: 'desk', x, z: BAY_DESK_Z, w: 0.7345 * DEVBAY_DESK_SCALE, d: 0.392 * DEVBAY_DESK_SCALE }));
    const seats = places.map((place) => ({ part: 'robot', x: place.seat!.x - layout.x, z: place.seat!.z - layout.z, w: 0.34, d: 0.34 }));
    const WALK_CLEARANCE = 0.2;
    // A robot is 0.533 wide; the aisle keeps 0.2 either side of that.
    const BODY = 0.533 / 2;
    for (const place of places) {
      for (const column of [0, 1, 2, 3, 4, 5]) {
        const plan = planBoardWalk(place, column)!;
        const points = plan.points.map((point) => ({ x: point.x - layout.x, z: point.z - layout.z }));
        for (let leg = 0; leg + 1 < points.length; leg += 1) {
          for (let step = 0; step <= 40; step += 1) {
            const t = step / 40;
            const x = points[leg].x + (points[leg + 1].x - points[leg].x) * t;
            const z = points[leg].z + (points[leg + 1].z - points[leg].z) * t;
            for (const piece of furniture) expect(hits(piece, x, z, WALK_CLEARANCE), `${piece.part} on a walk to column ${column}`).toBe(false);
            for (const desk of desks) {
              // The first and the last leg are the robot leaving and entering its own workstation; every other leg
              // keeps a body's half width and 0.2 away from every desk.
              if (leg === 0 || leg === points.length - 2) continue;
              expect(hits(desk, x, z, BODY + WALK_CLEARANCE), `desk on a walk to column ${column}, leg ${leg}`).toBe(false);
            }
            for (const robot of seats) {
              if (Math.abs(robot.x - (place.seat!.x - layout.x)) < 1e-6) continue;
              expect(hits(robot, x, z, WALK_CLEARANCE), `a seated robot on a walk to column ${column}`).toBe(false);
            }
          }
        }
      }
    }
    expect(FRONT_OUTSET).toBeGreaterThan(0);
    expect(roomFront('dev').z).toBeGreaterThan(layout.z + ROOM_D / 2);
  });
});

describe('the room', () => {
  const layout = ROOM_LAYOUT.dev;

  it('is an office: meeting table with chairs, bookcases, a printer cabinet, plants, a window, a cooler and a filing cabinet', () => {
    const files = DECOR_PLACEMENTS.filter((entry) => entry.zoneId === 'dev').map((entry) => entry.file);
    expect(files.filter((file) => file === 'table')).toHaveLength(1);
    expect(files.filter((file) => file === 'chair')).toHaveLength(4);
    expect(files.filter((file) => file.startsWith('bookcase'))).toHaveLength(2);
    expect(files).toContain('cabinetBedDrawer');
    // The old back-wall bookcases and boxes are gone: the whiteboard has that wall.
    expect(files).not.toContain('cardboardBoxClosed');
    const parts = new Set(devBayBoxes().map((piece) => piece.part));
    for (const part of ['board', 'tray', 'rug', 'runner', 'filing', 'printer', 'cooler', 'window', 'blind']) expect(parts.has(part), part).toBe(true);
    expect(DEVBAY.plants.length).toBeGreaterThanOrEqual(2);
    expect(buildOfficePoses([], summarizeZones([]), null, null).plant.filter((plant) => plant.zoneId === 'dev')).toHaveLength(DEVBAY.plants.length);
  });

  it('joins only the three plain decor buckets: wood, metal and fabric, so nothing glows', () => {
    expect(devBayBoxes().every((piece) => ['wood', 'metal', 'fabric'].includes(piece.bucket))).toBe(true);
  });

  it('keeps its own colors muted and out of the status palette', () => {
    const status = new Set(Object.values(ZONE_COLORS).map((color) => color.toLowerCase()));
    const colors = [...DEVBAY_TINTED.map((piece) => piece.color), ...Object.values(DEVBAY_COLORS).flat()].filter((value): value is string => typeof value === 'string');
    for (const color of colors) expect(status.has(color.toLowerCase()), color).toBe(false);
    for (const color of colors) {
      const channels = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
      // Under the bloom threshold: the brightest channel of any piece stays dim.
      expect(Math.max(...channels), color).toBeLessThanOrEqual(0xd0);
    }
  });

  it('is a white board, with the notes, the dots and the selection halo still readable on it', () => {
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => linear(parseInt(color.slice(at, at + 2), 16)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
      return (high + 0.05) / (low + 0.05);
    };
    const { face, paper, paperStack, inkOn, inkOff, halo } = DEVBAY_COLORS;
    // The room light is green and strong, so only lightness separates the pieces; the bloom cap keeps the face off pure white.
    expect(luminance(face), face).toBeGreaterThanOrEqual(0.35);
    expect(contrast(paper, face), paper).toBeGreaterThanOrEqual(1.45);
    expect(contrast(paperStack, face), paperStack).toBeGreaterThanOrEqual(1.45);
    expect(contrast(halo, face), halo).toBeGreaterThanOrEqual(3);
    expect(contrast(inkOn, paper), inkOn).toBeGreaterThanOrEqual(3);
    expect(contrast(inkOff, paper), inkOff).toBeGreaterThanOrEqual(1.4);
  });

  it('keeps every piece inside the room, under the wall top and past x 1.2 only where a desk is', () => {
    const wall = WALL_H;
    for (const piece of devBayBoxes()) {
      expect(Math.abs(piece.x) + piece.w / 2, piece.part).toBeLessThanOrEqual(ROOM_W / 2 + 1e-9);
      expect(piece.z - piece.d / 2, piece.part).toBeGreaterThanOrEqual(-ROOM_D / 2 - 0.05);
      expect(piece.z + piece.d / 2, piece.part).toBeLessThanOrEqual(ROOM_D / 2);
      expect(piece.y + piece.h / 2, piece.part).toBeLessThanOrEqual(wall);
    }
    for (const piece of devBayFootprints()) {
      expect(piece.x + piece.w / 2, piece.part).toBeLessThanOrEqual(1.2);
      expect(piece.h, piece.part).toBeLessThanOrEqual(wall);
    }
    expect(layout).toBeTruthy();
  });

  it('keeps the old Dev Bay decor out and the desk limit as it was', () => {
    expect(SCENE_DESK_LIMIT).toBe(4);
    expect(WORKSTATION_COUNT).toBe(SCENE_DESK_LIMIT);
    expect(officeSnapshotSettled('x')).toBe(true);
  });

  it('keeps its merged pieces in the world position of the room', () => {
    const fixtures = devBayFixtures();
    for (const list of Object.values(fixtures)) {
      for (const geometry of list ?? []) {
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        expect(bounds.min.x).toBeGreaterThanOrEqual(layout.x - ROOM_W / 2 - 0.01);
        expect(bounds.max.x).toBeLessThanOrEqual(layout.x + ROOM_W / 2 + 0.01);
        expect(bounds.min.z).toBeGreaterThanOrEqual(layout.z - ROOM_D / 2 - 0.1);
        expect(bounds.max.z).toBeLessThanOrEqual(layout.z + ROOM_D / 2 + 0.01);
      }
    }
  });
});

describe('the board from the default camera', () => {
  /** The default camera sits at (+24, +20, +20.5) from its aim: a sight line leaves the board along this direction. */
  const TOWARD_CAMERA = { x: 24, y: 20, z: 20.5 };
  interface Aabb { part: string; min: [number, number, number]; max: [number, number, number] }
  const around = (part: string, x: number, z: number, w: number, d: number, h: number, y = 0): Aabb =>
    ({ part, min: [x - w / 2, y, z - d / 2], max: [x + w / 2, y + h, z + d / 2] });

  /** Everything between the board and the camera: the furniture with its real heights, the desks, monitors and the +x wall. */
  function occluders(): Aabb[] {
    const desk = WORKSTATION_X.flatMap((x) => [
      around('desk', x, BAY_DESK_Z, 0.7345 * DEVBAY_DESK_SCALE, 0.392 * DEVBAY_DESK_SCALE, DESK_TOP),
      around('monitor', x, BAY_DESK_Z - 0.22, 0.393, 0.104, 0.294, 0.34 * DEVBAY_DESK_SCALE),
      around('lamp', x + DEVBAY.lamp.dx, BAY_DESK_Z + DEVBAY.lamp.dz, 0.152 * DEVBAY.lamp.scale, 0.176 * DEVBAY.lamp.scale, 0.314 * DEVBAY.lamp.scale, DESK_TOP),
      around('chair', x, BAY_DESK_Z + 0.46, 0.335, 0.314, 0.608),
    ]);
    const wall = around('wall', ROOM_W / 2, 0, WALL_T, ROOM_D, WALL_H);
    return [...devBayFootprints().map((piece) => around(piece.part, piece.x, piece.z, piece.w, piece.d, piece.h)), ...desk, wall];
  }

  /** Slab test: does the ray from `from` along TOWARD_CAMERA enter the box? */
  function hitsBox(box: Aabb, from: [number, number, number]): boolean {
    const dir = [TOWARD_CAMERA.x, TOWARD_CAMERA.y, TOWARD_CAMERA.z];
    let near = 0;
    let far = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      const a = (box.min[axis] - from[axis]) / dir[axis];
      const b = (box.max[axis] - from[axis]) / dir[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near < far;
  }

  it('shows all 36 slots of the board, with nothing between a slot and the camera', () => {
    const blockers = occluders();
    const { note } = DEVBAY;
    for (let column = 0; column < COLUMN_COUNT; column += 1) {
      for (let row = 0; row < NOTE_ROWS; row += 1) {
        // Sample the front face of the slot: its centre and its four corners, nudged off the surface.
        for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const from: [number, number, number] = [columnX(column) + (dx * note.w) / 2 * 0.9, rowY(row) + (dy * note.h) / 2 * 0.9, note.z + note.d / 2 + 0.004];
          for (const blocker of blockers) {
            expect(hitsBox(blocker, from), `${blocker.part} hides column ${column + 1}, row ${row + 1}`).toBe(false);
          }
        }
      }
    }
  });

  it('shows every seated robot\'s head over the +x wall, at least as well as the shared desk row does', () => {
    // A seated robot's head spans about 0.5 to 0.72 above the floor slab, 0.3 wide, at the seat (desk z + 0.5).
    const heads = (x: number): [number, number, number][] => [
      [x, 0.72, BAY_DESK_Z + 0.5], [x - 0.15, 0.72, BAY_DESK_Z + 0.5], [x + 0.15, 0.72, BAY_DESK_Z + 0.5],
      [x, 0.72, BAY_DESK_Z + 0.35], [x, 0.72, BAY_DESK_Z + 0.65],
    ];
    const wall = occluders().find((piece) => piece.part === 'wall')!;
    const others = (x: number) => occluders().filter((piece) => piece.part !== 'wall' && !(piece.part === 'chair' && Math.abs(piece.min[0] + 0.335 / 2 - x) < 0.01));
    for (const x of WORKSTATION_X) {
      for (const from of heads(x)) {
        expect(hitsBox(wall, from), `the +x wall hides the head of the robot at x ${x.toFixed(3)}`).toBe(false);
        for (const blocker of others(x)) expect(hitsBox(blocker, from), `${blocker.part} hides the head of the robot at x ${x.toFixed(3)}`).toBe(false);
      }
    }
    // The shared row's outer desk (x 1.425) is the reference: its head clears the wall.
    expect(hitsBox(wall, [1.425, 0.72, BAY_DESK_Z + 0.5])).toBe(false);
    expect(hitsBox(wall, [1.9, 0.72, BAY_DESK_Z + 0.5])).toBe(true);
  });

  it('would notice a piece that stands in front of the board', () => {
    const slot: [number, number, number] = [columnX(5), rowY(5), DEVBAY.note.z + 0.01];
    expect(hitsBox(around('cabinet', columnX(5) + 0.3, -1.3, 0.4, 0.3, 0.9), slot)).toBe(true);
    expect(hitsBox(around('cabinet', columnX(5) - 0.4, -1.3, 0.4, 0.3, 0.9), slot)).toBe(false);
    expect(hitsBox(around('shelf', 1.0, -1.2, 0.4, 0.25, 1.0), [columnX(5), rowY(4), DEVBAY.note.z + 0.01])).toBe(true);
  });

  it('keeps every slot of the board on the board, under the wall top, in six even columns', () => {
    const { board, note } = DEVBAY;
    for (let column = 0; column < COLUMN_COUNT; column += 1) {
      expect(columnX(column) - note.w / 2).toBeGreaterThanOrEqual(board.x - board.w / 2);
      expect(columnX(column) + note.w / 2).toBeLessThanOrEqual(board.x + board.w / 2);
      expect(columnX(column) + note.w / 2).toBeLessThanOrEqual(1.2);
      if (column > 0) expect(columnX(column) - columnX(column - 1)).toBeCloseTo(DEVBAY.columnPitch);
    }
    for (let row = 0; row < NOTE_ROWS; row += 1) {
      expect(rowY(row) - note.h / 2).toBeGreaterThanOrEqual(board.y - board.h / 2);
      expect(rowY(row) + note.h / 2).toBeLessThanOrEqual(DEVBAY.header.y - DEVBAY.header.h / 2);
      if (row > 0) expect(rowY(row - 1) - rowY(row)).toBeGreaterThanOrEqual(note.h);
    }
    expect(board.y + board.h / 2).toBeLessThanOrEqual(WALL_H);
  });
});
