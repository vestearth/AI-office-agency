import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionRecord, ReviewSummary } from '../../../../shared/types';
import { summarizeZones } from '../commandZones';
import { COMPLETE_TEXT, debugCard, debugLines, sentBackByEarth, stayAge } from './officeDebug';
import { DebugBlock, DebugReadout } from './OfficeDebugViews';
import { LIST_READOUTS, READOUT_ROOMS, chipValue, visibleReadouts } from './officeLabels';
import { officeTasksFromApi, type OfficeTask } from './officeSelection';

const NOW = Date.parse('2026-10-24T01:00:00Z');
type Entry = NonNullable<ReviewSummary['debugEntry']>;

const entry = (over: Partial<Entry> = {}): Entry => ({
  agent: 'reviewer',
  phase: 'in_review -> debugging',
  reason: 'The admin-list COUNT finding needs a fix covering the unbounded-start request.',
  at: '2026-10-24T00:53:00Z',
  ...over,
});

const inLab = (taskId: string, over: Partial<OfficeTask> = {}): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'debugging',
  status: 'running',
  needsReview: false,
  debugRounds: 1,
  debugEntry: entry(),
  ...over,
});

const changes = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decision: 'request_changes',
  actor: 'earth',
  note: 'Count the real request shape, then add the regression.',
  decidedAt: '2026-10-24T00:52:30Z',
  ...over,
});

const fromEarth = (over: Partial<OfficeTask> = {}): OfficeTask => inLab('C-1', {
  debugEntry: entry({ agent: 'orchestrator', reason: 'human decision: request_changes by earth' }),
  latestDecision: changes(),
  decisionPending: false,
  ...over,
});

describe('how long a task has been in Debug Lab', () => {
  it('uses minutes, then hours, for a timestamped entry', () => {
    expect(stayAge('2026-10-24T00:53:00Z', NOW)).toBe('7m');
    expect(stayAge('2026-10-23T22:00:00Z', NOW)).toBe('3h');
  });

  it('shows today or whole days for a date-only entry, counted from local midnight', () => {
    expect(stayAge('2026-10-24', NOW)).toBe('today');
    expect(stayAge('2026-10-24', Date.parse('2026-10-24T23:30:00Z'))).toBe('today');
    expect(stayAge('2026-10-23', NOW)).toBe('1d');
    expect(stayAge('2026-07-13', NOW)).toBe('103d');
  });

  it('shows no age without a usable entry time', () => {
    expect(stayAge(null, NOW)).toBeNull();
    expect(stayAge(undefined, NOW)).toBeNull();
    expect(stayAge('not a date', NOW)).toBeNull();
  });
});

describe('Debug Lab readout lines', () => {
  it('reads who and why from debugEntry, so a bookkeeping row during the stay changes nothing', () => {
    const [line] = debugLines([inLab('VS-026', {
      lastTransition: { agent: 'debugger', phase: 'debugging -> debugging', reason: 'Branch bank_flow_transfers: blocked -> ready', at: '2026-10-24T00:58:00Z' },
    })], NOW);
    expect(line).toMatchObject({ taskId: 'VS-026', kind: 'debugging', rounds: 1, looping: false, age: '7m', who: 'sent back by reviewer' });
    expect(line.reason).toBe('The admin-list COUNT finding needs a fix covering the unbounded-start request.');
  });

  it('cuts the reason for the readout and keeps it whole on the card', () => {
    const long = `${'The reviewer found that the replay path still double counts settled rounds. '.repeat(3)}  end`;
    const task = inLab('L-1', { debugEntry: entry({ reason: long }) });
    const [line] = debugLines([task], NOW);
    expect(line.reason!.length).toBeLessThanOrEqual(91);
    expect(line.reason!.endsWith('…')).toBe(true);
    expect(debugCard(task, NOW)!.reason).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('carries the round badge and marks a looping task from round 3', () => {
    const lines = debugLines([inLab('R-2', { debugRounds: 2 }), inLab('R-4', { debugRounds: 4 })], NOW);
    expect(lines.map((line) => [line.taskId, line.rounds, line.looping])).toEqual([['R-2', 2, false], ['R-4', 4, true]]);
  });

  it('shows no round for a task in the room with round 0 or no count', () => {
    const lines = debugLines([inLab('Z-0', { debugRounds: 0, debugEntry: null }), inLab('Z-U', { debugRounds: undefined })], NOW);
    expect(lines.map((line) => line.rounds)).toEqual([null, null]);
    expect(lines.every((line) => !line.looping)).toBe(true);
    expect(lines.find((line) => line.taskId === 'Z-0')).toMatchObject({ age: null, who: null, reason: null });
  });

  it('says the debugger is done and waits for dev for debugging_complete, with no reason', () => {
    const [line] = debugLines([inLab('D-1', { phase: 'debugging_complete', debugRounds: 2 })], NOW);
    expect(line).toMatchObject({ kind: 'complete', who: COMPLETE_TEXT, reason: null, rounds: 2 });
    expect(COMPLETE_TEXT).toBe('debugger done · waiting for dev');
    expect(debugCard(inLab('D-1', { phase: 'debugging_complete' }), NOW)).toMatchObject({ heading: 'Debugger done', who: COMPLETE_TEXT, reason: null });
  });

  it('lists tasks in debugging first, longest stay first, then the ones waiting for dev', () => {
    const lines = debugLines([
      inLab('B', { debugEntry: entry({ at: '2026-10-24T00:50:00Z' }) }),
      inLab('DONE', { phase: 'debugging_complete', debugEntry: entry({ at: '2026-10-20T00:00:00Z' }) }),
      inLab('A', { debugEntry: entry({ at: '2026-10-23' }) }),
      inLab('NONE', { debugEntry: null, debugRounds: 0 }),
      inLab('ELSEWHERE', { phase: 'in_review' }),
    ], NOW);
    expect(lines.map((line) => line.taskId)).toEqual(['A', 'B', 'NONE', 'DONE']);
  });
});

describe("Earth's Changes decision", () => {
  it('reads sent back by <actor> (Changes) with Earth’s note as the reason', () => {
    expect(sentBackByEarth(fromEarth())).toBe(true);
    const [line] = debugLines([fromEarth()], NOW);
    expect(line.who).toBe('sent back by earth (Changes)');
    expect(line.reason).toBe('Count the real request shape, then add the regression.');
    expect(debugCard(fromEarth(), NOW)).toMatchObject({ who: 'sent back by earth (Changes)', reason: 'Count the real request shape, then add the regression.' });
  });

  it('accepts a decision recorded at the same moment as the entry row', () => {
    expect(sentBackByEarth(fromEarth({ latestDecision: changes({ decidedAt: '2026-10-24T00:53:00Z' }) }))).toBe(true);
  });

  it('shows the row as written when any structured condition fails', () => {
    const asWritten = (task: OfficeTask) => {
      expect(sentBackByEarth(task)).toBe(false);
      const [line] = debugLines([task], NOW);
      return [line.who, line.reason];
    };
    const written = ['sent back by orchestrator', 'human decision: request_changes by earth'];
    expect(asWritten(fromEarth({ decisionPending: true }))).toEqual(written);
    expect(asWritten(fromEarth({ decisionPending: undefined }))).toEqual(written);
    expect(asWritten(fromEarth({ latestDecision: changes({ decision: 'escalate' }) }))).toEqual(written);
    expect(asWritten(fromEarth({ latestDecision: changes({ decidedAt: '2026-10-24T00:59:00Z' }) }))).toEqual(written);
    expect(asWritten(fromEarth({ latestDecision: null }))).toEqual(written);
    expect(asWritten(fromEarth({ debugEntry: entry({ agent: 'orchestrator', reason: 'human decision: request_changes by earth', at: null }) }))).toEqual(written);
    // A reviewer row is never relabelled, whatever the latest decision says.
    expect(asWritten(fromEarth({ debugEntry: entry() }))).toEqual(['sent back by reviewer', entry().reason]);
  });
});

describe('the Debug Lab readout and card', () => {
  it('is a clickable list readout that stays while one of its tasks is selected', () => {
    expect(READOUT_ROOMS).toContain('debug');
    expect(LIST_READOUTS).toContain('debug');
    expect([...visibleReadouts({ focus: 'debug', selection: { zoneId: 'debug', kind: 'desk' }, tvHot: false })]).toEqual(['debug']);
    expect([...visibleReadouts({ focus: 'debug', selection: { zoneId: 'debug', kind: 'room' }, tvHot: false })]).toEqual([]);
    expect([...visibleReadouts({ focus: 'debug', selection: null, tvHot: false })]).toEqual(['debug']);
  });

  it('renders one button per task with the age, the round badge, who sent it back and the reason', () => {
    const lines = debugLines([inLab('EAR-110', { debugRounds: 4 }), inLab('VS-026')], NOW);
    const html = renderToStaticMarkup(React.createElement(DebugReadout, { lines, selectedTaskId: 'EAR-110', onPick: () => undefined }));
    expect(html).toContain('data-readout="debug"');
    expect(html).toContain('debugging · 2');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toMatch(/data-on="1" data-task="EAR-110"/);
    expect(html).toContain('round 4');
    expect(html).toMatch(/data-loop="1"[^>]*>round 4</);
    expect(html).toContain('round 1');
    expect(html).not.toMatch(/data-loop="1"[^>]*>round 1</);
    expect(html).toContain('7m');
    expect(html).toContain('sent back by reviewer');
    expect(html).toContain('The admin-list COUNT finding');
  });

  it('renders no badge for round 0', () => {
    const lines = debugLines([inLab('Z-0', { debugRounds: 0, debugEntry: null })], NOW);
    const html = renderToStaticMarkup(React.createElement(DebugReadout, { lines, selectedTaskId: null, onPick: () => undefined }));
    expect(html).not.toContain('round');
  });

  it('puts the round badge, the full reason and Open in Monitor on the card', () => {
    const card = debugCard(inLab('EAR-110', { debugRounds: 4 }), NOW)!;
    expect(card).toMatchObject({ heading: 'Debugging', rounds: 4, looping: true, age: '7m', who: 'sent back by reviewer' });
    const html = renderToStaticMarkup(React.createElement(DebugBlock, { taskId: 'EAR-110', card }));
    expect(html).toContain('data-debug-block');
    expect(html).toMatch(/data-loop="1"[^>]*>round 4</);
    expect(html).toContain('sent back by reviewer');
    expect(html).toContain('The admin-list COUNT finding needs a fix covering the unbounded-start request.');
    expect(html).toMatch(/<button[^>]*class="form-button"[^>]*>Open in Monitor<\/button>/);
    expect(debugCard(inLab('X', { phase: 'in_review' }), NOW)).toBeNull();
  });

  it('keeps the SPAR-45 count chip: every task in the room', () => {
    const tasks = [inLab('A'), inLab('B', { phase: 'debugging_complete' })];
    expect(chipValue('debug', { stats: summarizeZones(tasks), closedToday: 0, abortedTotal: 0, waitingOnEarth: 0 })).toBe(2);
  });
});

describe('office tasks carry the debug entry', () => {
  it('keeps debugEntry, latestDecision and decisionPending from the review read model', () => {
    const [task] = officeTasksFromApi(
      [{ taskId: 'T', title: 'T', phase: 'debugging', needsReview: false, debugRounds: 1, debugEntry: entry(), latestDecision: changes(), decisionPending: false }],
      [],
    );
    expect(task.debugEntry).toEqual(entry());
    expect(task.latestDecision).toEqual(changes());
    expect(task.decisionPending).toBe(false);
  });
});
