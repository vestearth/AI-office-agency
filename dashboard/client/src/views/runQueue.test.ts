import { describe, expect, it } from 'vitest';
import type { RunQueueItem } from '../../../shared/types';
import { queueItemLine } from '../../../shared/runQueue';
import { afterTaskOptions, confirmLine, defaultAtInput, queueFailedLine, queuedStatus, runButtonLabel, toLocalInput, triggerFromForm } from './runQueue';

// TZ=UTC (npm test): local time is UTC here.
const now = new Date('2026-10-17T10:00:00Z');
const item = (over: Partial<RunQueueItem> = {}): RunQueueItem => ({
  id: 'q-1', kind: 'task', key: 'TASK-EAR-1', label: 'TASK-EAR-1 dev', enqueuedAt: '2026-10-17T09:59:00Z', trigger: { kind: 'now' }, state: 'waiting',
  step: { role: 'dev', cli: 'claude', repos: [{ repo: 'api-gateway' }] }, waitingFor: 'a free slot (2 of 2 running)', ...over,
});

describe('triggerFromForm', () => {
  it('now needs nothing; a time becomes ISO; after needs a task', () => {
    expect(triggerFromForm('now', '', '', now)).toEqual({ kind: 'now' });
    expect(triggerFromForm('at', '2026-10-17T14:30', '', now)).toEqual({ kind: 'at', at: '2026-10-17T14:30:00.000Z' });
    expect(triggerFromForm('after', '', 'TASK-EAR-2', now)).toEqual({ kind: 'after', taskId: 'TASK-EAR-2', scope: 'step' });
    expect(triggerFromForm('after-chain', '', 'TASK-EAR-2', now)).toEqual({ kind: 'after', taskId: 'TASK-EAR-2', scope: 'chain' });
    expect(triggerFromForm('after-chain', '', '', now)).toEqual({ error: 'Pick the task whose chain it waits for.' });
    expect(queuedStatus(item({ trigger: { kind: 'after', taskId: 'TASK-EAR-2', scope: 'chain' }, waitingFor: "TASK-EAR-2's chain to end" })))
      .toBe("TASK-EAR-1 dev: queued after TASK-EAR-2's chain ends, waiting for TASK-EAR-2's chain to end");
  });
  it('refuses a missing or past time and a missing task', () => {
    expect(triggerFromForm('at', '', '', now)).toEqual({ error: 'Pick the time to start.' });
    expect(triggerFromForm('at', '2026-10-17T09:00', '', now)).toEqual({ error: 'That time has passed: pick a later one, or start now.' });
    expect(triggerFromForm('after', '', '', now)).toEqual({ error: 'Pick the task whose step it waits for.' });
  });
});

describe('defaultAtInput', () => {
  it('is the next half hour at least 10 minutes ahead', () => {
    expect(defaultAtInput(new Date('2026-10-17T10:05:00Z'))).toBe('2026-10-17T10:30');
    expect(defaultAtInput(new Date('2026-10-17T10:25:00Z'))).toBe('2026-10-17T11:00');
    expect(defaultAtInput(new Date('2026-10-17T23:55:00Z'))).toBe('2026-10-18T00:30');
    expect(toLocalInput(now)).toBe('2026-10-17T10:00');
  });
});

describe('afterTaskOptions', () => {
  it('lists open tasks other than this one, the running ones first', () => {
    const runs = [
      { id: 'TASK-EAR-3', status: 'queued' as const, title: 'Third' },
      { id: 'TASK-EAR-1', status: 'running' as const, title: 'Self' },
      { id: 'TASK-EAR-2', status: 'completed' as const, title: 'Done' },
      { id: 'TASK-EAR-4', status: 'blocked' as const, title: 'TASK-EAR-4' },
    ];
    expect(afterTaskOptions(runs, 'TASK-EAR-1', new Set(['TASK-EAR-4']))).toEqual([
      { id: 'TASK-EAR-4', label: 'TASK-EAR-4 (running now)' },
      { id: 'TASK-EAR-3', label: 'TASK-EAR-3 · Third' },
    ]);
  });
});

describe('labels', () => {
  it('names the button and the confirm line after the trigger', () => {
    expect(runButtonLabel('now', 'codex', false)).toBe('Run with codex');
    expect(runButtonLabel('at', 'codex', false)).toBe('Queue with codex');
    expect(runButtonLabel('after', 'codex', true)).toBe('Starting…');
    expect(confirmLine({ role: 'dev', taskId: 'TASK-EAR-1', cli: 'claude', repos: ['api-gateway'], trigger: { kind: 'now' } })).toBe('Run dev on TASK-EAR-1 with claude in api-gateway');
    expect(confirmLine({ role: 'reviewer', taskId: 'TASK-EAR-1', cli: 'codex', repos: [], trigger: { kind: 'after', taskId: 'TASK-EAR-2', scope: 'step' } }))
      .toBe("Run reviewer on TASK-EAR-1 with codex after TASK-EAR-2's step ends");
    expect(confirmLine({ role: 'dev', taskId: 'TASK-EAR-1', cli: 'claude', repos: [], trigger: { kind: 'at', at: '2026-10-17T14:30:00.000Z' } })).toBe('Run dev on TASK-EAR-1 with claude at 10-17 14:30');
  });
  it('says what a queued item waits for, and why one could not start', () => {
    expect(queuedStatus(item())).toBe('TASK-EAR-1 dev: queued now, waiting for a free slot (2 of 2 running)');
    expect(queuedStatus(item({ state: 'starting' }))).toBe('TASK-EAR-1 dev: starting now');
    expect(queueFailedLine(item({ state: 'failed', reason: 'TASK ownership refused: held by run R1' }))).toBe('Queued TASK-EAR-1 dev could not start: TASK ownership refused: held by run R1');
    expect(queueItemLine(item({ state: 'failed', reason: 'missed' }))).toBe('TASK-EAR-1 dev · claude · now · failed: missed');
    expect(queueItemLine(item({ state: 'started', fired: "TASK-EAR-2's step succeeded", trigger: { kind: 'after', taskId: 'TASK-EAR-2', scope: 'step' } })))
      .toBe("TASK-EAR-1 dev · claude · after TASK-EAR-2's step ends · started (TASK-EAR-2's step succeeded)");
  });
});
