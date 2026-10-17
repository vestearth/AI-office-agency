import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import type { OfficeLaunch, RunQueueItem, TaskStepResult } from '../../../shared/types';
import { stepArgs } from './cliAdapter';
import {
  allowedPrefixes, gatesLine, NewTaskError, NewTaskFlow, NewTaskRefusedError, NewTasks, nextTaskId, openTaskArgs, parseNewTask, readPresets,
  TaskIdClaimer, type NewTaskFlowDeps, type NewTaskInput, type OpenTaskRunner,
} from './newTask';
import { ruby, type ScriptResult } from './officeScripts';
import { newTaskPmPrompt } from './taskPrompt';
import { runsOnlyEnvelope } from './taskRun';
import { proposeRepos } from './worktrees';
import { StepGovernance } from './stepGovernance';
import { makeOffice, REAL_OFFICE } from '../testing/officeFixture';

// New task (D11): id allocation, the claim with its race retry and refusals, the request
// validation, the queued runs-only pm step, and the stop for the operator's confirmation.
// Fakes for the queue, launches and open-task.rb; one integration test runs the real
// open-task.rb (and run-agent.sh intake for the id rule) in a throwaway office.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'new-task-'));
const ok = (stdout = ''): ScriptResult => ({ code: 0, stdout, stderr: '' });
const INPUT: NewTaskInput = { title: 'Add a thing', request: 'Please add the thing to api-gateway.', prefix: 'EAR', gates: { presets: ['staging'] } };

/** A fake office listing: runs/ and tasks/ entries the test controls. */
function listing(runs: string[], tasks: string[] = []) {
  const dirs = { runs: [...runs], tasks: [...tasks] };
  return { dirs, list: (dir: string) => (path.basename(dir) === 'runs' ? dirs.runs : path.basename(dir) === 'tasks' ? dirs.tasks : []) };
}

test('nextTaskId: max+1 for the prefix over runs/ and tasks/, three digits, malformed entries ignored', () => {
  const { list } = listing(
    ['TASK-EAR-007', 'TASK-EAR-12', 'TASK-EAR-099-old', 'TASK-EAR-x1', 'TASK-EARX-500', 'TASK-EA-300', 'task-ear-400', 'TASK-EAR-', 'README.md', 'TASK-KAS-050'],
    ['TASK-EAR-020'],
  );
  assert.equal(nextTaskId('/office', 'EAR', list), 'TASK-EAR-021');
  assert.equal(nextTaskId('/office', 'KAS', list), 'TASK-KAS-051');
  assert.equal(nextTaskId('/office', 'VS', list), 'TASK-VS-001');
  assert.equal(nextTaskId('/office', 'EAR', listing(['TASK-EAR-999']).list), 'TASK-EAR-1000');
  assert.equal(nextTaskId('/office', 'EAR', listing(['TASK-EAR-0042']).list), 'TASK-EAR-043');
  // No prefix: the legacy TASK-NNN pool only (prefixed ids are not in it).
  assert.equal(nextTaskId('/office', '', listing(['TASK-7', 'TASK-EAR-300', 'TASK-012']).list), 'TASK-013');
});

test('nextTaskId matches run-agent.sh intake in a real office (runs/ and tasks/, malformed dirs, files)', () => {
  const office = makeOffice();
  try {
    for (const d of ['TASK-EAR-003', 'TASK-EAR-041', 'TASK-EAR-077-old', 'TASK-EARX-900', 'TASK-VS-008']) fs.mkdirSync(path.join(office.runs, d));
    fs.writeFileSync(path.join(office.runs, 'TASK-EAR-500.txt'), '');
    fs.mkdirSync(path.join(office.root, 'tasks', 'TASK-EAR-060'), { recursive: true });
    for (const prefix of ['EAR', 'VS', 'KAS']) {
      const out = execFileSync('bash', [path.join(office.root, 'run-agent.sh'), 'intake', 'Add a thing'], {
        cwd: office.root, encoding: 'utf8', env: { ...process.env, OFFICE_TASK_PREFIX: prefix }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const intake = /^Task ID: (\S+)$/m.exec(out)?.[1];
      assert.ok(intake, out);
      assert.equal(nextTaskId(office.root, prefix), intake, `prefix ${prefix}`);
    }
    assert.equal(nextTaskId(office.root, 'EAR'), 'TASK-EAR-061');
  } finally { office.cleanup(); }
});

test('allowedPrefixes: registered, non-reserved prefixes; the dashboard prefix first and default; legacy pool only without a registry', () => {
  const registry = { EAR: 'Earth', KAS: 'Casper (project)', VS: 'VerifySlip (project)', GW: 'Event gateway (reserved)', PKG: 'x', OLD: '' };
  assert.deepEqual(allowedPrefixes(registry, 'VS'), { allowed: ['VS', 'EAR', 'KAS'], default: 'VS' });
  const unregistered = allowedPrefixes(registry, 'ZZ');
  assert.deepEqual([unregistered.allowed, unregistered.default], [['EAR', 'KAS', 'VS'], null]);
  assert.match(unregistered.note!, /ZZ is not registered/);
  assert.equal(allowedPrefixes(registry, 'GW').default, null);
  assert.deepEqual(allowedPrefixes({}, 'EAR'), { allowed: ['EAR'], default: 'EAR' });
  assert.deepEqual(allowedPrefixes({}, null).allowed, ['']);
});

test('parseNewTask: a preset or no gates with a reason, never both; prefixes and presets only from the offered lists', () => {
  const allowed = { prefixes: ['EAR', 'KAS'], presets: ['staging', 'production', 'train', 'backfill'] };
  const base = { title: '  Add a thing ', request: ' do it ', prefix: 'ear' };
  assert.deepEqual(parseNewTask({ ...base, presets: ['staging', 'backfill'] }, allowed), { title: 'Add a thing', request: 'do it', prefix: 'EAR', gates: { presets: ['staging', 'backfill'] } });
  assert.deepEqual(parseNewTask({ ...base, noGatesReason: ' docs only ' }, allowed), { title: 'Add a thing', request: 'do it', prefix: 'EAR', gates: { none: 'docs only' } });
  const err = (body: unknown) => { const r = parseNewTask(body, allowed); assert.ok('error' in r, JSON.stringify(r)); return r.error; };
  assert.match(err({ ...base, presets: ['staging'], noGatesReason: 'x' }), /not both/);
  assert.match(err(base), /preset, or no gates with the reason/);
  assert.match(err({ ...base, presets: [] }), /preset, or no gates/);
  assert.match(err({ ...base, noGatesReason: '   ' }), /preset, or no gates/);
  assert.match(err({ ...base, noGatesReason: 'two\nlines' }), /one line/);
  assert.match(err({ ...base, presets: ['staging', 'nightly'] }), /Unknown gate preset: nightly/);
  assert.match(err({ ...base, presets: ['staging', 'staging'] }), /twice/);
  assert.match(err({ ...base, prefix: 'GW', presets: ['staging'] }), /GW is reserved/);
  assert.match(err({ ...base, prefix: 'VS', presets: ['staging'] }), /VS is not one you may open/);
  assert.match(err({ ...base, title: '', presets: ['staging'] }), /Title is required/);
  assert.match(err({ ...base, title: 'a\nb', presets: ['staging'] }), /one line/);
  assert.match(err({ ...base, request: '', presets: ['staging'] }), /Describe the request/);
  assert.match(err({ ...base, request: 'x'.repeat(4001), presets: ['staging'] }), /at most 4,000/);
});

test('openTaskArgs: the id, title, request as the placeholder description, pm assigned, then the gate decision', () => {
  assert.deepEqual(openTaskArgs('TASK-EAR-5', { ...INPUT, gates: { presets: ['staging', 'backfill'] } }),
    ['TASK-EAR-5', '--title', 'Add a thing', '--description', 'Please add the thing to api-gateway.', '--agent', 'pm', '--actor', 'pm', '--preset', 'staging', '--preset', 'backfill']);
  assert.deepEqual(openTaskArgs('TASK-EAR-5', { ...INPUT, gates: { none: 'docs only' } }).slice(-2), ['--no-gates', 'docs only']);
});

test('readPresets reads tasks/templates/gate-presets.yaml with each preset\'s gates', () => {
  const { presets, error } = readPresets(REAL_OFFICE);
  assert.equal(error, undefined);
  assert.deepEqual(presets.map((p) => p.name), ['staging', 'production', 'train', 'backfill']);
  assert.deepEqual(presets[0].gates, ['implementation_verification', 'deploy_staging', 'staging_acceptance']);
  assert.match(readPresets(tmp()).error!, /cannot read/);
});

test('claim: open-task.rb exit 4 (another lane took the id) retries with the next id; the attempts are recorded', async () => {
  const { dirs, list } = listing(['TASK-EAR-010']);
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  // Two other lanes claim 011 and 012 between our listing and our mkdir.
  const raced = new Set(['TASK-EAR-011', 'TASK-EAR-012']);
  const run: OpenTaskRunner = async (args, env) => {
    calls.push({ args, env });
    if (raced.has(args[0])) { dirs.runs.push(args[0]); return { code: 4, stdout: '', stderr: `${args[0]} already exists at /office/runs/${args[0]}; open a new id (run intake for the next one).\n` }; }
    dirs.runs.push(args[0]);
    return ok(`Opened ${args[0]} (pending, pm) with completion gates: implementation_verification\n`);
  };
  const claimer = new TaskIdClaimer({ officeRoot: '/office', run, list });
  const claim = await claimer.claim(INPUT);
  assert.equal(claim.taskId, 'TASK-EAR-013');
  assert.deepEqual(claim.attempts.map((a) => [a.taskId, a.exitCode]), [['TASK-EAR-011', 4], ['TASK-EAR-012', 4], ['TASK-EAR-013', 0]]);
  assert.match(claim.attempts[0].message, /already exists/);
  assert.deepEqual(calls[0].env, { OFFICE_TASK_PREFIX: 'EAR' });
});

test('claim: exit 4 with a listing that does not move still tries a higher id; bounded, then 409', async () => {
  const { list } = listing(['TASK-EAR-001']);
  const tried: string[] = [];
  const claimer = new TaskIdClaimer({ officeRoot: '/office', list, maxAttempts: 3, run: async (args) => { tried.push(args[0]); return { code: 4, stdout: '', stderr: 'exists' }; } });
  await assert.rejects(claimer.claim(INPUT), (err: unknown) => {
    assert.ok(err instanceof NewTaskError);
    assert.equal(err.status, 409);
    assert.match(err.message, /3 ids in a row were taken/);
    assert.equal(err.attempts.length, 3);
    return true;
  });
  assert.deepEqual(tried, ['TASK-EAR-002', 'TASK-EAR-003', 'TASK-EAR-004']);
});

test('claim: open-task.rb refusals surface with the script\'s message (1 namespace 403, 2 usage 400, 3 presets 500, 5 write 500), no retry', async () => {
  const cases: [number, number, string, RegExp][] = [
    [1, 403, '[ERROR] prefix ZZ is not registered\n', /namespace was refused \(open-task.rb exit 1\): \[ERROR\] prefix ZZ is not registered/],
    [2, 400, 'Usage: open-task.rb ...\n--title is required\n', /refused the arguments \(open-task.rb exit 2\)/],
    [3, 500, 'presets file x cannot be parsed\n', /presets file is unreadable or malformed .*cannot be parsed/],
    [5, 500, 'Could not open TASK-EAR-001: disk full. The task directory was removed.\n', /write failed .*disk full/],
  ];
  for (const [code, status, stderr, re] of cases) {
    let calls = 0;
    const claimer = new TaskIdClaimer({ officeRoot: '/office', list: listing([]).list, run: async () => { calls += 1; return { code, stdout: '', stderr }; } });
    await assert.rejects(claimer.claim(INPUT), (err: unknown) => {
      assert.ok(err instanceof NewTaskError);
      assert.equal(err.status, status);
      assert.match(err.message, re);
      return true;
    });
    assert.equal(calls, 1, `exit ${code} is not retried`);
  }
});

test('claim: claims are serialized inside the server (never two open-task.rb at once), each gets its own id', async () => {
  const { dirs, list } = listing([]);
  let running = 0; let most = 0;
  const run: OpenTaskRunner = async (args) => {
    running += 1; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    if (dirs.runs.includes(args[0])) { running -= 1; return { code: 4, stdout: '', stderr: 'exists' }; }
    dirs.runs.push(args[0]);
    running -= 1;
    return ok();
  };
  const claimer = new TaskIdClaimer({ officeRoot: '/office', run, list });
  const ids = (await Promise.all([claimer.claim(INPUT), claimer.claim(INPUT), claimer.claim(INPUT)])).map((c) => c.taskId);
  assert.deepEqual(ids, ['TASK-EAR-001', 'TASK-EAR-002', 'TASK-EAR-003']);
  assert.equal(most, 1);
});

// ---------------------------------------------------------------- the flow and its states

function harness(options: { usable?: boolean; writer?: NewTaskFlowDeps['writer']; refuseEnqueue?: string } = {}) {
  let clock = Date.parse('2026-10-17T10:00:00Z');
  const items = new Map<string, RunQueueItem>();
  const launches = new Map<string, OfficeLaunch>();
  const results = new Map<string, TaskStepResult>();
  const claims: NewTaskInput[] = [];
  let seq = 0;
  const queue: NewTaskFlowDeps['queue'] & { get(id: string): RunQueueItem | undefined } = {
    enqueue: (input) => {
      if (options.refuseEnqueue) throw new Error(options.refuseEnqueue);
      const item: RunQueueItem = { id: `q${++seq}`, kind: input.kind, key: input.key, label: input.label, enqueuedAt: new Date(clock).toISOString(), trigger: input.trigger, state: 'waiting', step: input.step };
      items.set(item.id, item);
      return item;
    },
    tick: async () => undefined,
    get: (id) => items.get(id),
    itemView: (id) => items.get(id),
  };
  const store = new NewTasks(path.join(tmp(), 'new-tasks.json'), { queue, launches: { get: (id) => launches.get(id) ?? null }, result: (id) => results.get(id), now: () => new Date(clock) });
  let next = 1;
  const flow = new NewTaskFlow({
    store, queue, launches: { get: (id) => launches.get(id) ?? null }, writer: options.writer ?? 'claude',
    usable: async () => (options.usable === false ? { usable: false, reason: 'not logged in' } : { usable: true }),
    options: async () => ({ prefixes: ['EAR'], presets: ['staging'] }),
    claimer: { claim: async (input) => { claims.push(input); const taskId = `TASK-EAR-${String(next++).padStart(3, '0')}`; return { taskId, attempts: [{ taskId, exitCode: 0, message: 'Opened' }], output: '' }; } },
  });
  const start = (itemId: string, status: OfficeLaunch['status'] = 'running') => {
    const item = items.get(itemId)!;
    const launchId = `L${itemId}`;
    items.set(itemId, { ...item, state: 'started', launchId, startedAt: new Date(clock).toISOString() });
    launches.set(launchId, { id: launchId, kind: 'task', key: item.key, label: item.label, command: 'claude', cwd: '/office/runs', startedAt: new Date(clock).toISOString(), status, log: '', truncated: false });
    return launchId;
  };
  const verify = (launchId: string, verified: boolean) => {
    launches.set(launchId, { ...launches.get(launchId)!, status: 'succeeded', finishedAt: new Date(clock).toISOString() });
    const check = (name: 'output' | 'validate', passed: boolean) => ({ name, command: `ruby ${name}`, status: passed ? 'passed' as const : 'failed' as const, detail: passed ? 'ok' : 'pm-output.yaml: task.id is missing' });
    results.set(launchId, {
      state: 'done', launchId, role: 'pm', cli: 'claude', protocol: { ok: true, text: 'exit 0' }, lease: { ok: true, text: 'released' },
      checks: verified ? [check('output', true), check('validate', true)] : [check('output', true), check('validate', false)], verified,
      agentCommits: { ok: true, text: 'no worktrees to check', found: [] }, commits: [], runsChanged: [],
    });
  };
  return { flow, store, items, launches, results, claims, start, verify, advance: (ms: number) => { clock += ms; } };
}

const BODY = { title: 'Add a thing', request: 'Please add the thing.', prefix: 'EAR', presets: ['staging'] };

test('create: claims the id, then queues one runs-only pm step on the chain writer CLI (claude) with no repos', async () => {
  const h = harness();
  const { task, attempts, launch } = await h.flow.create(BODY);
  assert.equal(task.taskId, 'TASK-EAR-001');
  assert.equal(attempts.length, 1);
  assert.equal(launch, null);
  const [item] = [...h.items.values()];
  assert.deepEqual([item.kind, item.key, item.trigger, item.step], ['task', 'TASK-EAR-001', { kind: 'now' }, { role: 'pm', cli: 'claude', repos: [], runsOnly: true }]);
  assert.equal(task.itemId, item.id);
  assert.deepEqual([task.state, task.pm.status, task.cli, task.request, task.gates], ['pm', 'queued', 'claude', 'Please add the thing.', { presets: ['staging'] }]);
});

test('create: nothing is claimed for an unusable request, an unusable pm CLI, or cursor-agent as the writer', async () => {
  const bad = harness();
  await assert.rejects(bad.flow.create({ ...BODY, presets: undefined }), (e: unknown) => e instanceof NewTaskError && e.status === 400 && /preset, or no gates/.test(e.message));
  const offline = harness({ usable: false });
  await assert.rejects(offline.flow.create(BODY), (e: unknown) => e instanceof NewTaskError && e.status === 400 && /claude cannot run the pm step: not logged in/.test(e.message));
  const cursor = harness({ writer: 'cursor-agent' });
  await assert.rejects(cursor.flow.create(BODY), (e: unknown) => e instanceof NewTaskError && /needs claude or codex/.test(e.message));
  assert.equal(bad.claims.length + offline.claims.length + cursor.claims.length, 0);
});

test('create: a pm step that cannot be queued leaves the task opened, failed with the reason', async () => {
  const h = harness({ refuseEnqueue: 'TASK-EAR-001 pm is already queued (q9, waiting); cancel it first.' });
  const { task } = await h.flow.create(BODY);
  assert.deepEqual([task.state, task.pm.status], ['pm-failed', 'not started']);
  assert.match(task.pm.text!, /could not be queued: TASK-EAR-001 pm is already queued/);
  assert.equal(h.claims.length, 1);
});

test('states: queued → running → verifying → review; no chain until the operator confirms task.md', async () => {
  const h = harness();
  const { task } = await h.flow.create(BODY);
  const id = task.taskId;
  assert.match(h.store.chainHold(id)!, /review its task.md and press Confirm and start chain/);
  assert.throws(() => h.store.confirm(id), (e: unknown) => e instanceof NewTaskRefusedError && /confirm once it is verified/.test(e.message));
  const launchId = h.start(task.itemId!);
  assert.deepEqual([h.store.view(id)!.state, h.store.view(id)!.pm.status, h.store.view(id)!.pm.launchId], ['pm', 'running', launchId]);
  h.launches.set(launchId, { ...h.launches.get(launchId)!, status: 'succeeded' });
  assert.equal(h.store.view(id)!.pm.status, 'verifying');
  h.verify(launchId, true);
  const review = h.store.view(id)!;
  assert.deepEqual([review.state, review.pm.status, review.pm.text], ['review', 'verified', 'verified · nothing to commit']);
  assert.deepEqual(h.store.open().map((t) => t.taskId), [id]);
  assert.ok(h.store.chainHold(id), 'still held while under review');
  const confirmed = h.store.confirm(id);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.confirmedAt, '2026-10-17T10:00:00.000Z');
  assert.equal(h.store.chainHold(id), null);
  assert.deepEqual(h.store.open(), [], 'a confirmed task leaves the New task list');
  // Launch records are pruned (10 per task): the verified outcome is kept on the record.
  h.launches.delete(launchId); h.results.delete(launchId); h.items.delete(task.itemId!);
  assert.deepEqual([h.store.view(id)!.pm.status, h.store.view(id)!.state], ['verified', 'confirmed']);
});

test('states: a pm step that fails verification is pm-failed with why; Redo queues another with the note; close only when nothing runs', async () => {
  const h = harness();
  const { task } = await h.flow.create(BODY);
  const id = task.taskId;
  assert.throws(() => h.store.close(id), (e: unknown) => e instanceof NewTaskRefusedError && /cancel it in the Run queue or stop it first/.test(e.message));
  await assert.rejects(h.flow.redo(id, 'again'), (e: unknown) => e instanceof NewTaskError && e.status === 409);
  h.verify(h.start(task.itemId!), false);
  const failed = h.store.view(id)!;
  assert.deepEqual([failed.state, failed.pm.status], ['pm-failed', 'failed']);
  assert.match(failed.pm.text!, /verification failed at validate: pm-output.yaml: task.id is missing/);
  assert.ok(h.store.chainHold(id), 'a failed pm step starts no chain either');
  const redo = await h.flow.redo(id, ' name the repo ');
  assert.deepEqual([redo.task.state, redo.task.pm.status, redo.task.itemIds.length], ['pm', 'queued', 2]);
  assert.deepEqual(h.items.get(redo.task.itemId!)!.step, { role: 'pm', cli: 'claude', repos: [], runsOnly: true, note: 'name the repo' });
  h.verify(h.start(redo.task.itemId!), false);
  const closed = h.store.close(id);
  assert.equal(closed.state, 'closed');
  assert.equal(h.store.chainHold(id), null, 'closed by the operator: the task is theirs again');
  assert.equal(h.store.chainHold('TASK-EAR-999'), null, 'a task not opened here is never held');
});

test('states: a pm item that could not start (lease held, task gone) is pm-failed with the queue reason', async () => {
  const h = harness();
  const { task } = await h.flow.create(BODY);
  h.items.set(task.itemId!, { ...h.items.get(task.itemId!)!, state: 'failed', reason: 'TASK ownership refused: held by run r1' });
  const v = h.store.view(task.taskId)!;
  assert.deepEqual([v.state, v.pm.status], ['pm-failed', 'not started']);
  assert.match(v.pm.text!, /could not start \(failed: TASK ownership refused/);
});

// ---------------------------------------------------------------- the pm step itself

test('runs-only envelope: runs/<TASK> is the working directory and the only writable one; cursor-agent is refused', () => {
  const env = runsOnlyEnvelope('claude', '/office/runs/TASK-EAR-001', 'claude-opus-5-5');
  assert.deepEqual(env, { cwd: '/office/runs/TASK-EAR-001', writableDirs: [], model: 'claude-opus-5-5' });
  const args = stepArgs('claude', env);
  assert.ok(!args.includes('--add-dir'));
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'claude-opus-5-5']);
  assert.ok(stepArgs('codex', runsOnlyEnvelope('codex', '/office/runs/TASK-EAR-001')).includes('/office/runs/TASK-EAR-001'));
  assert.throws(() => runsOnlyEnvelope('cursor-agent', '/office/runs/TASK-EAR-001'), /needs a task worktree/);
});

test('pm prompt: the request, the runs dir as the only writable place, task.md sections and Repo: lines the repository proposal reads', () => {
  const prompt = newTaskPmPrompt({
    taskId: 'TASK-EAR-001', title: 'Add a thing', workspaceRoot: '/ws', officeRoot: '/ws/ai-dev-office', request: 'Please add the thing to api-gateway.',
    gates: gatesLine({ presets: ['staging'] }), note: 'Name the base branch.',
  });
  assert.match(prompt, /^You are the `pm` lane of AI Dev Office task TASK-EAR-001: Add a thing\./);
  assert.match(prompt, /Your working directory is the task artifacts directory \/ws\/ai-dev-office\/runs\/TASK-EAR-001\/: the only place you write\./);
  assert.match(prompt, /completion gates were decided then: gate presets staging\./);
  for (const section of ['## Problem', '## Scope', '## Acceptance criteria', '## Target repositories', '## Plan', '## Risks and open questions']) assert.ok(prompt.includes(section), section);
  assert.match(prompt, /exactly `Repo: <name>`/);
  assert.match(prompt, /Write \/ws\/ai-dev-office\/runs\/TASK-EAR-001\/pm-output.yaml to \/ws\/ai-dev-office\/schemas\/pm-output.schema.yaml/);
  assert.match(prompt, /Never commit, push, merge or deploy/);
  assert.match(prompt, /Operator request:\nPlease add the thing to api-gateway\.\nOperator note on the earlier task.md \(redo\): Name the base branch\.$/);
  assert.match(gatesLine({ none: 'docs only' }), /no completion gates \(docs only\)/);
});

test('a task.md in the shape the pm prompt asks for: Repo: lines are preselected, Reference only: is not', () => {
  const md = [
    '# TASK-EAR-001: Add a thing', '', '## Problem', 'Missing thing.', '', '## Target repositories',
    'Repo: api-gateway', 'Repo: shared-lib Base branch: develop', 'Reference only: Games-Labs-User', '',
  ].join('\n');
  const repos = ['api-gateway', 'shared-lib', 'Games-Labs-User'].map((name) => ({ name, path: `/ws/${name}`, readOnly: false }));
  const { proposed } = proposeRepos(md, repos);
  assert.deepEqual(proposed.filter((p) => p.preselected).map((p) => p.repo), ['api-gateway', 'shared-lib']);
  assert.equal(proposed.find((p) => p.repo === 'shared-lib')?.base?.name, 'develop');
  assert.equal(proposed.find((p) => p.repo === 'Games-Labs-User')?.preselected, false);
});

// ---------------------------------------------------------------- integration: the real open-task.rb

test('integration: the real open-task.rb claims max+1 in an office checkout, retries a lost race, and refuses a namespace', async () => {
  const office = makeOffice();
  try {
    fs.mkdirSync(path.join(office.runs, 'TASK-EAR-004'));
    fs.mkdirSync(path.join(office.runs, 'TASK-EAR-009-draft'));
    const real: OpenTaskRunner = (args, env) => ruby(office.root, 'scripts/open-task.rb', args, { env });
    const claimer = new TaskIdClaimer({ officeRoot: office.root, run: real });
    const first = await claimer.claim(INPUT);
    assert.equal(first.taskId, 'TASK-EAR-005');
    assert.match(first.output, /^Opened TASK-EAR-005 \(pending, pm\) with completion gates: implementation_verification, deploy_staging, staging_acceptance/);
    const status = yaml.load(fs.readFileSync(path.join(office.runs, 'TASK-EAR-005', 'status.yaml'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([status.phase, status.current_agent, status.task_label], ['pending', 'pm', 'Add a thing']);
    assert.deepEqual(Object.keys(status.completion_gates as Record<string, unknown>), ['implementation_verification', 'deploy_staging', 'staging_acceptance']);
    assert.equal(fs.readFileSync(path.join(office.runs, 'TASK-EAR-005', 'task.md'), 'utf8'), '# TASK-EAR-005: Add a thing\n\nPlease add the thing to api-gateway.\n');

    // Another lane takes 006 between our listing and open-task.rb's mkdir: the real exit 4, then 007.
    let raced = false;
    const racing: OpenTaskRunner = (args, env) => {
      if (!raced) { raced = true; fs.mkdirSync(path.join(office.runs, args[0])); }
      return real(args, env);
    };
    const second = await new TaskIdClaimer({ officeRoot: office.root, run: racing }).claim({ ...INPUT, gates: { none: 'docs only' } });
    assert.deepEqual(second.attempts.map((a) => [a.taskId, a.exitCode]), [['TASK-EAR-006', 4], ['TASK-EAR-007', 0]]);
    assert.match(second.attempts[0].message, /TASK-EAR-006 already exists/);
    assert.deepEqual(fs.readdirSync(path.join(office.runs, 'TASK-EAR-006')), [], 'the other lane\'s directory is untouched');
    const opened = yaml.load(fs.readFileSync(path.join(office.runs, 'TASK-EAR-007', 'status.yaml'), 'utf8')) as Record<string, unknown>;
    assert.equal(opened.completion_gates, undefined);
    assert.match(JSON.stringify(opened.history), /opened without completion gates: docs only/);

    // A prefix office.team.yaml does not list: open-task.rb's namespace refusal (exit 1), surfaced as 403.
    await assert.rejects(claimer.claim({ ...INPUT, prefix: 'ZZQ' }), (err: unknown) => {
      assert.ok(err instanceof NewTaskError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Could not open TASK-ZZQ-001: the namespace was refused \(open-task.rb exit 1\): \[ERROR\] prefix ZZQ is not registered/);
      return true;
    });
    assert.ok(!fs.existsSync(path.join(office.runs, 'TASK-ZZQ-001')));
    // An unknown preset reaches open-task.rb as a usage error (exit 2), surfaced as 400.
    await assert.rejects(claimer.claim({ ...INPUT, gates: { presets: ['nightly'] } }), (err: unknown) => err instanceof NewTaskError && err.status === 400 && /exit 2/.test(err.message));
    // What it opened passes the office validator.
    const valid = await ruby(office.root, 'validate-yaml.rb', ['TASK-EAR-005']);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
  } finally { office.cleanup(); }
});

const PM_OUTPUT = (taskId: string) => `task:
  id: "${taskId}"
  title: "Add a thing"
  type: feature
  priority: medium
scope:
  target_services:
    - service: api-gateway
      reason: the route lives there
description: "Add the thing."
acceptance_criteria:
  - criterion: "the thing answers 200"
plan:
  approach: "One route."
assignment:
  primary: dev
  parallel: false
  reason: "single service"
summary: "Plan: add the thing to api-gateway."
artifacts:
  - path: runs/${taskId}/task.md
    action: modified
next_action:
  agent: dev
  reason: "Ready to implement."
blockers: []
`;

test('integration: a runs-only pm step on a task open-task.rb opened is verified by the real office scripts with no worktree and no commit, then waits for review', async () => {
  const office = makeOffice();
  const launchDir = tmp();
  try {
    const { taskId } = await new TaskIdClaimer({ officeRoot: office.root, run: (args, env) => ruby(office.root, 'scripts/open-task.rb', args, { env }) }).claim(INPUT);
    const gov = new StepGovernance({ officeRoot: office.root, dir: launchDir });
    // What launch.ts's runs-only branch does: lease and run record, no worktrees, the prompt hash.
    const record = await gov.begin({ launchId: 'P1', taskId, role: 'pm', cli: 'claude', model: 'claude-opus-5-5' });
    await gov.attachWorktrees(record, [], 'the new-task pm prompt');
    gov.markStarted(record);
    // The agent writes task.md and pm-output.yaml in runs/<TASK>, nothing else.
    const taskDir = path.join(office.runs, taskId);
    fs.writeFileSync(path.join(taskDir, 'task.md'), `# ${taskId}: Add a thing\n\n## Target repositories\nRepo: api-gateway\n`);
    fs.writeFileSync(path.join(taskDir, 'pm-output.yaml'), PM_OUTPUT(taskId));
    const result = await gov.finalize({
      id: 'P1', kind: 'task', key: taskId, label: `${taskId} pm`, role: 'pm', command: 'claude -p', cwd: taskDir, startedAt: '2026-10-17T01:00:00Z',
      status: 'succeeded', exitCode: 0, finishedAt: '2026-10-17T01:05:00Z', log: '', truncated: false, cli: 'claude', progress: [],
    });
    assert.deepEqual(result.checks.map((c) => [c.name, c.status]), [['output', 'passed'], ['integrity', 'passed'], ['validate', 'passed'], ['enforce', 'passed'], ['sync', 'passed']], JSON.stringify(result.checks));
    assert.equal(result.verified, true);
    assert.deepEqual(result.commits, []);
    assert.equal(result.agentCommits.ok, true);
    const status = yaml.load(fs.readFileSync(path.join(taskDir, 'status.yaml'), 'utf8')) as { current_agent: string };
    assert.equal(status.current_agent, 'dev');

    // The New task record over that step: review, and no chain until the operator confirms.
    const item: RunQueueItem = { id: 'q1', kind: 'task', key: taskId, label: `${taskId} pm`, enqueuedAt: '2026-10-17T01:00:00Z', trigger: { kind: 'now' }, state: 'started', launchId: 'P1', step: { role: 'pm', cli: 'claude', repos: [], runsOnly: true } };
    const store = new NewTasks(path.join(launchDir, 'new-tasks.json'), { queue: { get: () => item, itemView: () => item }, launches: { get: () => null }, result: (id) => gov.view(id) });
    store.add({ ...INPUT, taskId, cli: 'claude', attempts: [] });
    store.setPmStep(taskId, { itemId: 'q1' });
    assert.deepEqual([store.view(taskId)!.state, store.view(taskId)!.pm.text], ['review', 'verified · nothing to commit']);
    assert.ok(store.chainHold(taskId));
  } finally { office.cleanup(); fs.rmSync(launchDir, { recursive: true, force: true }); }
});
