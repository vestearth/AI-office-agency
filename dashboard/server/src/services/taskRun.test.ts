import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets, runEnvelope } from './taskRun';
import type { WorktreeRecord } from './worktrees';

const record = (repo: string, origin: 'created' | 'adopted'): WorktreeRecord => ({
  task: 'TASK-1', repo, repoPath: `/ws/${repo}`, path: `/ws/.worktrees/${repo}-TASK-1`, branch: 'task/TASK-1', origin, branchCreated: origin === 'created', at: '2026-10-17T00:00:00.000Z',
});

test('a Run runs in the primary worktree; the other worktrees, then runs/<TASK>, are the extra writable dirs', () => {
  const env = runEnvelope('claude', [record('slip-api', 'created'), record('slip-contracts', 'adopted')], '/ws/ai-dev-office/runs/TASK-1', 'm');
  assert.deepEqual(env, {
    cwd: '/ws/.worktrees/slip-api-TASK-1', writableDirs: ['/ws/.worktrees/slip-contracts-TASK-1', '/ws/ai-dev-office/runs/TASK-1'], model: 'm', trustWorkspace: false,
  });
});

test('cursor-agent --trust only when the primary worktree is one the dashboard created, never an adopted one', () => {
  assert.equal(runEnvelope('cursor-agent', [record('svc', 'created')], '/r').trustWorkspace, true);
  assert.equal(runEnvelope('cursor-agent', [record('svc', 'adopted')], '/r').trustWorkspace, false);
  assert.equal(runEnvelope('codex', [record('svc', 'created')], '/r').trustWorkspace, false, 'only cursor-agent has --trust');
});

test('no confirmed repository: no envelope, with the reason', () => {
  assert.throws(() => runEnvelope('claude', [], '/r'), /Confirm at least one target repository/);
});

test('targets from the request: repo names only, optional branch/base/adopt, no duplicates, at most 8', () => {
  assert.deepEqual(parseTargets({ repos: [{ repo: 'slip-api', base: 'origin/main' }, { repo: 'slip-contracts', adopt: true, branch: 'task/TASK-1-x' }] }), [
    { repo: 'slip-api', base: 'origin/main' }, { repo: 'slip-contracts', adopt: true, branch: 'task/TASK-1-x' },
  ]);
  assert.deepEqual(parseTargets({}), []);
  assert.deepEqual(parseTargets({ repos: [{ repo: 'svc', base: '' }] }), [{ repo: 'svc' }], 'an empty override is no override');
  for (const bad of [{ repos: 'svc' }, { repos: [{ repo: '../x' }] }, { repos: [{ repo: 'a' }, { repo: 'a' }] }, { repos: [{ repo: 'a', adopt: 'yes' }] },
    { repos: Array.from({ length: 9 }, (_, i) => ({ repo: `r${i}` })) }, { repos: [{ repo: 'a', base: '-x' }] }]) {
    assert.ok('error' in (parseTargets(bad) as object), JSON.stringify(bad));
  }
});
