import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZONE_BY_ID, summarizeZones, zoneTone } from '../commandZones';
import { DevopsReadout, GatesBlock } from './OfficeDevopsViews';
import { WaitBlock } from './OfficeWaitViews';
import { EscalationBlock } from './OfficeEscalationViews';
import { SLOT_Z_OFFSET } from './officeCharacters';
import { BAR_COLOR, buildWaitQueue, waitCard } from './officeBlocked';
import { DECOR_PLACEMENTS, devopsFixtures, placedDecorBucket } from './officeDecor';
import {
  BOARD_ROWS, BOARD_SEGMENTS, DEVOPS, DEVOPS_COLORS, DEVOPS_HANDOFF_TEXT, DEVOPS_TINTED, NO_LIGHTS, SEGMENT_BLINK_MS,
  blinkActive, boardRows, devopsBoxes, devopsCard, devopsFootprints, devopsLines, gatesCard, litSegments, segmentKey,
  segmentSlot, stepLights, trainRows, trainText, visibleLit,
} from './officeDevops';
import { buildOfficePoses, segmentPoses, selectionAnchor } from './officeLayout';
import { LIST_READOUTS, READOUT_ROOMS, visibleReadouts } from './officeLabels';
import { DESK_Z, FLOOR_TOP, SCENE, ROOM_D, ROOM_W, WALL_H, deskLocalX } from './officeLook';
import { loungeLightAllowed } from './officeLounge';
import { FRONT_OUTSET, classifyTasks, planMove, type CharacterPlace } from './officeMove';
import { deskZ } from './officeReception';
import { characterSlots } from './officeCharacters';
import { ROOM_LAYOUT, SCENE_DESK_LIMIT, deskSelectionForTask, type OfficeTask } from './officeSelection';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function train(taskId: string, gates: OfficeTask['gates'], over: Partial<OfficeTask> = {}): OfficeTask {
  return { taskId, title: taskId, phase: 'assigned', status: 'running', needsReview: false, isReleaseTrain: true, gates, ...over };
}
const gates = (resolved: number, total: number) => ({ readable: true, total, resolved, passable: resolved });
/** What the server sends when it cannot read the gates (`unreadableGateView()`): total and resolved are zero. */
const UNREADABLE = { readable: false, total: 0, resolved: 0, passable: 0 };

function devops(taskId: string, days: number, transition: Partial<NonNullable<OfficeTask['lastTransition']>> | null = {}, over: Partial<OfficeTask> = {}): OfficeTask {
  return {
    taskId,
    title: taskId,
    phase: 'devops_needed',
    status: 'running',
    needsReview: false,
    statusUpdatedAt: ago(days),
    lastTransition: transition === null ? null : { agent: 'dev', phase: 'in_review -> devops_needed', reason: 'tag the build and run the migration', at: ago(days), ...transition },
    ...over,
  };
}

const posesFor = (tasks: OfficeTask[], rows?: Parameters<typeof buildOfficePoses>[4]) =>
  buildOfficePoses(tasks, summarizeZones(tasks), null, null, rows);
const dev = (poses: ReturnType<typeof posesFor>['rackBody']) => poses.filter((pose) => pose.zoneId === 'devops');

describe('release board rows', () => {
  it('lists only open release trains, by task id', () => {
    const rows = trainRows([
      train('TASK-EAR-406', gates(0, 2)),
      train('TASK-EAR-402', gates(1, 4), { phase: 'blocked' }),
      { taskId: 'TASK-OTHER-1', title: 'x', phase: 'assigned', status: 'running', needsReview: false, isReleaseTrain: false, gates: gates(1, 3) },
      train('TASK-DONE-1', gates(2, 2), { phase: 'done' }),
      train('TASK-ABORTED-1', gates(0, 2), { phase: 'aborted' }),
      { taskId: 'TASK-NOFLAG', title: 'x', phase: 'blocked', status: 'blocked', needsReview: false, gates: gates(1, 3) },
    ]);
    expect(rows.map((row) => row.taskId)).toEqual(['TASK-EAR-402', 'TASK-EAR-406']);
  });

  it('orders by task number, so TASK-9 comes before TASK-10', () => {
    expect(trainRows([train('TASK-EAR-10', gates(0, 1)), train('TASK-EAR-9', gates(0, 1))]).map((row) => row.taskId)).toEqual(['TASK-EAR-9', 'TASK-EAR-10']);
  });

  it('never moves a row when one of its gates resolves, whatever the dates say', () => {
    const before = [
      train('TASK-EAR-402', gates(1, 4), { statusUpdatedAt: '2026-10-01' }),
      train('TASK-EAR-406', gates(0, 2), { statusUpdatedAt: '2026-10-20' }),
    ];
    const after = [
      train('TASK-EAR-402', gates(2, 4), { statusUpdatedAt: '2026-10-24' }),
      train('TASK-EAR-406', gates(0, 2), { statusUpdatedAt: '2026-10-20' }),
    ];
    expect(trainRows(before).map((row) => row.taskId)).toEqual(trainRows(after).map((row) => row.taskId));
  });

  it('draws at most four rows and six slots per row, and lists every train in the readout', () => {
    const many = Array.from({ length: 6 }, (_, index) => train(`TASK-T-${index}`, gates(1, 9)));
    expect(trainRows(many)).toHaveLength(6);
    expect(boardRows(trainRows(many))).toHaveLength(BOARD_ROWS);
    expect(trainRows(many).every((row) => row.slots <= BOARD_SEGMENTS)).toBe(true);
    const poses = dev(posesFor(many).rackBody).filter((pose) => pose.color === DEVOPS_COLORS.segmentDark);
    expect(poses).toHaveLength(BOARD_ROWS * BOARD_SEGMENTS);
  });

  it('lights one segment per resolved gate, scales a long train by floor, and fills a row only when all gates resolved', () => {
    expect(litSegments(0, 4)).toBe(0);
    expect(litSegments(1, 4)).toBe(1);
    expect(litSegments(4, 4)).toBe(4);
    expect(litSegments(6, 6)).toBe(6);
    expect(litSegments(3, 7)).toBe(Math.floor((6 * 3) / 7));
    expect(litSegments(6, 7)).toBe(5);
    expect(litSegments(7, 7)).toBe(6);
    expect(litSegments(11, 12)).toBe(5);
    expect(litSegments(12, 12)).toBe(6);
    for (let total = 7; total <= 40; total += 1) {
      for (let resolved = 0; resolved < total; resolved += 1) {
        expect(litSegments(resolved, total), `${resolved}/${total}`).toBeLessThan(BOARD_SEGMENTS);
      }
    }
    expect(litSegments(9, 4)).toBe(4);
    expect(litSegments(-2, 4)).toBe(0);
  });

  it('keeps an unreadable or missing gate set dark and says so, without guessing', () => {
    const [unreadable] = trainRows([train('TASK-U', UNREADABLE)]);
    expect(unreadable.lit).toBe(0);
    expect(trainText(unreadable)).toBe('gates unreadable');
    const [none] = trainRows([train('TASK-N', undefined)]);
    expect(none.lit).toBe(0);
    expect(trainText(none)).toBe('no gates');
    expect(trainText(trainRows([train('TASK-Z', gates(0, 0))])[0])).toBe('no gates');
    expect(trainText(trainRows([train('TASK-EAR-402', gates(1, 4))])[0])).toBe('gates 1/4');
    expect(gatesCard(train('TASK-U', UNREADABLE))?.text).toBe('gates unreadable');
  });

  it('shows no card gates line for a task that is not an open release train', () => {
    expect(gatesCard({ taskId: 'X', title: 'x', phase: 'assigned', status: 'running', needsReview: false, gates: gates(1, 3) })).toBeNull();
    expect(gatesCard(train('X', gates(2, 2), { phase: 'done' }))).toBeNull();
  });
});

describe('release board poses', () => {
  it('draws one dark slot per gate on the rack mesh and lights resolved ones on the bar mesh', () => {
    const tasks = [train('TASK-EAR-402', gates(1, 4), { phase: 'blocked', status: 'blocked' }), train('TASK-EAR-406', gates(0, 2))];
    const poses = posesFor(tasks);
    const dark = dev(poses.rackBody).filter((pose) => pose.color === DEVOPS_COLORS.segmentDark);
    expect(dark).toHaveLength(4 + 2);
    const lit = segmentPoses([segmentKey('TASK-EAR-402', 0)], tasks);
    expect(lit).toHaveLength(1);
    expect(lit[0].color).toBe(BAR_COLOR);
    const slot = segmentSlot(0, 0, true);
    const layout = ROOM_LAYOUT.devops;
    expect(lit[0].x).toBeCloseTo(layout.x + slot.x);
    expect(lit[0].y).toBeCloseTo(FLOOR_TOP + slot.y);
    expect(lit[0].zoneId).toBe('devops');
  });

  it('puts the second train on the second row and drops a train that is not on the board', () => {
    const tasks = [train('TASK-A', gates(1, 2)), train('TASK-B', gates(1, 2))];
    const [a, b] = segmentPoses([segmentKey('TASK-A', 0), segmentKey('TASK-B', 0)], tasks);
    expect(a.y).toBeGreaterThan(b.y);
    expect(segmentPoses([segmentKey('TASK-GONE', 0)], tasks)).toHaveLength(0);
    expect(segmentPoses([segmentKey('TASK-A', BOARD_SEGMENTS)], tasks)).toHaveLength(0);
  });

  it('keeps every slot inside the board backing', () => {
    const { board } = DEVOPS;
    for (let row = 0; row < BOARD_ROWS; row += 1) {
      for (let col = 0; col < BOARD_SEGMENTS; col += 1) {
        for (const lit of [false, true]) {
          const slot = segmentSlot(row, col, lit);
          expect(Math.abs(slot.x - board.x) + slot.w / 2).toBeLessThanOrEqual(board.w / 2);
          expect(Math.abs(slot.y - board.y) + slot.h / 2).toBeLessThanOrEqual(board.h / 2);
        }
      }
    }
  });
});

describe('release board blink', () => {
  const rows = (lit: number) => [{ taskId: 'T', lit }];
  const first = stepLights(NO_LIGHTS, rows(1), { snap: false, now: 0 });

  it('shows the board as it is on first load, with no blink', () => {
    expect(first.blinking.size).toBe(0);
    expect(visibleLit(first, 0)).toEqual([segmentKey('T', 0)]);
    expect(blinkActive(first, 0)).toBe(false);
  });

  it('blinks a newly resolved gate once: lit, out, lit again', () => {
    const next = stepLights(first, rows(2), { snap: false, now: 1000 });
    expect(blinkActive(next, 1000)).toBe(true);
    const seen = [0, SEGMENT_BLINK_MS * 0.5, SEGMENT_BLINK_MS * 1.5, SEGMENT_BLINK_MS * 2.5].map((dt) => visibleLit(next, 1000 + dt).includes(segmentKey('T', 1)));
    expect(seen).toEqual([true, true, false, true]);
    // The segment that was already lit never goes out.
    expect(visibleLit(next, 1000 + SEGMENT_BLINK_MS * 1.5)).toContain(segmentKey('T', 0));
    expect(blinkActive(next, 1000 + SEGMENT_BLINK_MS * 2)).toBe(false);
  });

  it('does not blink when snapping (hidden tab, stream gap, reduced motion)', () => {
    const next = stepLights(first, rows(3), { snap: true, now: 1000 });
    expect(next.blinking.size).toBe(0);
    expect(visibleLit(next, 1000 + SEGMENT_BLINK_MS * 1.5)).toHaveLength(3);
  });

  it('does not blink a train that is new to the board, or one that lost a gate', () => {
    const fresh = stepLights(first, [...rows(1), { taskId: 'NEW', lit: 3 }], { snap: false, now: 1000 });
    expect(fresh.blinking.size).toBe(0);
    const down = stepLights(first, rows(0), { snap: false, now: 1000 });
    expect(visibleLit(down, 1000)).toHaveLength(0);
    expect(down.blinking.size).toBe(0);
  });

  it('keeps a running blink going while nothing else changes, and drops it when the train leaves', () => {
    const next = stepLights(first, rows(2), { snap: false, now: 1000 });
    const again = stepLights(next, rows(2), { snap: false, now: 1000 + SEGMENT_BLINK_MS });
    expect(again.blinking.get(segmentKey('T', 1))).toBe(1000);
    expect(stepLights(next, [], { snap: false, now: 1100 }).shown.size).toBe(0);
  });
});

describe('tasks in the room', () => {
  it('reads the room and the role from lastTransition only', () => {
    const [line] = devopsLines([devops('T1', 3)], NOW);
    expect(line.from).toBe('Review · dev');
    expect(line.days).toBe(3);
    expect(line.reason).toBe('tag the build and run the migration');
    expect(line.reasonLabel).toBe('reason');
  });

  it('shows the role as written, orchestrator included', () => {
    const [line] = devopsLines([devops('T2', 1, { agent: 'orchestrator', phase: 'assigned -> devops_needed' })], NOW);
    expect(line.from).toBe('Dev Bay · orchestrator');
  });

  it('shows nothing when the last transition is not the one into the current phase', () => {
    const other = devops('T3', 2, { phase: 'assigned -> review', reason: 'an older, unrelated reason' });
    const [line] = devopsLines([other], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBeNull();
    expect(line.reasonLabel).toBeNull();
    expect(devopsLines([devops('T3b', 2, null)], NOW)[0].reason).toBeNull();
  });

  it('calls a move inside the room the latest note and names no origin', () => {
    const [line] = devopsLines([devops('T4', 2, { phase: 'devops_needed -> devops_needed', reason: 'second pass' })], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBe('second pass');
    expect(line.reasonLabel).toBe('latest note');
  });

  it('reads devops_complete as a handoff, after the work that is still open', () => {
    const done = devops('T-DONE', 5, { phase: 'devops_needed -> devops_complete' }, { phase: 'devops_complete' });
    const lines = devopsLines([done, devops('T-WORK', 1)], NOW);
    expect(lines.map((line) => line.taskId)).toEqual(['T-WORK', 'T-DONE']);
    expect(lines[1].reason).toBe(DEVOPS_HANDOFF_TEXT);
    expect(lines[1].reason).toBe('devops done · waiting for handoff');
    expect(lines[1].from).toBeNull();
    expect(devopsCard(done, NOW)?.reason).toBe(DEVOPS_HANDOFF_TEXT);
  });

  it('cuts a long reason to two readout lines and keeps the full text for the card', () => {
    const long = `bump the version: ${'x '.repeat(80)}`.trim();
    const task = devops('T5', 1, { reason: long });
    const [line] = devopsLines([task], NOW);
    expect(line.reason!.length).toBeLessThan(long.length);
    expect(devopsCard(task, NOW)?.reason).toBe(long);
    expect(devopsCard(task, NOW)?.heading).toBe('DevOps');
  });

  it('returns no card for a task in another room', () => {
    expect(devopsCard(train('X', gates(1, 2)), NOW)).toBeNull();
  });

  describe('with a time zone that is not UTC', () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.TZ;
      process.env.TZ = 'Asia/Bangkok';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    });

    it('counts a date-only age from local midnight', () => {
      // Guards against the zone not being applied: Bangkok is UTC+7 all year.
      expect(new Date(2026, 9, 24).getTimezoneOffset()).toBe(-420);
      const task = devops('T6', 0, {}, { statusUpdatedAt: '2026-10-21' });
      // 2026-10-24 06:00 in Bangkok is 2026-10-23 23:00Z, three local days after 2026-10-21.
      const now = new Date(2026, 9, 24, 6, 0, 0).getTime();
      expect(devopsLines([task], now)[0].days).toBe(3);
      // One minute before local midnight on the 24th it is still two days.
      expect(devopsLines([task], new Date(2026, 9, 23, 23, 59, 0).getTime())[0].days).toBe(2);
    });
  });
});

describe('readout and clicks', () => {
  const trains = [
    train('TASK-EAR-402', gates(1, 4), { phase: 'blocked', status: 'blocked' }),
    train('TASK-EAR-406', gates(0, 2)),
  ];
  const render = (lines: ReturnType<typeof devopsLines>, selected: string | null = null) =>
    renderToStaticMarkup(React.createElement(DevopsReadout, { lines, trains: trainRows(trains), selectedTaskId: selected, onPick: () => undefined }));

  it('shows the release trains with their exact gates even when the room is empty', () => {
    const markup = render([]);
    expect(markup).toContain('release trains · 2');
    expect(markup).toContain('TASK-EAR-402');
    expect(markup).toContain('gates 1/4');
    expect(markup).toContain('gates 0/2');
    expect(markup).not.toContain('devops ·');
    expect(markup).toContain('data-readout="devops"');
  });

  it('puts the room head and one line per task above the trains', () => {
    const markup = render(devopsLines([devops('T1', 2), devops('T2', 1)], NOW));
    expect(markup).toContain('devops · 2');
    expect(markup.indexOf('devops · 2')).toBeLessThan(markup.indexOf('release trains'));
    expect(markup).toContain('tag the build');
  });

  it('highlights the selected train line', () => {
    expect(render([], 'TASK-EAR-406')).toMatch(/data-on="1"[^>]*data-task="TASK-EAR-406"|data-task="TASK-EAR-406"[^>]*data-on="1"/);
  });

  it('selects a train in its own room, not in DevOps', () => {
    expect(deskSelectionForTask('TASK-EAR-402', trains)).toEqual({ kind: 'desk', zoneId: 'blocked', taskId: 'TASK-EAR-402' });
    expect(deskSelectionForTask('TASK-EAR-406', trains)).toEqual({ kind: 'desk', zoneId: 'dev', taskId: 'TASK-EAR-406' });
  });

  it('keeps the readout up while a task from any room is selected, and hides it for the room itself', () => {
    expect(READOUT_ROOMS).toContain('devops');
    expect(LIST_READOUTS).toContain('devops');
    expect(visibleReadouts({ focus: 'devops', selection: { zoneId: 'blocked', kind: 'desk' }, tvHot: false }).has('devops')).toBe(true);
    expect(visibleReadouts({ focus: 'devops', selection: { zoneId: 'devops', kind: 'desk' }, tvHot: false }).has('devops')).toBe(true);
    expect(visibleReadouts({ focus: 'devops', selection: { zoneId: 'devops', kind: 'room' }, tvHot: false }).has('devops')).toBe(false);
  });

  it('shows gates x/y and Open in Monitor on a train card', () => {
    const markup = renderToStaticMarkup(React.createElement(GatesBlock, { taskId: 'TASK-EAR-402', text: gatesCard(trains[0])!.text }));
    expect(markup).toContain('gates 1/4');
    expect(markup).toContain('Open in Monitor');
    expect(renderToStaticMarkup(React.createElement(GatesBlock, { taskId: 'X', text: 'gates 0/2', showMonitor: false }))).not.toContain('Open in Monitor');
  });

  it('carries the waiting block with Copy for a train that waits on Earth', () => {
    const waiting = train('TASK-EAR-402', gates(1, 4), {
      phase: 'blocked',
      status: 'blocked',
      waitsOn: [{ kind: 'prod_run' }],
      actionKind: 'authorization_required',
      recommendedAction: 'ruby scripts/record-authorization.rb TASK-EAR-402 grant --action deploy_production',
    });
    const card = waitCard(waiting, buildWaitQueue([waiting], NOW));
    expect(card?.heading).toBe('Waiting on you');
    const markup = renderToStaticMarkup(React.createElement(WaitBlock, { taskId: waiting.taskId, card: card!, onGoTo: () => undefined, showMonitor: false }));
    expect(markup).toContain('Copy command');
    expect(markup).not.toContain('Open in Monitor');
  });

  it('shows the room block for a DevOps task', () => {
    const task = devops('T1', 2);
    const markup = renderToStaticMarkup(React.createElement(EscalationBlock, { taskId: task.taskId, card: devopsCard(task, NOW)! }));
    expect(markup).toContain('DevOps');
    expect(markup).toContain('Open in Monitor');
  });
});

describe('the room', () => {
  it('has the P2 furniture: the table with three chairs, cabinet and floor lamp as models, the rest as boxes', () => {
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'devops').map((item) => item.file);
    expect(files.filter((file) => file === 'table')).toHaveLength(1);
    expect(files.filter((file) => file === 'chair')).toHaveLength(3);
    expect(files).toContain('cabinetBedDrawer');
    expect(files.filter((file) => file === 'lampRoundFloor')).toHaveLength(1);
    const parts = new Set(devopsBoxes().map((box) => box.part));
    for (const part of ['board', 'tray', 'console', 'whiteboard', 'coffee', 'rug']) expect(parts).toContain(part);
    const merged = devopsFixtures();
    expect(Object.keys(merged).every((bucket) => ['wood', 'metal', 'fabric'].includes(bucket))).toBe(true);
    expect(merged.wood!.length + merged.metal!.length + merged.fabric!.length).toBe(devopsBoxes().length + 1);
  });

  it('has two racks, the original three-tier one kept, and the LEDs following the room rule', () => {
    const empty = posesFor([]);
    const tiers = (rackX: number, width: number) => dev(empty.rackBody).filter((pose) => pose.sx === width && pose.sz === 0.32 && Math.abs(pose.x - (ROOM_LAYOUT.devops.x + rackX)) < 1e-9);
    expect(DEVOPS.racks[0].x).toBe(1.15);
    expect(tiers(1.15, 0.72).map((pose) => pose.y)).toEqual([0, 1, 2].map((tier) => FLOOR_TOP + 0.18 + tier * 0.38));
    expect(tiers(DEVOPS.racks[1].x, DEVOPS.racks[1].w)).toHaveLength(DEVOPS.racks[1].tiers);
    // The LED rule: dark while the room is empty, the room tone while it holds a task. Both racks follow it.
    const ledCount = DEVOPS.racks.reduce((sum, rack) => sum + rack.tiers, 0);
    expect(dev(empty.rackLed)).toHaveLength(ledCount);
    expect(dev(empty.rackLed).map((pose) => pose.color)).toEqual(Array(ledCount).fill(SCENE.screenOff));
    const tasks = [devops('T1', 1)];
    const busy = posesFor(tasks);
    const tone = zoneTone(ZONE_BY_ID.get('devops')!, summarizeZones(tasks).get('devops')!);
    expect(tone).not.toBe(SCENE.screenOff);
    expect(dev(busy.rackLed).map((pose) => pose.color)).toEqual(Array(ledCount).fill(tone));
  });

  it('adds a plant and a console monitor that is dark while the room is empty', () => {
    const empty = posesFor([]);
    expect(empty.plant.filter((pose) => pose.zoneId === 'devops')).toHaveLength(1);
    expect(empty.screenOn).toHaveLength(0);
    expect(empty.screenOff.filter((pose) => pose.zoneId === 'devops')).toHaveLength(1);
    expect(posesFor([devops('T1', 1)]).screenOn.filter((pose) => pose.zoneId === 'devops')).toHaveLength(1);
  });

  it('keeps the shared desks, without screens', () => {
    const poses = posesFor([devops('A', 1), devops('B', 1)]);
    expect(poses.desk.filter((pose) => pose.zoneId === 'devops')).toHaveLength(2);
    expect(poses.screenOn.filter((pose) => pose.zoneId === 'devops' && pose.kind === 'desk')).toHaveLength(0);
    expect(poses.screenOff.filter((pose) => pose.zoneId === 'devops' && pose.kind === 'desk')).toHaveLength(0);
  });

  it('lights nothing new while the room is empty: no shade, no screen, no LED, only the board segments of resolved gates', () => {
    const empty = posesFor([train('TASK-EAR-402', gates(1, 4), { phase: 'blocked', status: 'blocked' })]);
    expect(dev(empty.rackLed).every((pose) => pose.color === dev(posesFor([]).rackLed)[0].color)).toBe(true);
    expect(empty.screenOn).toHaveLength(0);
    expect(empty.lamp.filter((pose) => pose.zoneId === 'devops')).toHaveLength(0);
    expect(devopsBoxes().some((box) => (box.bucket as string) === 'shade' || (box.bucket as string) === 'loungeShade')).toBe(false);
    expect(placedDecorBucket('devops', 'shade')).toBe('shade');
    // Every other new piece is a flat, unlit instance of the rack mesh.
    expect(empty.rackBody.filter((pose) => pose.zoneId === 'devops').every((pose) => pose.hot === false)).toBe(true);
  });

  it('keeps its own colors muted and out of the status palette', () => {
    for (const color of Object.values(DEVOPS_COLORS)) expect(loungeLightAllowed(color), color).toBe(true);
    expect(DEVOPS_TINTED.length).toBeGreaterThan(8);
  });

  it('keeps every piece inside the room, under the wall top and past x 1.2 only where the original rack already was', () => {
    for (const item of devopsBoxes()) {
      expect(Math.abs(item.x) + item.w / 2, item.part).toBeLessThanOrEqual(ROOM_W / 2);
      expect(Math.abs(item.z) + item.d / 2, item.part).toBeLessThanOrEqual(ROOM_D / 2);
      expect(item.y - item.h / 2, item.part).toBeGreaterThanOrEqual(-1e-6);
      expect(item.y + item.h / 2, item.part).toBeLessThanOrEqual(WALL_H);
    }
    for (const item of DEVOPS_TINTED) {
      expect(Math.abs(item.x) + item.w / 2, item.part).toBeLessThanOrEqual(ROOM_W / 2);
      expect(item.y + item.h / 2, item.part).toBeLessThanOrEqual(WALL_H);
    }
    for (const item of devopsFootprints()) {
      if (item.part === 'rack' && item.x === DEVOPS.racks[0].x) continue;
      expect(item.x + item.w / 2, item.part).toBeLessThanOrEqual(1.5);
      expect(item.x - item.w / 2, item.part).toBeGreaterThanOrEqual(-ROOM_W / 2);
      expect(item.z - item.d / 2, item.part).toBeGreaterThanOrEqual(-ROOM_D / 2);
    }
  });
});

describe('the front desk row', () => {
  const DESK_HALF_X = (0.7345 * 1.15) / 2;
  const DESK_HALF_Z = (0.3923 * 1.15) / 2;
  /** About half a robot's width: a walk keeps this far from any piece. */
  const WALK_CLEARANCE = 0.2;
  const tasksFor = (count: number) => Array.from({ length: count }, (_, index) => devops(`D-${index}`, index + 1));
  const hits = (item: { x: number; z: number; w: number; d: number }, x: number, z: number, pad: number) =>
    Math.abs(x - item.x) < item.w / 2 + pad && Math.abs(z - item.z) < item.d / 2 + pad;

  it('moves only DevOps and Dev Bay: deskZ is the new front row and every other room keeps its value', () => {
    expect(deskZ('devops')).toBe(0.8);
    expect(deskZ('devops')).toBeGreaterThan(DESK_Z);
    // Dev Bay's workstations stand on the same front row (SPAR-53).
    expect(deskZ('dev')).toBe(deskZ('devops'));
    for (const zone of ['review', 'escalation', 'debug', 'rejected', 'blocked', 'done', 'aborted']) expect(deskZ(zone)).toBe(DESK_Z);
    expect(deskZ('inbox')).toBeLessThan(DESK_Z);
    // The chair ends 0.46 behind the desk, inside the 1.7 front edge.
    expect(deskZ('devops') + 0.46).toBeLessThan(ROOM_D / 2);
  });

  it('places desks, chairs, seats and selection anchors on that row', () => {
    const tasks = tasksFor(3);
    const poses = posesFor(tasks);
    const layout = ROOM_LAYOUT.devops;
    for (const desk of poses.desk.filter((pose) => pose.zoneId === 'devops')) expect(desk.z).toBeCloseTo(layout.z + deskZ('devops'));
    for (const chair of poses.chair.filter((pose) => pose.zoneId === 'devops')) expect(chair.z).toBeCloseTo(layout.z + deskZ('devops') + 0.46);
    const slots = characterSlots(tasks, summarizeZones(tasks)).filter((slot) => slot.zoneId === 'devops');
    expect(slots).toHaveLength(3);
    for (const slot of slots) expect(slot.z).toBeCloseTo(layout.z + deskZ('devops') + SLOT_Z_OFFSET);
    const anchor = selectionAnchor({ kind: 'desk', zoneId: 'devops', taskId: 'D-0' }, tasks, summarizeZones(tasks));
    expect(anchor?.[2]).toBeCloseTo(layout.z + deskZ('devops'));
  });

  it('keeps the SCENE_DESK_LIMIT, drawing four desks for six tasks', () => {
    const poses = posesFor(tasksFor(6));
    expect(poses.desk.filter((pose) => pose.zoneId === 'devops')).toHaveLength(SCENE_DESK_LIMIT);
  });

  it('keeps every desk, chair and seated robot off every piece, with 1 to 4 tasks', () => {
    const footprints = devopsFootprints();
    for (let count = 1; count <= SCENE_DESK_LIMIT; count += 1) {
      for (let index = 0; index < count; index += 1) {
        const x = deskLocalX(index, count);
        const z = deskZ('devops');
        for (const item of footprints) {
          expect(hits(item, x, z, DESK_HALF_X) && Math.abs(z - item.z) < item.d / 2 + DESK_HALF_Z, `${item.part} on the desk ${index + 1}/${count}`).toBe(false);
          // The chair, 0.46 behind the desk, and the robot seated 0.04 behind the desk's seat point.
          expect(hits(item, x, z + 0.46, 0.12), `${item.part} on the chair ${index + 1}/${count}`).toBe(false);
          expect(hits(item, x, z + SLOT_Z_OFFSET, 0.27), `${item.part} on the robot ${index + 1}/${count}`).toBe(false);
        }
      }
    }
  });

  it('keeps every walk into and out of a DevOps seat clear of the furniture', () => {
    const footprints = devopsFootprints();
    const layout = ROOM_LAYOUT.devops;
    const options = { reducedMotion: false, initial: false } as const;
    for (let count = 1; count <= SCENE_DESK_LIMIT; count += 1) {
      const tasks = tasksFor(count);
      const places = classifyTasks(tasks, summarizeZones(tasks));
      const elsewhere = classifyTasks(tasks.map((task) => ({ ...task, phase: 'assigned' as const })), summarizeZones(tasks.map((task) => ({ ...task, phase: 'assigned' as const }))));
      const routes: CharacterPlace[][] = [];
      places.forEach((place, index) => {
        const enter = planMove(null, place, options);
        const leave = planMove(place, elsewhere[index], options);
        for (const plan of [enter, leave]) {
          if (!plan) continue;
          expect(plan.points.length).toBeGreaterThan(0);
          const points = plan.points.map((point) => ({ x: point.x - layout.x, z: point.z - layout.z }));
          for (let leg = 0; leg + 1 < points.length; leg += 1) {
            for (let step = 0; step <= 40; step += 1) {
              const t = step / 40;
              const x = points[leg].x + (points[leg + 1].x - points[leg].x) * t;
              const z = points[leg].z + (points[leg + 1].z - points[leg].z) * t;
              for (const item of footprints) {
                expect(hits(item, x, z, WALK_CLEARANCE), `${item.part} on a walk of ${count} desks`).toBe(false);
              }
            }
          }
        }
        routes.push([place]);
      });
      expect(routes).toHaveLength(count);
    }
    expect(FRONT_OUTSET).toBeGreaterThan(0);
  });
});

describe('the board from the default camera', () => {
  /** The default camera sits at (+24, +20, +20.5) from its aim: a sight line leaves the board along this direction. */
  const TOWARD_CAMERA = { x: 24, y: 20, z: 20.5 };
  interface Aabb { part: string; min: [number, number, number]; max: [number, number, number] }
  const around = (part: string, x: number, z: number, w: number, d: number, h: number, y = 0): Aabb =>
    ({ part, min: [x - w / 2, y, z - d / 2], max: [x + w / 2, y + h, z + d / 2] });

  /** Everything between the board and the camera: the boxes, rack tiers and models, with their real heights. */
  function occluders(): Aabb[] {
    const { table, chairs, chairScale, cabinet, lamp, plant, racks, rackZ } = DEVOPS;
    return [
      ...devopsBoxes().filter((item) => !['board', 'rug', 'whiteboard'].includes(item.part))
        .map((item) => around(item.part, item.x, item.z, item.w, item.d, item.h, item.y - item.h / 2)),
      ...racks.flatMap((rack) => Array.from({ length: rack.tiers }, (_, tier) =>
        around('rack', rack.x, rackZ, rack.w, 0.32, 0.3, 0.18 + tier * 0.38 - 0.15))),
      around('table', table.x, table.z, table.w, table.d, table.top),
      ...chairs.map((chair) => around('chair', chair.x, chair.z, 0.2 * chairScale, 0.2 * chairScale, 0.47 * chairScale)),
      around('cabinet', cabinet.x, cabinet.z, 0.266 * cabinet.scale, 0.381 * cabinet.scale, 0.263 * cabinet.scale),
      around('lamp', lamp.x, lamp.z, 0.152 * lamp.scale, 0.176 * lamp.scale, 0.86 * lamp.scale),
      around('plant', plant.x, plant.z, 0.255 * 1.15, 0.291 * 1.15, 0.536 * 1.15),
    ];
  }

  /** Slab test: does the ray from `from` along TOWARD_CAMERA enter the box? */
  function hits(box: Aabb, from: [number, number, number]): boolean {
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

  it('shows all 24 slots, lit and dark, with nothing between a slot and the camera', () => {
    const blockers = occluders();
    for (let row = 0; row < BOARD_ROWS; row += 1) {
      for (let col = 0; col < BOARD_SEGMENTS; col += 1) {
        for (const lit of [false, true]) {
          const slot = segmentSlot(row, col, lit);
          // Sample the front face: its centre and its four corners, nudged off the surface.
          for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const from: [number, number, number] = [slot.x + (dx * slot.w) / 2 * 0.9, slot.y + (dy * slot.h) / 2 * 0.9, slot.z + slot.d / 2 + 0.004];
            for (const blocker of blockers) {
              expect(hits(blocker, from), `${blocker.part} hides row ${row + 1} column ${col + 1}${lit ? ' (lit)' : ''}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('would notice a piece that stands in front of the board', () => {
    const slot = segmentSlot(3, 5, true);
    const wall: [number, number, number] = [slot.x, slot.y, slot.z + slot.d / 2 + 0.004];
    expect(hits(around('rack', slot.x + 0.4, -1.28, 0.72, 0.32, 1.09), wall)).toBe(true);
    expect(hits(around('rack', 1.15, -1.28, 0.72, 0.32, 1.09), wall)).toBe(false);
  });
});
