import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareWorkspace } from './cliAdapter';
import {
  cleanupView, ensureWorktree, ensureWorktrees, listRepos, listWorktrees, planWorktree, proposeRepos, removeWorktree, WorktreeRegistry, type CleanupDeps, type WorktreeContext,
} from './worktrees';

// Every repository here is a throwaway under the OS temp dir: no test touches a real
// checkout under the workspace root.

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktrees-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd: string, file: string, content = file) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), content); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', file); };

/** A workspace root holding `repo` cloned from a bare origin with main (default) and staging. */
function workspace(repo = 'svc', task = 'TASK-T-1') {
  const root = tmp();
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'README.md');
  git(seed, 'branch', 'staging');
  const origin = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  git(ws, 'clone', '-q', origin, repo);
  const repoPath = path.join(ws, repo);
  const ctx: WorktreeContext = { workspaceRoot: ws, worktreesRoot: path.join(ws, '.worktrees'), task, registry: new WorktreeRegistry(path.join(ws, '.worktrees', '.registry.json')) };
  return { root, ws, origin, seed, repoPath, ctx };
}

const branches = (repo: string) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

const deps = (phase: string | undefined, running = false): CleanupDeps => ({ taskPhase: async () => phase, running: () => running });

test('repositories are the directories whose .git is a directory; read-only ones are flagged', () => {
  const ws = tmp();
  for (const name of ['svc', 'Games-Lab-Android']) { fs.mkdirSync(path.join(ws, name)); git(path.join(ws, name), 'init', '-q'); }
  fs.mkdirSync(path.join(ws, 'plain'));
  fs.mkdirSync(path.join(ws, 'linked'));
  fs.writeFileSync(path.join(ws, 'linked', '.git'), 'gitdir: /elsewhere\n');
  fs.mkdirSync(path.join(ws, '.worktrees'));
  assert.deepEqual(listRepos(ws).map((r) => [r.name, r.readOnly]), [['Games-Lab-Android', true], ['svc', false]]);
});

test('task.md proposals: explicit lines first, words and path segments, no partial names, read-only apart, base branch evidence', () => {
  const repos = ['slip-api', 'slip-contracts', 'slip-admin', 'Games-Labs-Wallet', 'Games-Lab-Android', 'api-gateway'].map((name) => ({ name, path: `/ws/${name}`, readOnly: name === 'Games-Lab-Android' }));
  const md = [
    '# TASK-VS-041',
    'Touches slip-contracts/proto/slip.proto and then the API.',
    'Compare with Games-Lab-Android (client flow).',
    '- Repo: `slip-api` (base: `main`)',
    'Not slip-api-vs035 and not slip-adminx, but /Users/x/GitHub/api-gateway/routes.go.',
    'Base branch: staging',
  ].join('\n');
  const { proposed, referenceOnly } = proposeRepos(md, repos);
  assert.deepEqual(proposed.map((p) => p.repo), ['slip-api', 'slip-contracts', 'api-gateway']);
  assert.deepEqual(proposed[0].base, { name: 'main', evidence: 'task.md line 4: - Repo: `slip-api` (base: `main`)' });
  assert.equal(proposed[1].base?.name, 'staging', 'no base on its own line: the "Base branch:" line');
  assert.deepEqual(proposed[1].evidence, ['line 2: Touches slip-contracts/proto/slip.proto and then the API.']);
  assert.deepEqual(referenceOnly.map((p) => p.repo), ['Games-Lab-Android']);
  assert.ok(!proposed.some((p) => p.repo === 'slip-admin'));
  assert.match(proposeRepos('- Type: reliability / bugfix (slip-api, Games-Labs-Wallet)', repos).proposed.map((p) => p.repo).join(), /slip-api,Games-Labs-Wallet/);
});

test('no worktree and no task branch: create task/<TASK> from origin\'s default branch, fetched first, with no upstream; then reuse', async () => {
  const { seed, origin, repoPath, ctx } = workspace();
  // A commit lands on origin after the clone: the server fetches before branching.
  commit(seed, 'later.txt');
  git(seed, 'push', '-q', origin, 'main');
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'create');
  assert.equal(plan.branch, 'task/TASK-T-1');
  assert.equal(plan.base, 'origin/main');
  assert.equal(plan.path, path.join(ctx.worktreesRoot, 'svc-TASK-T-1'));
  assert.deepEqual(plan.baseOptions?.map((o) => o.ref), ['origin/main']);
  assert.ok(!fs.existsSync(plan.path!), 'planning changes nothing');

  const made = await ensureWorktree(ctx, { repo: 'svc' });
  assert.match(made.note ?? '', /fetched origin\/main/);
  assert.ok(fs.existsSync(path.join(plan.path!, 'later.txt')), 'branched from the fetched origin/main');
  assert.equal(git(plan.path!, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'task/TASK-T-1');
  assert.throws(() => git(repoPath, 'config', 'branch.task/TASK-T-1.merge'), 'no upstream: the branch never tracks the base');
  assert.deepEqual({ ...made.record, at: '' }, {
    task: 'TASK-T-1', repo: 'svc', repoPath, path: plan.path, branch: 'task/TASK-T-1', base: 'origin/main', origin: 'created', branchCreated: true, at: '',
  });

  const again = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(again.action, 'reuse');
  assert.equal(again.origin, 'created');
  const reused = await ensureWorktree(ctx, { repo: 'svc' });
  assert.equal(reused.record.at, made.record.at, 'reuse leaves the record as it was');
});

test('the base comes from task.md when it names one, and the operator can override it', async () => {
  const { ctx } = workspace();
  ctx.taskMarkdown = '- Repo: `svc` (base: `staging`)';
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.base, 'origin/staging');
  assert.deepEqual(plan.baseOptions?.map((o) => o.ref), ['origin/staging', 'origin/main']);
  assert.match(plan.baseOptions![0].why, /task\.md line 1/);
  assert.equal((await planWorktree(ctx, { repo: 'svc', base: 'origin/main' })).base, 'origin/main');
  const missing = await planWorktree(ctx, { repo: 'svc', base: 'origin/nope' });
  assert.equal(missing.action, 'refuse');
  assert.match(missing.reason, /does not resolve/);
  assert.equal((await planWorktree(ctx, { repo: 'svc', base: '--upload-pack=x' })).action, 'refuse', 'nothing option-like reaches git');
});

test('a task branch that exists but is checked out nowhere gets a worktree added on it (the branch is not the dashboard\'s)', async () => {
  const { repoPath, ctx } = workspace();
  git(repoPath, 'branch', 'task/TASK-T-1-slug');
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'add');
  assert.equal(plan.branch, 'task/TASK-T-1-slug');
  const made = await ensureWorktree(ctx, { repo: 'svc' });
  assert.equal(made.record.origin, 'created');
  assert.equal(made.record.branchCreated, false);
  assert.equal(git(made.record.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'task/TASK-T-1-slug');
});

test('several task branches and none chosen: refused until the operator picks one', async () => {
  const { repoPath, ctx } = workspace();
  git(repoPath, 'branch', 'task/TASK-T-1-a');
  git(repoPath, 'branch', 'task/TASK-T-1-b');
  git(repoPath, 'branch', 'task/TASK-T-10', 'HEAD');
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'refuse');
  assert.deepEqual(plan.branches, ['task/TASK-T-1-a', 'task/TASK-T-1-b'], 'TASK-T-10 is another task');
  const chosen = await planWorktree(ctx, { repo: 'svc', branch: 'task/TASK-T-1-b' });
  assert.equal(chosen.action, 'add');
  assert.equal(chosen.branch, 'task/TASK-T-1-b');
  assert.equal((await planWorktree(ctx, { repo: 'svc', branch: 'feature/x' })).action, 'refuse', 'only task/<TASK> names');
  assert.equal((await planWorktree(ctx, { repo: 'svc', branch: 'task/TASK-T-1-new' })).action, 'create', 'a new task branch name creates it');
});

test('a worktree at the path that the dashboard did not create: never touched, used only on opt-in, recorded as adopted', async () => {
  const { repoPath, ctx } = workspace();
  const theirs = path.join(ctx.worktreesRoot, 'svc-TASK-T-1');
  git(repoPath, 'worktree', 'add', '-q', '-b', 'task/TASK-T-1-theirs', theirs);
  fs.writeFileSync(path.join(theirs, 'wip.txt'), 'their uncommitted work');
  const before = git(repoPath, 'worktree', 'list', '--porcelain');

  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'adopt');
  assert.equal(plan.needsOptIn, true);
  assert.equal(plan.path, theirs);
  assert.match(plan.reason, /did not create it and will never modify, move or remove it/);
  await assert.rejects(ensureWorktree(ctx, { repo: 'svc' }), /Opt in to use the existing worktree/);
  assert.equal(ctx.registry.list().length, 0);

  const adopted = await ensureWorktree(ctx, { repo: 'svc', adopt: true });
  assert.equal(adopted.record.origin, 'adopted');
  assert.equal(git(repoPath, 'worktree', 'list', '--porcelain'), before, 'git state unchanged');
  assert.equal(fs.readFileSync(path.join(theirs, 'wip.txt'), 'utf8'), 'their uncommitted work');
  const next = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(next.action, 'reuse');
  assert.equal(next.origin, 'adopted');
  // Never proposed for removal, and refused if asked.
  await assert.rejects(removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('done')), /adopted, not created/);
  assert.ok(fs.existsSync(theirs));
});

test('the task branch checked out in another lane\'s worktree elsewhere: shown with its path, adopt only', async () => {
  const { root, repoPath, ctx } = workspace();
  const lane = path.join(root, 'lane-wt');
  git(repoPath, 'worktree', 'add', '-q', '-b', 'task/TASK-T-1-lane', lane);
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'adopt');
  assert.equal(plan.path, lane);
  assert.equal(plan.branch, 'task/TASK-T-1-lane');
  assert.match(plan.reason, /already checked out in the worktree/);
});

test('a Run over several repositories creates nothing when any of them is refused or still needs the opt-in', async () => {
  // Found in the slice-2 E2E: a request whose second repository needed the opt-in had
  // already added the first repository's worktree before it was refused.
  const { ws, root, ctx } = workspace();
  git(ws, 'clone', '-q', path.join(root, 'origin.git'), 'lib');
  git(path.join(ws, 'lib'), 'worktree', 'add', '-q', '-b', 'task/TASK-T-1-lane', path.join(root, 'lane'));
  await assert.rejects(ensureWorktrees(ctx, [{ repo: 'svc' }, { repo: 'lib' }]), /lib: .*Opt in to use the existing worktree/);
  assert.ok(!fs.existsSync(path.join(ctx.worktreesRoot, 'svc-TASK-T-1')), 'svc was not created');
  assert.equal(ctx.registry.list().length, 0);
  await assert.rejects(ensureWorktrees(ctx, [{ repo: 'svc' }, { repo: 'nope' }]), /nope: nope is not a git repository/);
  assert.ok(!fs.existsSync(path.join(ctx.worktreesRoot, 'svc-TASK-T-1')));
  const done = await ensureWorktrees(ctx, [{ repo: 'svc' }, { repo: 'lib', adopt: true }]);
  assert.deepEqual(done.map((d) => [d.record.repo, d.record.origin]), [['svc', 'created'], ['lib', 'adopted']]);
});

test('the task branch checked out in the main checkout: refused with the reason', async () => {
  const { repoPath, ctx } = workspace();
  git(repoPath, 'checkout', '-q', '-b', 'task/TASK-T-1');
  const plan = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reason, /checked out in svc's main checkout/);
  await assert.rejects(ensureWorktree(ctx, { repo: 'svc' }), /main checkout/);
});

test('refusals: read-only, not a repository, a path that is not a worktree', async () => {
  const { ws, ctx } = workspace();
  fs.mkdirSync(path.join(ws, 'Games-Lab-Android'));
  git(path.join(ws, 'Games-Lab-Android'), 'init', '-q');
  const android = await planWorktree(ctx, { repo: 'Games-Lab-Android' });
  assert.equal(android.action, 'refuse');
  assert.match(android.reason, /read-only/);
  assert.equal((await planWorktree(ctx, { repo: '../etc' })).action, 'refuse');
  fs.mkdirSync(path.join(ctx.worktreesRoot, 'svc-TASK-T-1'), { recursive: true });
  const blocked = await planWorktree(ctx, { repo: 'svc' });
  assert.equal(blocked.action, 'refuse');
  assert.match(blocked.reason, /exists and is not a worktree of svc/);
});

test('dependency warnings: a Node project with no node_modules, a Go module', async () => {
  const { seed, origin, ctx } = workspace();
  commit(seed, 'package.json', '{}');
  commit(seed, 'go.mod', 'module x\n');
  git(seed, 'push', '-q', origin, 'main');
  const made = await ensureWorktree(ctx, { repo: 'svc' });
  assert.equal(made.plan.warnings.length, 2);
  assert.match(made.plan.warnings[0], /no node_modules/);
  assert.match(made.plan.warnings[1], /module cache/);
  fs.mkdirSync(path.join(made.record.path, 'node_modules'));
  const reuse = await planWorktree(ctx, { repo: 'svc' });
  assert.deepEqual(reuse.warnings.map((w) => /node_modules/.test(w)), [false], 'installed: only the Go note stays');
});

test('cleanup: removable only when the task is closed, nothing runs, the branch is merged or pushed, and the worktree is clean', async () => {
  const { repoPath, ctx } = workspace();
  const { record } = await ensureWorktree(ctx, { repo: 'svc' });
  // The step files (.cache/, .cursor/) are excluded through info/exclude and do not block removal.
  prepareWorkspace('cursor-agent', { cwd: record.path, writableDirs: ['/office/runs/TASK-T-1'] });

  const open = await cleanupView(record, deps('in_review'));
  assert.equal(open.removable, false);
  assert.deepEqual(open.checks.filter((c) => !c.ok).map((c) => c.text), ['TASK-T-1 is in_review: not done or aborted']);
  assert.equal((await cleanupView(record, deps('done', true))).removable, false, 'a running step blocks it');
  await assert.rejects(removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('in_review')), /Not removable: TASK-T-1 is in_review/);

  fs.writeFileSync(path.join(record.path, 'new.txt'), 'x');
  const dirty = await cleanupView(record, deps('done'));
  assert.deepEqual(dirty.checks.filter((c) => !c.ok).map((c) => c.text), ['1 uncommitted or untracked file in the worktree']);
  fs.rmSync(path.join(record.path, 'new.txt'));

  const ready = await cleanupView(record, deps('aborted'));
  assert.equal(ready.removable, true);
  assert.equal(ready.action, 'remove');
  assert.equal(ready.canDeleteBranch, true, 'created by the dashboard and merged (no commits beyond the base)');
  const result = await removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('aborted'));
  assert.equal(result.removed, true);
  assert.equal(result.branchDeleted, false, 'the branch stays unless deletion is confirmed too');
  assert.ok(!fs.existsSync(record.path));
  assert.ok(branches(repoPath).includes('task/TASK-T-1'));
  assert.equal(ctx.registry.list().length, 0);
});

test('cleanup: a pushed but unmerged branch is removable, its branch is never deletable; a merged created branch is, on request', async () => {
  const { repoPath, origin, ctx } = workspace();
  const { record } = await ensureWorktree(ctx, { repo: 'svc' });
  commit(record.path, 'work.txt');
  const unpushed = await cleanupView(record, deps('done'));
  assert.match(unpushed.checks.find((c) => !c.ok)?.text ?? '', /neither merged into origin\/main nor pushed to origin\/task\/TASK-T-1/);
  git(record.path, 'push', '-q', origin, 'task/TASK-T-1');
  git(repoPath, 'fetch', '-q', 'origin');
  const pushed = await cleanupView(record, deps('done'));
  assert.equal(pushed.removable, true);
  assert.match(pushed.checks.map((c) => c.text).join(), /pushed to origin\/task\/TASK-T-1/);
  assert.equal(pushed.canDeleteBranch, false);
  await assert.rejects(removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('done'), true), /cannot be deleted from here/);
  assert.ok(fs.existsSync(record.path), 'a refused request removes nothing');

  // Merged into the base on origin: now the dashboard's own branch may go too, when asked.
  git(record.path, 'push', '-q', origin, 'task/TASK-T-1:main');
  git(repoPath, 'fetch', '-q', 'origin');
  const result = await removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('done'), true);
  assert.deepEqual([result.removed, result.branchDeleted], [true, true]);
  assert.ok(!branches(repoPath).includes('task/TASK-T-1'));
});

test('cleanup: an edited tracked file blocks removal, and the record stays', async () => {
  const { ctx } = workspace();
  const { record } = await ensureWorktree(ctx, { repo: 'svc' });
  fs.writeFileSync(path.join(record.path, 'README.md'), 'edited');
  await assert.rejects(removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('done')), /uncommitted or untracked/);
  assert.ok(fs.existsSync(record.path));
  assert.equal(ctx.registry.list().length, 1);
});

test('cleanup: removal runs git worktree remove without --force, so git\'s own refusal (a locked worktree) stands', async () => {
  const { repoPath, ctx } = workspace();
  const { record } = await ensureWorktree(ctx, { repo: 'svc' });
  git(repoPath, 'worktree', 'lock', record.path);
  assert.equal((await cleanupView(record, deps('done'))).removable, true, 'the dashboard\'s own checks pass');
  await assert.rejects(removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('done')), /locked/);
  assert.ok(fs.existsSync(record.path));
  assert.equal(ctx.registry.list().length, 1, 'still recorded');
});

test('cleanup: a worktree removed outside the dashboard is only forgotten', async () => {
  const { repoPath, ctx } = workspace();
  const { record } = await ensureWorktree(ctx, { repo: 'svc' });
  git(repoPath, 'worktree', 'remove', record.path);
  const view = await cleanupView(record, deps('in_review'));
  assert.deepEqual([view.exists, view.action, view.removable], [false, 'forget', true]);
  const result = await removeWorktree(ctx.registry, 'TASK-T-1', 'svc', deps('in_review'));
  assert.deepEqual([result.removed, result.forgot], [false, true]);
  assert.equal(ctx.registry.list().length, 0);
  assert.deepEqual((await listWorktrees(repoPath)).length, 1);
});
