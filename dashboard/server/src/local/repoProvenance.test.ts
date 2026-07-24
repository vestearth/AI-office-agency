import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureProvenance, classifyScope, resolveAllowedRepos } from './repoProvenance';

test('captureProvenance records branch/sha/dirty via injected git, never mutating', () => {
  const calls: string[][] = [];
  const runGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
    if (args[0] === 'rev-parse') return 'deadbeef';
    if (args[0] === 'status') return ' M file.ts\n'; // dirty
    throw new Error('unexpected git ' + args.join(' '));
  };
  const p = captureProvenance('/repos/Games-Labs-Wallet', runGit, () => 1700, 'central-1');
  assert.equal(p.branch, 'main');
  assert.equal(p.sha, 'deadbeef');
  assert.equal(p.dirty, true);
  assert.equal(p.machine, 'central-1');
  assert.equal(p.capturedAt, 1700);
  assert.equal(p.repo, '/repos/Games-Labs-Wallet');
  // Only rev-parse/status ever invoked — never pull/fetch/reset/checkout.
  for (const args of calls) {
    assert.ok(args[0] === 'rev-parse' || args[0] === 'status', 'unexpected git subcommand: ' + args[0]);
  }
});

test('captureProvenance reports clean when status is empty', () => {
  const runGit = (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature/x';
    if (args[0] === 'rev-parse') return 'cafef00d';
    if (args[0] === 'status') return '';
    throw new Error('unexpected git ' + args.join(' '));
  };
  const p = captureProvenance('/repos/Games-Labs-Missions', runGit, () => 42, 'local-2');
  assert.equal(p.dirty, false);
  assert.equal(p.branch, 'feature/x');
  assert.equal(p.sha, 'cafef00d');
});

test('ambiguous/empty scope stops at needs_scope_review with no repos', () => {
  const allow = [
    { name: 'Games-Labs-Wallet', path: '/r/w' },
    { name: 'Games-Labs-Missions', path: '/r/m' },
  ];
  assert.deepEqual(classifyScope({ product_hint: null } as any, allow), { repos: [], needsScopeReview: true });
  assert.deepEqual(classifyScope({ product_hint: 'wallet' } as any, allow), {
    repos: ['Games-Labs-Wallet'],
    needsScopeReview: false,
  });
  // tester text naming a repo NOT in the allowlist cannot add it
  assert.deepEqual(classifyScope({ product_hint: 'some-other-service' } as any, allow), {
    repos: [],
    needsScopeReview: true,
  });
});

test('ambiguous scope: hint matching multiple allowlisted repos stops at needs_scope_review', () => {
  const allow = [
    { name: 'Games-Labs-Wallet', path: '/r/w' },
    { name: 'Games-Labs-Wallet-Admin', path: '/r/wa' },
  ];
  // "wallet" is a substring of both names -> ambiguous, never a partial best-guess.
  assert.deepEqual(classifyScope({ product_hint: 'wallet' } as any, allow), { repos: [], needsScopeReview: true });
});

test('resolveAllowedRepos returns exactly the configured allowlist, nothing more', () => {
  const allow = [{ name: 'Games-Labs-Wallet', path: '/r/w' }];
  assert.deepEqual(resolveAllowedRepos(allow), allow);
  assert.deepEqual(resolveAllowedRepos([]), []);
});
