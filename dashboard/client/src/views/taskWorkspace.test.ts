import { describe, expect, it } from 'vitest';
import type { WorktreePlan, WorktreeTarget } from '../../../shared/types';
import { cleanupSummary, makePrimary, planLabel, runBlockers, targetsFromPlans } from './taskWorkspace';

const plan = (repo: string, action: WorktreePlan['action'], more: Partial<WorktreePlan> = {}): WorktreePlan => ({ repo, action, reason: `${repo} ${action}`, warnings: [], ...more });

describe('Run › repositories', () => {
  it('a Run with no confirmed repository is refused with the reason', () => {
    expect(runBlockers([], [])).toEqual(['Confirm at least one target repository: a Run works in a task worktree.']);
  });

  it('a refused plan, or an existing worktree without the opt-in, blocks the Run with its reason', () => {
    const targets: WorktreeTarget[] = [{ repo: 'a' }, { repo: 'b' }, { repo: 'c' }];
    const plans = [plan('a', 'create'), plan('b', 'refuse', { reason: 'b is checked out in the main checkout' }), plan('c', 'adopt', { needsOptIn: true })];
    expect(runBlockers(targets, plans)).toEqual([
      'b: b is checked out in the main checkout',
      'c: tick "Use the existing worktree" to run in a worktree the dashboard did not create.',
    ]);
    expect(runBlockers([{ repo: 'a' }], [plan('a', 'adopt', { needsOptIn: false })])).toEqual([]);
  });

  it('plans that are still loading (or for another list) block the Run until they match', () => {
    expect(runBlockers([{ repo: 'a' }, { repo: 'b' }], [plan('a', 'create')])).toEqual(['Checking the worktrees…']);
  });

  it('the primary repository is the first; making another primary moves it to the front', () => {
    expect(makePrimary([{ repo: 'a' }, { repo: 'b', base: 'origin/x' }, { repo: 'c' }], 'b')).toEqual([{ repo: 'b', base: 'origin/x' }, { repo: 'a' }, { repo: 'c' }]);
  });

  it('the proposed list starts from the plans, with no overrides', () => {
    expect(targetsFromPlans([plan('a', 'create'), plan('b', 'reuse')])).toEqual([{ repo: 'a' }, { repo: 'b' }]);
  });

  it('labels say what a Run will do in the worktree', () => {
    expect(planLabel(plan('a', 'create'))).toBe('new branch + worktree');
    expect(planLabel(plan('a', 'add'))).toBe('worktree on the existing branch');
    expect(planLabel(plan('a', 'reuse', { origin: 'created' }))).toBe('reuse (created by the dashboard)');
    expect(planLabel(plan('a', 'reuse', { origin: 'adopted' }))).toBe('reuse (adopted)');
    expect(planLabel(plan('a', 'adopt'))).toBe('existing worktree, not the dashboard\'s');
    expect(planLabel(plan('a', 'refuse'))).toBe('cannot run here');
  });
});

describe('Task worktrees (cleanup)', () => {
  it('summarises why a worktree is or is not removable', () => {
    expect(cleanupSummary({ removable: true, action: 'remove', checks: [{ ok: true, text: 'x' }] })).toBe('removable');
    expect(cleanupSummary({ removable: true, action: 'forget', checks: [] })).toBe('already gone: forget the record');
    expect(cleanupSummary({ removable: false, checks: [{ ok: true, text: 'ok' }, { ok: false, text: 'TASK-1 is in_review' }, { ok: false, text: '2 untracked files' }] }))
      .toBe('kept: TASK-1 is in_review; 2 untracked files');
  });
});
