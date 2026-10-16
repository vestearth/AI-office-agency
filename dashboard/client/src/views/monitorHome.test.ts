import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../shared/types';
import { monitorHome } from './monitorDetail';

const run = (id: string, over: Partial<RunSummary>): RunSummary => ({ id, title: id, status: 'running', runPath: `runs/${id}`, ...over });

describe('Monitor home: Recently updated', () => {
  it('orders by the time each row shows (the last hand-off), not by the date-only updated_at', () => {
    // 2026-10-17: TASK-VS-031 handed off at 19:19Z but wrote updated_at as that UTC date,
    // so it sat below TASK-VS-039 (18:54Z, updated_at written as the next local date).
    const runs = [
      run('TASK-VS-039', { updatedAt: '2026-10-17', lastHandoffAt: '2026-10-16T18:54:45Z' }),
      run('TASK-VS-031', { updatedAt: '2026-10-16', lastHandoffAt: '2026-10-16T19:19:49Z', status: 'completed' }),
      run('TASK-VS-040', { updatedAt: '2026-10-17', lastHandoffAt: '2026-10-16T19:19:34Z' }),
      run('TASK-VS-035', { updatedAt: '2026-10-16', lastHandoffAt: '2026-10-16T12:26:08Z', status: 'completed' }),
    ];
    expect(monitorHome(runs, new Map()).recent.map((r) => r.id)).toEqual(['TASK-VS-031', 'TASK-VS-040', 'TASK-VS-039', 'TASK-VS-035']);
  });

  it('a run with only a date ranks at the start of that day among timed runs', () => {
    const runs = [
      run('TASK-A', { updatedAt: '2026-10-15', lastHandoffAt: '2026-10-15T09:00:00Z' }),
      run('TASK-B', { updatedAt: '2026-10-16' }),
      run('TASK-C', { updatedAt: '2026-10-16', lastHandoffAt: '2026-10-16T03:00:00Z' }),
      run('TASK-D', {}),
    ];
    expect(monitorHome(runs, new Map()).recent.map((r) => r.id)).toEqual(['TASK-C', 'TASK-B', 'TASK-A']);
  });
});
