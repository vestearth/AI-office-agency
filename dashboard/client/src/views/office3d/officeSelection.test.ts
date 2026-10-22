import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ZONES, summarizeZones } from '../commandZones';
import { OfficeDetail, OfficeRoomList } from './OfficeSelectionPanel';
import {
  ROOM_LAYOUT,
  SCENE_DESK_LIMIT,
  commitOfficeKey,
  deskSelectionForTask,
  desksForZone,
  describeOfficeSelection,
  followTaskSelection,
  moveOfficeSelection,
  officeTaskSummary,
  officeTasksFromApi,
  sceneDesks,
  selectionDomId,
  type OfficeSelection,
  type OfficeTask,
} from './officeSelection';

const task = (over: Partial<OfficeTask> & Pick<OfficeTask, 'taskId' | 'phase' | 'status'>): OfficeTask => ({
  title: over.taskId,
  needsReview: false,
  ...over,
});

const tasks: OfficeTask[] = [
  task({ taskId: 'TASK-DEV-ASK', title: 'Needs a person', phase: 'assigned', status: 'running', needsReview: true, currentAgent: 'dev', updatedAt: '2026-10-21T00:00:00Z' }),
  task({ taskId: 'TASK-DEV-WORK', title: 'Started in the bay', phase: 'debugging', status: 'running', needsReview: false, currentAgent: 'debugger', updatedAt: '2026-10-20T00:00:00Z' }),
  task({ taskId: 'TASK-REV-1', title: 'Waiting on review', phase: 'in_review', status: 'waiting_review', needsReview: true }),
  task({ taskId: 'TASK-BLK-1', title: 'Stuck', phase: 'blocked', status: 'blocked', needsReview: false }),
];

function detailMarkup(selection: OfficeSelection | null, source: OfficeTask[] = tasks): string {
  return renderToStaticMarkup(React.createElement(OfficeDetail, { tasks: source, selection }));
}

describe('3D office selection', () => {
  it('shows every task and status in the selected room', () => {
    const html = detailMarkup({ kind: 'room', zoneId: 'review' });
    expect(html).toContain('Review');
    expect(html).toContain('TASK-REV-1');
    expect(html).toContain('Waiting on review');
    expect(html).toContain('In review');
    expect(html).not.toContain('TASK-BLK-1');
    expect(html).not.toContain('Blocked');
  });

  it('shows only the chosen desk task and its status', () => {
    const html = detailMarkup({ kind: 'desk', zoneId: 'blocked', taskId: 'TASK-BLK-1' });
    expect(html).toContain('Blocked desk');
    expect(html).toContain('TASK-BLK-1');
    expect(html).toContain('Stuck');
    expect(html).toContain('Blocked');
    expect(html).not.toContain('TASK-REV-1');
    expect(html).not.toContain('In review');
  });

  it('follows arrow keys from a room onto that room’s desk and shows its status', () => {
    const desk = moveOfficeSelection({ kind: 'room', zoneId: 'debug' }, 'ArrowRight', tasks);
    expect(desk).toEqual({ kind: 'desk', zoneId: 'debug', taskId: 'TASK-DEV-WORK' });
    const html = detailMarkup(desk);
    expect(html).toContain('TASK-DEV-WORK');
    expect(html).toContain('In progress');
    expect(html).not.toContain('TASK-DEV-ASK');
  });

  it('keeps an assigned-only run labeled Assigned on its desk', () => {
    const desk = moveOfficeSelection({ kind: 'room', zoneId: 'dev' }, 'ArrowRight', tasks);
    expect(desk).toEqual({ kind: 'desk', zoneId: 'dev', taskId: 'TASK-DEV-ASK' });
    const html = detailMarkup(desk);
    expect(html).toContain('TASK-DEV-ASK');
    expect(html).toContain('Assigned');
    expect(html).not.toContain('In progress');
  });

  it('offers a keyboard button for every room and desk', () => {
    const html = renderToStaticMarkup(React.createElement(OfficeRoomList, {
      tasks,
      stats: summarizeZones(tasks),
      selection: { kind: 'desk', zoneId: 'blocked', taskId: 'TASK-BLK-1' },
      onSelect: () => {},
    }));
    expect(html).toContain('Dev Bay');
    expect(html).toContain('TASK-BLK-1');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Empty desk');
  });

  it('moves focus to the room or desk arrow keys select', () => {
    const current: OfficeSelection = { kind: 'room', zoneId: 'inbox' };
    const focused: string[] = [];
    const root = {
      querySelector(selector: string) {
        return { focus() { focused.push(selector); } };
      },
    };
    const next = commitOfficeKey(current, 'ArrowDown', tasks, root);
    expect(next).toEqual({ kind: 'room', zoneId: 'review' });
    expect(focused).toEqual([`#${selectionDomId(next!)}`]);

    const html = renderToStaticMarkup(React.createElement(OfficeRoomList, {
      tasks,
      stats: summarizeZones(tasks),
      selection: next,
      onSelect: () => {},
    }));
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain(`id="${selectionDomId(next!)}"`);
    expect(html).toContain('id="office-room-review"');
    expect(html).not.toContain('tabindex="0" id="office-room-inbox"');
    const desk = commitOfficeKey(next, 'ArrowRight', tasks, root);
    expect(desk).toEqual({ kind: 'desk', zoneId: 'review', taskId: 'TASK-REV-1' });
    expect(focused[1]).toBe(`#${selectionDomId(desk!)}`);
    const deskHtml = renderToStaticMarkup(React.createElement(OfficeRoomList, {
      tasks,
      stats: summarizeZones(tasks),
      selection: desk,
      onSelect: () => {},
    }));
    const deskTag = (deskHtml.match(/<button\b[^>]*>/g) ?? []).find((tag) => tag.includes(`id="${selectionDomId(desk!)}"`));
    expect(deskHtml.match(/tabindex="0"/g)).toHaveLength(1);
    expect(deskTag).toContain('tabindex="0"');
  });

  it('follows a selected desk when its task moves to another zone', () => {
    const before: OfficeSelection = { kind: 'desk', zoneId: 'dev', taskId: 'TASK-MOVE' };
    const moved = [task({
      taskId: 'TASK-MOVE',
      title: 'Now reviewing',
      phase: 'in_review',
      status: 'waiting_review',
      needsReview: true,
    })];
    const next = followTaskSelection(before, moved);
    expect(next).toEqual({ kind: 'desk', zoneId: 'review', taskId: 'TASK-MOVE' });
    const html = detailMarkup(next, moved);
    expect(html).toContain('TASK-MOVE');
    expect(html).toContain('Now reviewing');
    expect(html).toContain('In review');
    expect(html).not.toContain('No task at this desk.');
    expect(followTaskSelection(next, moved)).toBe(next);
    expect(followTaskSelection({ kind: 'room', zoneId: 'dev' }, moved)).toEqual({ kind: 'room', zoneId: 'dev' });
  });

  it('selects the desk named by ?run=', () => {
    const selection = deskSelectionForTask('TASK-REV-1', tasks);
    expect(selection).toEqual({ kind: 'desk', zoneId: 'review', taskId: 'TASK-REV-1' });
    const html = detailMarkup(selection);
    expect(html).toContain('TASK-REV-1');
    expect(html).toContain('In review');
    expect(deskSelectionForTask('TASK-MISSING', tasks)).toBeNull();
  });

  it('keeps a single tab stop when the selected desk has no button', () => {
    const list = (selection: OfficeSelection, source: OfficeTask[]) => renderToStaticMarkup(React.createElement(OfficeRoomList, {
      tasks: source,
      stats: summarizeZones(source),
      selection,
      onSelect: () => {},
    }));
    const roomTab = (html: string, zoneId: string) => (html.match(/<button\b[^>]*>/g) ?? []).find((tag) => tag.includes(`id="office-room-${zoneId}"`));

    const many = Array.from({ length: SCENE_DESK_LIMIT + 1 }, (_, index) => task({
      taskId: `TASK-DONE-${index}`,
      phase: 'done',
      status: 'completed',
    }));
    const beyond = list({ kind: 'desk', zoneId: 'done', taskId: 'TASK-DONE-4' }, many);
    expect(beyond.match(/tabindex="0"/g)).toHaveLength(1);
    expect(roomTab(beyond, 'done')).toContain('tabindex="0"');

    const gone = list({ kind: 'desk', zoneId: 'dev', taskId: 'TASK-GONE' }, tasks);
    expect(gone.match(/tabindex="0"/g)).toHaveLength(1);
    expect(roomTab(gone, 'dev')).toContain('tabindex="0"');

    const missingZone = list({ kind: 'desk', zoneId: 'missing', taskId: 'TASK-GONE' }, tasks);
    expect(missingZone.match(/tabindex="0"/g)).toHaveLength(1);
    expect(roomTab(missingZone, ZONES[0].id)).toContain('tabindex="0"');
  });

  it('reports an empty desk without borrowing another room’s task', () => {
    const html = detailMarkup({ kind: 'desk', zoneId: 'inbox', taskId: null });
    expect(html).toContain('No task at this desk.');
    expect(html).not.toContain('TASK-DEV-ASK');
  });
});

describe('office task binding', () => {
  it('places every zone, draws a few desks, and still lists every task on the room', () => {
    for (const zone of ZONES) expect(ROOM_LAYOUT[zone.id]).toBeTruthy();
    const many: OfficeTask[] = Array.from({ length: SCENE_DESK_LIMIT + 1 }, (_, index) => task({
      taskId: `TASK-DONE-${index}`,
      phase: 'done',
      status: 'completed',
    }));
    const desks = desksForZone('done', many);
    expect(desks).toHaveLength(SCENE_DESK_LIMIT + 1);
    expect(sceneDesks(desks)).toHaveLength(SCENE_DESK_LIMIT);
    const room = describeOfficeSelection({ kind: 'room', zoneId: 'done' }, many);
    expect(room.tasks.map((item) => item.taskId)).toContain('TASK-DONE-4');
    expect(room.tasks.every((item) => item.statusLabel === 'Done')).toBe(true);
    const reached = moveOfficeSelection({ kind: 'room', zoneId: 'done' }, 'ArrowRight', many);
    expect(sceneDesks(desks).some((desk) => desk.taskId === (reached && reached.kind === 'desk' ? reached.taskId : null))).toBe(true);
  });

  it('reads status from the run and phase from the review payload', () => {
    const [mapped] = officeTasksFromApi(
      [{ taskId: 'TASK-EAR-9', title: 'review title', phase: 'debugging', needsReview: false }],
      [{ id: 'TASK-EAR-9', title: 'run title', status: 'running', currentAgent: 'debugger', updatedAt: '2026-10-21T00:00:00Z' }],
    );
    expect(mapped.title).toBe('run title');
    expect(mapped.phase).toBe('debugging');
    expect(describeOfficeSelection({ kind: 'desk', zoneId: 'debug', taskId: 'TASK-EAR-9' }, [mapped]).tasks[0].statusLabel).toBe('In progress');
    expect(mapped.operator).toBe('unknown');
  });

  it('keeps the last operator, and maps legacy gemini onto antigravity', () => {
    const [mapped] = officeTasksFromApi(
      [{ taskId: 'TASK-OP-1', title: 'palette', phase: 'debugging', needsReview: false }],
      [{ id: 'TASK-OP-1', title: 'palette', status: 'running', currentAgent: 'debugger', updatedAt: '2026-10-22T00:00:00Z', currentConductor: 'gemini' }],
    );
    expect(mapped.operator).toBe('antigravity');
    const line = describeOfficeSelection({ kind: 'desk', zoneId: 'debug', taskId: 'TASK-OP-1' }, [mapped]).tasks[0];
    expect(line.operator).toBe('antigravity');
    expect(officeTaskSummary(line)).toBe('TASK-OP-1 · In progress · last operator: antigravity');
    const html = detailMarkup({ kind: 'desk', zoneId: 'debug', taskId: 'TASK-OP-1' }, [mapped]);
    expect(html).toContain('last operator: antigravity');
    expect(html).not.toContain('gemini');
  });
});
