import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { INVALID_DEV_OUTPUT, makeOffice, makeRepoWorktree, VALID_DEV_OUTPUT, type OfficeFixture } from '../testing/officeFixture';
import { prepareWorkspace } from './cliAdapter';
import { commitMessage, StepGovernance } from './stepGovernance';
import { TaskLease } from './taskLease';
import type { OfficeLaunch } from '../../../shared/types';

// D5/D6/D8 against the real office scripts in a temp office root and throwaway repos:
// the lease for the whole step, validate -> enforce -> sync run by the dashboard (status.yaml
// written only by them), agent-commit detection, and the dashboard's own local commit.

const TASK = 'TASK-T-1';
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const readYaml = <T>(file: string) => yaml.load(fs.readFileSync(file, 'utf8')) as T;

interface Setup { office: OfficeFixture; repo: ReturnType<typeof makeRepoWorktree>; gov: StepGovernance; dir: string; launchDir: string; taskDir: string; cleanup(): void }

function setup(options: { leaseSeconds?: number } = {}): Setup {
  const office = makeOffice(options);
  const repo = makeRepoWorktree(TASK);
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-steps-'));
  const taskDir = office.task(TASK);
  const gov = new StepGovernance({ officeRoot: office.root, dir: launchDir });
  return { office, repo, gov, dir: launchDir, launchDir, taskDir, cleanup() { office.cleanup(); repo.cleanup(); fs.rmSync(launchDir, { recursive: true, force: true }); } };
}

const launch = (id: string, over: Partial<OfficeLaunch> = {}): OfficeLaunch => ({
  id, kind: 'task', key: TASK, label: `${TASK} dev`, role: 'dev', command: 'claude -p', cwd: '/w', startedAt: '2026-10-17T01:00:00Z',
  status: 'succeeded', exitCode: 0, finishedAt: '2026-10-17T01:05:00Z', log: '', truncated: false, cli: 'claude', progress: [], ...over,
});

async function startStep(s: Setup, id: string, cli: 'claude' | 'codex' = 'claude') {
  const record = await s.gov.begin({ launchId: id, taskId: TASK, role: 'dev', cli, model: cli === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-5-5', prompt: 'the dev prompt' });
  await s.gov.attachWorktrees(record, [{ repo: 'demo', path: s.repo.worktree, branch: s.repo.branch }]);
  return record;
}

const holder = (taskDir: string) => readYaml<{ holder: unknown; history: { ended_by: string; run_id: string }[] }>(path.join(taskDir, 'ownership.yaml'));

test('a valid output: the office scripts pass in order, status.yaml advances only through sync, the diff is committed on the task branch with trailers, the lease is released', async () => {
  const s = setup();
  try {
    const mainHead = g(s.repo.repo, 'rev-parse', 'main');
    const record = await startStep(s, 'L1');
    assert.equal(new TaskLease(s.office.root).holder(s.taskDir)?.runId, record.runId, 'the lease is held while the step runs');
    // The agent: its output YAML, a changed file, a new file, and files that must never be committed.
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'hello world\n');
    fs.writeFileSync(path.join(s.repo.worktree, 'new.txt'), 'new\n');
    fs.mkdirSync(path.join(s.repo.worktree, '.cache', 'go-build'), { recursive: true });
    fs.writeFileSync(path.join(s.repo.worktree, '.cache', 'go-build', 'x'), 'cache');
    fs.mkdirSync(path.join(s.repo.worktree, '.cursor'));
    fs.writeFileSync(path.join(s.repo.worktree, '.cursor', 'sandbox.json'), '{}');
    fs.writeFileSync(path.join(s.repo.worktree, 'ignored.log'), 'ignored');

    const result = await s.gov.finalize(launch('L1'));
    assert.equal(result.state, 'done');
    assert.equal(result.protocol.ok, true);
    assert.deepEqual(result.checks.map((c) => [c.name, c.status]), [['output', 'passed'], ['integrity', 'passed'], ['validate', 'passed'], ['enforce', 'passed'], ['sync', 'passed']]);
    assert.match(result.checks[4].command, /^ruby scripts\/sync-status-from-output\.rb TASK-T-1 dev /);
    assert.match(result.checks[4].detail, /Status synced: assigned -> in_review/);
    assert.equal(result.verified, true);
    assert.equal(result.agentCommits.ok, true);

    const status = readYaml<{ phase: string; current_agent: string; history: { agent: string }[]; last_synced_output: { file: string } }>(path.join(s.taskDir, 'status.yaml'));
    assert.equal(status.phase, 'in_review');
    assert.equal(status.current_agent, 'reviewer');
    assert.equal(status.history.at(-1)?.agent, 'dev', 'the history entry carries the role, never the CLI');
    assert.equal(status.last_synced_output.file, 'dev-output.yaml');

    const [commit] = result.commits;
    assert.equal(commit.status, 'committed');
    assert.equal(commit.sha, g(s.repo.worktree, 'rev-parse', 'HEAD'));
    assert.equal(g(s.repo.repo, 'rev-parse', s.repo.branch), commit.sha, 'committed on the task branch');
    assert.equal(g(s.repo.repo, 'rev-parse', 'main'), mainHead, 'the main checkout is untouched');
    assert.deepEqual(commit.files?.sort(), ['hello.txt', 'new.txt']);
    const message = g(s.repo.worktree, 'log', '-1', '--format=%B');
    assert.match(message, /^feat\(task-t-1\): Change hello\.txt greeting\.\n/);
    for (const trailer of ['Task: TASK-T-1', 'Role: dev', 'CLI: claude', 'Model: claude-opus-5-5', 'Launch-Id: L1', `Run-Id: ${record.runId}`]) assert.ok(message.includes(trailer), trailer);
    assert.equal(g(s.repo.worktree, 'log', '-1', '--format=%an <%ae>'), 'Fixture Operator <fixture@example.invalid>', "the operator's git identity");
    const left = g(s.repo.worktree, 'status', '--porcelain', '--untracked-files=all');
    assert.match(left, /\.cache\/go-build\/x/, '.cache stays uncommitted');
    assert.match(left, /\.cursor\/sandbox\.json/, '.cursor stays uncommitted');
    assert.doesNotMatch(g(s.repo.worktree, 'show', '--name-only', '--format=', 'HEAD'), /ignored\.log|\.cache|\.cursor/);

    // Evidence for what the step produced, under the step's run id.
    const evidence = readYaml<{ evidence: { id: string; run_id: string; type: string; repo_sha: string }[] }>(path.join(s.taskDir, 'evidence.yaml')).evidence;
    assert.deepEqual(evidence.map((e) => [e.id, e.run_id, e.type, e.repo_sha]), [[commit.evidenceId, record.runId, 'artifact', commit.sha]]);

    // Provenance in the office run record; the lease released.
    const run = readYaml<{ client: string; model_requested: string; outcome: { status: string; validation: string } }>(path.join(s.taskDir, 'run-records', `${record.runId}.yaml`));
    assert.equal(run.client, 'dashboard-claude');
    assert.equal(run.model_requested, 'claude-opus-5-5');
    assert.deepEqual(run.outcome.status, 'completed');
    assert.deepEqual(run.outcome.validation, 'passed');
    assert.equal(holder(s.taskDir).holder, null);
    assert.equal(holder(s.taskDir).history.at(-1)?.ended_by, 'released');
    assert.equal(result.lease.ok, true);
    assert.match(result.lease.text, /released/);
    const changed = Object.fromEntries(result.runsChanged.map((c) => [c.path, c.change]));
    assert.equal(changed['dev-output.yaml'], 'added');
    assert.equal(changed['status.yaml'], 'modified');
    assert.equal(changed['evidence.yaml'], 'added');
    // validate-yaml.rb still passes on everything the step left in the run.
    assert.doesNotThrow(() => execFileSync('ruby', ['validate-yaml.rb', TASK], { cwd: s.office.root, stdio: 'pipe' }));
    // A second finalize returns the stored result and does nothing again.
    assert.deepEqual(await s.gov.finalize(launch('L1')), result);
  } finally { s.cleanup(); }
});

test('with .cache/ and .cursor/ in info/exclude (as prepareWorkspace writes them) the diff is committed and they are not', async () => {
  // e2e 2026-10-17: `git add -A -- . ':(exclude).cache'` fails ("paths are ignored by one of
  // your .gitignore files: .cache") once .cache/ is ignored through info/exclude.
  const s = setup();
  try {
    prepareWorkspace('cursor-agent', { cwd: s.repo.worktree, writableDirs: [s.taskDir] });
    await startStep(s, 'L12');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'hello world\n');
    fs.writeFileSync(path.join(s.repo.worktree, '.cache', 'go-build', 'x'), 'cache');
    const result = await s.gov.finalize(launch('L12'));
    assert.equal(result.commits[0].status, 'committed', result.commits[0].text);
    assert.deepEqual(result.commits[0].files, ['hello.txt']);
    assert.doesNotMatch(g(s.repo.worktree, 'show', '--name-only', '--format=', 'HEAD'), /\.cache|\.cursor/);
  } finally { s.cleanup(); }
});

test('an invalid output stops at validate-yaml.rb with its output: enforce and sync never run, no commit, the diff stays, the lease is released', async () => {
  const s = setup();
  try {
    const head = g(s.repo.worktree, 'rev-parse', 'HEAD');
    const statusBefore = fs.readFileSync(path.join(s.taskDir, 'status.yaml'), 'utf8');
    await startStep(s, 'L2');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), INVALID_DEV_OUTPUT);
    fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'changed\n');
    const result = await s.gov.finalize(launch('L2'));
    assert.deepEqual(result.checks.map((c) => [c.name, c.status]), [['output', 'passed'], ['integrity', 'passed'], ['validate', 'failed'], ['enforce', 'skipped'], ['sync', 'skipped']]);
    assert.equal(result.checks[2].exitCode, 1);
    assert.match(result.checks[2].output ?? '', /next_action\.agent/);
    assert.match(result.checks[3].detail, /validate-yaml\.rb failed/);
    assert.equal(result.verified, false);
    assert.equal(result.commits[0].status, 'skipped');
    assert.match(result.commits[0].text, /verification failed.*uncommitted/);
    assert.equal(g(s.repo.worktree, 'rev-parse', 'HEAD'), head);
    assert.match(g(s.repo.worktree, 'status', '--porcelain'), /M hello\.txt/);
    assert.equal(fs.readFileSync(path.join(s.taskDir, 'status.yaml'), 'utf8'), statusBefore, 'status.yaml untouched: only sync (or enforce on failure) may write it');
    assert.equal(holder(s.taskDir).holder, null);
  } finally { s.cleanup(); }
});

test('no output written during the step: the output check fails and no script runs', async () => {
  const s = setup();
  try {
    // An output left by an earlier step is not this step's output.
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    await startStep(s, 'L3');
    const result = await s.gov.finalize(launch('L3'));
    assert.equal(result.checks[0].status, 'failed');
    assert.match(result.checks[0].detail, /dev-output\.yaml is unchanged since the step started/);
    assert.ok(result.checks.slice(1).every((c) => c.status === 'skipped'));
    assert.equal(result.commits[0].status, 'skipped');
    assert.equal(holder(s.taskDir).holder, null);
  } finally { s.cleanup(); }
});

test('an empty diff makes no commit and says so', async () => {
  const s = setup();
  try {
    const head = g(s.repo.worktree, 'rev-parse', 'HEAD');
    await startStep(s, 'L4');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    fs.mkdirSync(path.join(s.repo.worktree, '.cache'));
    fs.writeFileSync(path.join(s.repo.worktree, '.cache', 'only-cache'), 'x');
    const result = await s.gov.finalize(launch('L4'));
    assert.equal(result.verified, true);
    assert.equal(result.commits[0].status, 'empty');
    assert.match(result.commits[0].text, /no changes/i);
    assert.equal(g(s.repo.worktree, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.existsSync(path.join(s.taskDir, 'evidence.yaml')), false);
  } finally { s.cleanup(); }
});

test('an agent commit (HEAD moved) fails the step: no dashboard commit on top, the worktree is left as it is', async () => {
  const s = setup();
  try {
    await startStep(s, 'L5', 'codex');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'agent\n');
    g(s.repo.worktree, 'commit', '-qam', 'agent did this');
    const agentHead = g(s.repo.worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(s.repo.worktree, 'more.txt'), 'uncommitted\n');
    const result = await s.gov.finalize(launch('L5', { cli: 'codex' }));
    assert.equal(result.agentCommits.ok, false);
    assert.match(result.agentCommits.found[0].text, /agent did this/);
    assert.equal(result.commits[0].status, 'skipped');
    assert.match(result.commits[0].text, /agent commit/);
    assert.equal(g(s.repo.worktree, 'rev-parse', 'HEAD'), agentHead);
    assert.match(g(s.repo.worktree, 'status', '--porcelain', '--untracked-files=all'), /\?\? more\.txt/);
    assert.equal(holder(s.taskDir).holder, null);
    const run = readYaml<{ outcome: { status: string } }>(path.join(s.taskDir, 'run-records', `${result.runId}.yaml`));
    assert.equal(run.outcome.status, 'failed');
  } finally { s.cleanup(); }
});

test('a failed, stopped, timed-out or lost step runs no script, makes no commit and releases the lease', async () => {
  const endings: Partial<OfficeLaunch>[] = [
    { status: 'failed', exitCode: 1, failureReason: 'exit code 1' },
    { status: 'stopped', exitCode: 143 },
    { status: 'failed', exitCode: 143, failureReason: 'time limit of 30 min reached: the step was stopped' },
    { status: 'lost', exitCode: undefined, finishedAt: undefined },
  ];
  for (const [i, ending] of endings.entries()) {
    const s = setup();
    try {
      const id = `L6-${i}`;
      await startStep(s, id);
      fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
      fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'partial\n');
      const result = await s.gov.finalize(launch(id, ending));
      assert.equal(result.protocol.ok, false, String(ending.status));
      assert.ok(result.checks.every((c) => c.status === 'skipped'), String(ending.status));
      assert.equal(result.commits[0].status, 'skipped');
      assert.equal(holder(s.taskDir).holder, null, `${ending.status}: lease released`);
      assert.equal(readYaml<{ phase: string }>(path.join(s.taskDir, 'status.yaml')).phase, 'assigned');
    } finally { s.cleanup(); }
  }
});

test('a dashboard restart finalizes a step that ended while it was down and releases its lease', async () => {
  const s = setup();
  try {
    await startStep(s, 'L7');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    fs.writeFileSync(path.join(s.repo.worktree, 'hello.txt'), 'after restart\n');
    const restarted = new StepGovernance({ officeRoot: s.office.root, dir: s.launchDir });
    assert.equal(restarted.pending(TASK), true);
    assert.equal(restarted.view('L7')?.state, 'verifying');
    await restarted.tick({ get: (id) => (id === 'L7' ? launch('L7') : null) });
    assert.equal(restarted.view('L7')?.state, 'done');
    assert.equal(restarted.view('L7')?.commits[0].status, 'committed');
    assert.equal(restarted.pending(TASK), false);
    assert.equal(holder(s.taskDir).holder, null);
  } finally { s.cleanup(); }
});

test('a step whose lease was lost (lapsed and reclaimed by another run) runs no script, makes no commit and leaves the new holder alone', async () => {
  const s = setup({ leaseSeconds: 2 });
  try {
    await startStep(s, 'L8');
    fs.writeFileSync(path.join(s.taskDir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const other = await new TaskLease(s.office.root).acquire(s.taskDir, TASK, { runId: 'run-20261017T020000Z-TASK-T-1-dev-cccccc', agent: 'dev', reason: 'run-agent.sh' });
    const result = await s.gov.finalize(launch('L8'));
    assert.equal(result.lease.ok, false);
    assert.match(result.lease.text, /lost/i);
    assert.ok(result.checks.every((c) => c.status === 'skipped'));
    assert.equal(result.commits[0].status, 'skipped');
    assert.equal(new TaskLease(s.office.root).holder(s.taskDir)?.runId, other.runId);
  } finally { s.cleanup(); }
});

test('begin refuses a task another run holds, with the holder, before anything is recorded', async () => {
  const s = setup();
  try {
    await new TaskLease(s.office.root).acquire(s.taskDir, TASK, { runId: 'run-20261017T020000Z-TASK-T-1-dev-dddddd', agent: 'dev', reason: 'run-agent.sh dispatch' });
    await assert.rejects(s.gov.begin({ launchId: 'L9', taskId: TASK, role: 'dev', cli: 'claude', prompt: 'p' }), /held by run run-20261017T020000Z-TASK-T-1-dev-dddddd/);
    assert.equal(fs.existsSync(path.join(s.taskDir, 'run-records')), false);
    assert.equal(s.gov.pending(TASK), false);
  } finally { s.cleanup(); }
});

test('tick leaves a step between begin and its spawn alone; after a restart an orphan (never spawned) is finalized as lost and its lease released', async () => {
  const s = setup();
  try {
    const record = await startStep(s, 'L11');
    await s.gov.tick({ get: () => null });
    assert.equal(s.gov.view('L11')?.state, 'verifying', 'still starting: not taken for lost');
    assert.equal(new TaskLease(s.office.root).holder(s.taskDir)?.runId, record.runId);
    const restarted = new StepGovernance({ officeRoot: s.office.root, dir: s.launchDir });
    await restarted.tick({ get: () => null });
    assert.equal(restarted.view('L11')?.state, 'done');
    assert.match(restarted.view('L11')?.protocol.text ?? '', /lost/);
    assert.equal(holder(s.taskDir).holder, null);
  } finally { s.cleanup(); }
});

test('abort (the CLI never started) releases the lease and records why', async () => {
  const s = setup();
  try {
    const record = await startStep(s, 'L10');
    const result = await s.gov.abort(record, 'Could not start TASK-T-1 dev.');
    assert.equal(result.protocol.ok, false);
    assert.match(result.protocol.text, /did not start: Could not start/);
    assert.equal(holder(s.taskDir).holder, null);
    assert.equal(s.gov.view('L10')?.state, 'done');
  } finally { s.cleanup(); }
});

test('commitMessage: a conventional subject from the output summary (or kept when it is one), and the provenance trailers', () => {
  const base = { taskId: 'TASK-EAR-12', role: 'dev', cli: 'codex' as const, model: 'gpt-5.6-sol', launchId: 'L', runId: 'run-x' };
  const msg = commitMessage({ ...base, summary: 'Add the allowlist to audit logging.\nMore detail.' });
  assert.equal(msg.subject, 'feat(task-ear-12): Add the allowlist to audit logging.');
  assert.deepEqual(msg.trailers, ['Task: TASK-EAR-12', 'Role: dev', 'CLI: codex', 'Model: gpt-5.6-sol', 'Launch-Id: L', 'Run-Id: run-x']);
  assert.equal(commitMessage({ ...base, summary: 'fix(audit): drop slip ids from logs' }).subject, 'fix(audit): drop slip ids from logs');
  assert.equal(commitMessage({ ...base, role: 'debugger', summary: '' }).subject, 'fix(task-ear-12): debugger step');
  assert.equal(commitMessage({ ...base, role: 'devops', model: undefined, summary: 'x'.repeat(200) }).subject.length, 72);
  assert.ok(commitMessage({ ...base, model: undefined, summary: 's' }).trailers.includes('Model: CLI default'));
});
