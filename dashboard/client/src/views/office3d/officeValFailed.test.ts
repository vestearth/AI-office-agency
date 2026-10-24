import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import { EscalationBlock, EscalationReadout } from './OfficeEscalationViews';
import { LIST_READOUTS, READOUT_ROOMS, chipValue, visibleReadouts } from './officeLabels';
import { deskSelectionForTask, type OfficeTask } from './officeSelection';
import { valFailedCard, valFailedLines } from './officeValFailed';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function failed(taskId: string, days: number, transition: Partial<NonNullable<OfficeTask['lastTransition']>> = {}, over: Partial<OfficeTask> = {}): OfficeTask {
  return {
    taskId,
    title: taskId,
    phase: 'validation_failed',
    status: 'blocked',
    needsReview: false,
    statusUpdatedAt: ago(days),
    lastTransition: { agent: 'dev', phase: 'assigned -> validation_failed', reason: 'output could not be parsed during sync', at: ago(days), ...transition },
    ...over,
  };
}

describe('Val.Failed readout lines', () => {
  it('reads the room and the role from lastTransition only', () => {
    const [line] = valFailedLines([failed('T1', 3)], NOW);
    expect(line.from).toBe('Dev Bay · dev');
    expect(line.days).toBe(3);
    expect(line.reason).toBe('output could not be parsed during sync');
    expect(line.reasonLabel).toBe('reason');
  });

  it('leaves the role out for the orchestrator and never parses it from the reason', () => {
    const [line] = valFailedLines([failed('T2', 1, { agent: 'orchestrator', phase: 'in_review -> validation_failed', reason: 'reviewer output failed schema validation: no evidence' })], NOW);
    expect(line.from).toBe('Review');
    expect(line.from).not.toMatch(/reviewer/);
    expect(line.reason).toContain('reviewer output failed schema validation');
  });

  it('shows no origin and no reason when the last transition is not into validation_failed', () => {
    const other = failed('T3', 2, { phase: 'assigned -> review', reason: 'an older, unrelated reason' });
    const [line] = valFailedLines([other], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBeNull();
    expect(line.reasonLabel).toBeNull();
    expect(valFailedLines([failed('T3b', 2, {}, { lastTransition: null })], NOW)[0].reason).toBeNull();
  });

  it('calls a move inside the room the latest note and names no origin', () => {
    const [line] = valFailedLines([failed('T4', 2, { phase: 'validation_failed -> validation_failed', reason: 'free-roam failed again' })], NOW);
    expect(line.from).toBeNull();
    expect(line.reason).toBe('free-roam failed again');
    expect(line.reasonLabel).toBe('latest note');
  });

  it('cuts a long reason to two readout lines and keeps the full text for the card', () => {
    const long = `gate plan conflicts with status.yaml: ${'x '.repeat(80)}`.trim();
    const task = failed('T5', 1, { reason: long });
    const [line] = valFailedLines([task], NOW);
    expect(line.reason!.length).toBeLessThan(long.length);
    expect(line.reason!.endsWith('…')).toBe(true);
    expect(valFailedCard(task, NOW)?.reason).toBe(long);
  });

  it('lists only this room, longest wait first', () => {
    const other: OfficeTask = { ...failed('X', 9), phase: 'blocked' };
    const lines = valFailedLines([failed('NEW', 1), other, failed('OLD', 8)], NOW);
    expect(lines.map((line) => line.taskId)).toEqual(['OLD', 'NEW']);
    expect(valFailedCard(other, NOW)).toBeNull();
  });
});

describe('Val.Failed clicks and card', () => {
  it('is a list readout that stays while one of its tasks is selected, and counts its tasks in the chip', () => {
    expect(READOUT_ROOMS).toContain('rejected');
    expect(LIST_READOUTS).toContain('rejected');
    const shown = visibleReadouts({ focus: 'rejected', selection: { zoneId: 'rejected', kind: 'desk' }, tvHot: false });
    expect(shown.has('rejected')).toBe(true);
    expect(visibleReadouts({ focus: 'rejected', selection: { zoneId: 'rejected', kind: 'room' }, tvHot: false }).has('rejected')).toBe(false);
    const tasks = [failed('A', 1), failed('B', 2)];
    expect(chipValue('rejected', { stats: summarizeZones(tasks), closedToday: 0, abortedTotal: 0, waitingOnEarth: 0, reviewWaiting: 0 })).toBe(2);
  });

  it('selects the task from a readout line and the card carries Open in Monitor', () => {
    const tasks = [failed('A', 1)];
    expect(deskSelectionForTask('A', tasks)).toEqual({ kind: 'desk', zoneId: 'rejected', taskId: 'A' });
    const picked: string[] = [];
    const lines = valFailedLines(tasks, NOW);
    const html = renderToStaticMarkup(React.createElement(EscalationReadout, { lines, selectedTaskId: 'A', onPick: (id: string) => picked.push(id), room: 'rejected', head: 'failed validation' }));
    expect(html).toContain('data-readout="rejected"');
    expect(html).toContain('data-task="A"');
    expect(html).toContain('failed validation · 1');
    const card = renderToStaticMarkup(React.createElement(EscalationBlock, { taskId: 'A', card: valFailedCard(tasks[0], NOW)! }));
    expect(card).toContain('Open in Monitor');
    expect(card).toContain('Failed validation');
  });
});
