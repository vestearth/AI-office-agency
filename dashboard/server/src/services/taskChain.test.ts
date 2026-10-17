import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChainStopKind, OfficeLaunch, StepCheck, TaskLaunchCli, TaskStepResult } from '../../../shared/types';
import type { NextStep } from './chainOffice';
import { RunQueue } from './runQueue';
import { TaskChains, stepOutcome, type ChainDeps } from './taskChain';
import { authorizationCheck, decideNextStep, reviewVerdict, taskHold } from './chainOffice';
import { makeOffice, VALID_DEV_OUTPUT } from '../testing/officeFixture';
import { chainPairingFrom } from '../config';

// Role chains over a real Run queue with fake launches, a fake clock and stubbed office
// answers (decide-next-step.rb, the authorization check, status.yaml): every step is a
// call, never a sleep. chainOffice.test.ts runs the real scripts.

const TASK = 'TASK-EAR-1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'task-chain-'));
const CHECKS: StepCheck['name'][] = ['output', 'integrity', 'validate', 'enforce', 'sync'];

function okResult(launchId: string, over: Partial<TaskStepResult> = {}): TaskStepResult {
  return {
    state: 'done', launchId, role: 'dev', cli: 'claude', protocol: { ok: true, text: "exit 0 with the CLI's final result event" }, lease: { ok: true, text: 'released' },
    checks: CHECKS.map((name) => ({ name, command: name, status: 'passed' as const, detail: 'ok' })), verified: true,
    agentCommits: { ok: true, text: 'no agent commit', found: [] },
    commits: [{ repo: 'demo', path: '/w/demo', branch: `task/${TASK}`, status: 'committed', sha: `${launchId}abcdef1234`, text: 'committed' }], runsChanged: [], ...over,
  };
}

interface HarnessOptions {
  dir?: string;
  cap?: number;
  chainCap?: number;
  /** decide-next-step.rb's answer after a role ran (default: the fixed phase map's next). */
  decide?: (role: string, n: number) => NextStep;
  authorize?: (role: string) => { ok: boolean; text: string };
  usable?: Partial<Record<TaskLaunchCli, { usable: boolean; reason?: string }>>;
  previousWriter?: TaskLaunchCli;
  refuseStart?: (role: string) => string | null;
  /** Real office answers instead of the stubs (the integration test). */
  override?: Partial<ChainDeps>;
}

const FIXED: Record<string, string> = { pm: 'dev', dev: 'reviewer', 'dev-2': 'reviewer', debugger: 'reviewer', devops: 'reviewer' };

function harness(opts: HarnessOptions = {}) {
  const dir = opts.dir ?? tmp();
  let clock = Date.parse('2026-10-17T10:00:00Z');
  const now = () => new Date(clock);
  const launchFile = path.join(dir, 'launches.json');
  const launches = new Map<string, OfficeLaunch>(fs.existsSync(launchFile) ? JSON.parse(fs.readFileSync(launchFile, 'utf8')) : []);
  const results = new Map<string, TaskStepResult>();
  const save = () => fs.writeFileSync(launchFile, JSON.stringify([...launches]));
  let hold: { kind: ChainStopKind; reason: string } | null = null;
  const verdicts: string[] = [];
  const decided: string[] = [];
  const stopped: string[] = [];
  let decideCalls = 0;
  let chainSeq = 0;
  let seq = launches.size;
  const latest = (key: string) => [...launches.values()].filter((l) => l.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))[0] ?? null;
  const running = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));
  const launchDeps = {
    get: (id: string) => launches.get(id) ?? null,
    latest,
    active: () => [...launches.values()].filter((l) => running(l)),
    stop: (id: string) => { const l = { ...launches.get(id)!, status: 'stopped' as const, finishedAt: now().toISOString() }; launches.set(id, l); stopped.push(id); save(); results.set(id, okResult(id, { protocol: { ok: false, text: 'stopped by the operator' }, verified: false })); return l; },
  };
  // eslint-disable-next-line prefer-const
  let chains: TaskChains;
  const queue = new RunQueue(path.join(dir, 'queue.json'), {
    cap: opts.cap ?? 2, now, newLaunchId: () => `L${++seq}`,
    launches: launchDeps,
    verifying: (id) => results.get(id)?.state === 'verifying',
    busy: (key) => (running(latest(key)) ? 'running' : null),
    start: async (item) => {
      const refused = opts.refuseStart?.(item.step!.role);
      if (refused) throw new Error(refused);
      const launch: OfficeLaunch = { id: item.launchId!, kind: 'task', key: item.key, label: item.label, role: item.step!.role, cli: item.step!.cli, command: 'fake', cwd: '/', startedAt: now().toISOString(), status: 'running', log: '', truncated: false };
      launches.set(launch.id, launch);
      save();
      return { launch };
    },
    chains: { get: (id) => chains.get(id), latest: (t) => chains.latest(t) },
  });
  const deps: ChainDeps = {
    queue, launches: launchDeps, now, newId: () => `chain-${++chainSeq}`,
    result: (id) => results.get(id),
    decide: async (taskId, role) => {
      decided.push(role);
      decideCalls++;
      return opts.decide ? opts.decide(role, decideCalls) : { next: role === 'reviewer' ? (verdicts[verdicts.length - 1] === 'approved' ? 'done' : 'debugger') : FIXED[role] ?? '', terminal: role === 'reviewer' && verdicts[verdicts.length - 1] === 'approved' };
    },
    authorize: async (_t, role) => opts.authorize?.(role) ?? { ok: true, text: 'no authorization needed' },
    hold: () => hold,
    verdict: () => verdicts[verdicts.length - 1],
    usable: async (cli) => opts.usable?.[cli] ?? { usable: true },
    model: (cli) => (cli === 'claude' ? 'claude-opus-5-5' : cli === 'codex' ? 'gpt-5.6-sol' : undefined),
    previousWriter: () => opts.previousWriter,
    defaults: { pairing: { writer: 'claude', reviewer: 'codex' }, cap: opts.chainCap ?? 6 },
    ...opts.override,
  };
  chains = new TaskChains(path.join(dir, 'chains.json'), deps);
  /** The newest launch of the task ends; its verification is `over` on the ok result. */
  const finish = (over: Partial<TaskStepResult> = {}, status: OfficeLaunch['status'] = 'succeeded', key = TASK) => {
    const l = latest(key)!;
    launches.set(l.id, { ...l, status, finishedAt: now().toISOString() });
    save();
    results.set(l.id, okResult(l.id, { role: l.role, cli: l.cli, ...over }));
    return l;
  };
  return {
    dir, queue, chains, launches, results, stopped, decided, finish,
    verdict: (v: string) => verdicts.push(v),
    setHold: (h: typeof hold) => { hold = h; },
    advance: (ms: number) => { clock += ms; },
    start: (role = 'dev', extra: Partial<Parameters<TaskChains['start']>[0]> = {}) => chains.start({ taskId: TASK, role, repos: [{ repo: 'demo' }], trigger: { kind: 'now' }, ...extra }),
    roles: () => chains.latest(TASK)!.steps.map((s) => `${s.role}:${s.cli}`),
    ended: () => chains.latest(TASK)!.ended,
  };
}

test('dev, then the reviewer on the other CLI, then done: the chain stops for the operator to close', async () => {
  const h = harness();
  const { chain, item } = await h.start('dev', { note: 'only the greeting' });
  assert.equal(item.state, 'started');
  assert.deepEqual([chain.steps[0].status, chain.steps[0].cli, chain.steps[0].model], ['running', 'claude', 'claude-opus-5-5']);
  assert.equal(h.queue.get(item.id)!.step!.note, 'only the greeting');
  h.finish();
  await h.chains.tick();
  assert.deepEqual(h.roles(), ['dev:claude', 'reviewer:codex']);
  const second = h.queue.get(h.chains.latest(TASK)!.steps[1].itemId)!;
  assert.equal(second.step!.note, undefined, 'the note is for the first step only');
  assert.deepEqual(second.chain, { id: chain.id, step: 2 });
  h.verdict('approved');
  h.finish();
  await h.chains.tick();
  const end = h.ended()!;
  assert.equal(end.kind, 'done');
  assert.match(end.reason, /reviewer approved; closing the task, merging, pushing and approving are yours/);
  const view = h.chains.view(chain.id)!;
  assert.equal(view.active, false);
  assert.deepEqual(view.steps.map((s) => [s.role, s.cli, s.model, s.status, s.verdict ?? '']), [
    ['dev', 'claude', 'claude-opus-5-5', 'verified', ''], ['reviewer', 'codex', 'gpt-5.6-sol', 'verified', 'approved'],
  ]);
  assert.match(view.steps[0].verification!, /^verified · committed demo L1abcdef12/);
  assert.equal(view.steps[0].commits[0].branch, `task/${TASK}`);
  assert.deepEqual(view.steps[1].decision, { next: 'done', terminal: true });
});

test('swapped pairing: codex writes and claude reviews', async () => {
  const h = harness();
  await h.start('dev', { pairing: { writer: 'codex', reviewer: 'claude' } });
  h.finish();
  await h.chains.tick();
  assert.deepEqual(h.roles(), ['dev:codex', 'reviewer:claude']);
});

test('the reviewer is never the CLI that wrote the step under review', async () => {
  const same = harness();
  await assert.rejects(same.start('dev', { pairing: { writer: 'codex', reviewer: 'codex' } }), /different CLI from the writer/);
  // A chain that starts at reviewer, after a dev step codex wrote outside the chain, with codex as the reviewer.
  const h = harness({ previousWriter: 'codex' });
  await assert.rejects(h.start('reviewer'), /the reviewer would run on codex, the CLI that wrote the step under review/);
  const swapped = harness({ previousWriter: 'codex' });
  const { chain } = await swapped.start('reviewer', { pairing: { writer: 'codex', reviewer: 'claude' } });
  assert.equal(chain.steps[0].cli, 'claude');
});

test('a failed, stopped or timed-out step stops the chain with the reason', async () => {
  for (const [status, text] of [['failed', 'failed: time limit of 30 min reached'], ['stopped', 'stopped by the operator'], ['lost', 'lost: the process ended without an exit code']] as const) {
    const h = harness();
    await h.start('dev');
    h.finish({ protocol: { ok: false, text }, verified: false }, status);
    await h.chains.tick();
    assert.equal(h.ended()!.kind, 'failed');
    assert.equal(h.ended()!.reason, `step 1 (dev with claude) ${text}`);
    assert.deepEqual(h.roles(), ['dev:claude']);
    assert.deepEqual(h.decided, [], 'no next step is decided after a failed one');
  }
});

test('failed verification (an unmet contract) stops the chain', async () => {
  const h = harness();
  await h.start('dev');
  const checks = CHECKS.map((name) => ({ name, command: name, status: (name === 'enforce' ? 'failed' : name === 'sync' ? 'skipped' : 'passed') as StepCheck['status'], detail: name === 'enforce' ? 'output contract failed: status.yaml set to validation_failed by the script' : 'ok' }));
  h.finish({ checks, verified: false });
  await h.chains.tick();
  assert.equal(h.ended()!.kind, 'verification');
  assert.match(h.ended()!.reason, /verification failed at enforce: output contract failed/);
  assert.equal(h.chains.view(h.chains.latest(TASK)!.id)!.steps[0].status, 'failed');
});

test('an agent commit or a failed dashboard commit stops the chain', async () => {
  const h = harness();
  await h.start('dev');
  h.finish({ agentCommits: { ok: false, text: 'HEAD moved in demo', found: [{ repo: 'demo', text: 'abc' }] }, commits: [] });
  await h.chains.tick();
  assert.equal(h.ended()!.kind, 'failed');
  assert.match(h.ended()!.reason, /an agent committed/);
});

test('the reviewer asking for changes a third time stops the chain', async () => {
  const h = harness({ chainCap: 10 });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  for (let round = 1; round <= 3; round++) {
    h.verdict('changes_requested'); h.finish(); await h.chains.tick();
    if (round < 3) { h.finish(); await h.chains.tick(); }
  }
  assert.deepEqual(h.roles(), ['dev:claude', 'reviewer:codex', 'debugger:claude', 'reviewer:codex', 'debugger:claude', 'reviewer:codex']);
  assert.equal(h.ended()!.kind, 'changes');
  assert.match(h.ended()!.reason, /asked for changes 3 times in this chain \(more than 2\)/);
});

test('the step cap stops the chain before the next step, naming it', async () => {
  const h = harness({ chainCap: 2 });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  h.verdict('changes_requested'); h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'cap');
  assert.equal(h.ended()!.reason, 'the chain ran its step cap (2 of 2); the next step would be debugger');
});

test('a completion gate that keeps the task from done stops the chain for a person', async () => {
  const h = harness({ decide: (role) => (role === 'reviewer' ? { next: '', terminal: false, note: 'Completion blocked: unresolved completion gate(s): staging_acceptance.' } : { next: 'reviewer', terminal: false }) });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  h.verdict('approved');
  const checks = CHECKS.map((name) => ({ name, command: name, status: 'passed' as const, detail: name === 'sync' ? 'completion blocked: status.yaml keeps its phase until the declared completion gates are resolved (x)' : 'ok' }));
  h.finish({ checks });
  await h.chains.tick();
  assert.equal(h.ended()!.kind, 'gate');
  assert.match(h.ended()!.reason, /a completion gate needs a person .*staging_acceptance/);
});

test('a missing authorization for the next role stops the chain before it is queued', async () => {
  const h = harness({
    decide: () => ({ next: 'devops', terminal: false }),
    authorize: (role) => (role === 'devops' ? { ok: false, text: 'the devops step needs an authorization grant for deploy_production (authorization_dispatch mode warn_only)' } : { ok: true, text: 'no authorization needed' }),
  });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'authorization');
  assert.match(h.ended()!.reason, /^before step 2 \(devops\): the devops step needs an authorization grant for deploy_production/);
  assert.deepEqual(h.roles(), ['dev:claude']);
});

test('a blocked task stops the chain, and refuses to start one', async () => {
  const h = harness();
  await h.start('dev');
  h.setHold({ kind: 'blocked', reason: 'the task is blocked: waits on operator_approval' });
  h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'blocked');
  await assert.rejects(h.start('dev'), /The chain cannot start: the task is blocked: waits on operator_approval/);
});

test('free-roam is never run: the chain stops as an escalation', async () => {
  const h = harness({ decide: () => ({ next: 'free-roam', terminal: false }) });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'escalated');
  await assert.rejects(harness().start('free-roam'), /free-roam is the escalation role/);
});

test('no next role, or no answer from decide-next-step.rb, stops the chain', async () => {
  const none = harness({ decide: () => ({ next: '', terminal: false }) });
  await none.start('dev');
  none.finish(); await none.chains.tick();
  assert.equal(none.ended()!.kind, 'no-next');
  const broken = harness({ decide: () => ({ next: '', terminal: false, error: 'decide-next-step.rb gave no decision (exit 2): Usage' }) });
  await broken.start('dev');
  broken.finish(); await broken.chains.tick();
  assert.deepEqual([broken.ended()!.kind, broken.ended()!.reason], ['no-next', 'decide-next-step.rb gave no decision (exit 2): Usage']);
});

test('an unusable CLI stops the chain with the reason; it never swaps in another CLI', async () => {
  const h = harness({ usable: { codex: { usable: false, reason: 'codex login status: not logged in' } } });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'cli');
  assert.equal(h.ended()!.reason, 'before step 2 (reviewer): codex cannot run the reviewer step: codex login status: not logged in; the chain does not swap in another CLI');
  assert.deepEqual(h.roles(), ['dev:claude']);
  await assert.rejects(harness({ usable: { claude: { usable: false, reason: 'not on PATH' } } }).start('dev'), /claude cannot run the dev step: not on PATH/);
});

test('a step that cannot start stops the chain', async () => {
  const h = harness({ refuseStart: (role) => (role === 'reviewer' ? 'TASK ownership refused: held by run r-1' : null) });
  await h.start('dev');
  h.finish(); await h.chains.tick();
  assert.equal(h.ended()!.kind, 'failed');
  assert.match(h.ended()!.reason, /step 2 \(reviewer with codex\) could not start: TASK ownership refused/);
});

test('the chain survives a dashboard restart: a new instance over the same files goes on', async () => {
  const dir = tmp();
  const first = harness({ dir });
  await first.start('dev');
  first.finish();
  // A new server process: new queue and chain objects over the same files (results come from the step records).
  const second = harness({ dir });
  for (const [id, r] of first.results) second.results.set(id, r);
  await second.chains.tick();
  assert.deepEqual(second.roles(), ['dev:claude', 'reviewer:codex']);
  assert.equal(second.chains.latest(TASK)!.steps[1].launchId, 'L2');
});

test('a step whose launch record was pruned keeps what the chain recorded of it', async () => {
  const h = harness();
  const { chain } = await h.start('dev');
  h.finish(); await h.chains.tick();
  const first = h.chains.latest(TASK)!.steps[0];
  h.launches.delete(first.launchId!);
  h.results.delete(first.launchId!);
  const step = h.chains.view(chain.id)!.steps[0];
  assert.deepEqual([step.status, step.verification], ['verified', first.outcome!.text]);
});

test('Stop stops the running step and ends the chain', async () => {
  const h = harness();
  const { chain } = await h.start('dev');
  const view = h.chains.stop(TASK)!;
  assert.deepEqual([view.active, view.ended!.kind, view.ended!.reason], [false, 'operator', 'stopped by the operator at step 1 (dev)']);
  assert.deepEqual(h.stopped, [chain.steps[0].launchId]);
  await h.chains.tick();
  assert.deepEqual(h.roles(), ['dev:claude'], 'nothing is queued after a stop');
});

test('Stop cancels a step still waiting in the queue', async () => {
  const h = harness({ cap: 1 });
  h.queue.enqueue({ kind: 'task', key: 'TASK-EAR-9', label: 'other', trigger: { kind: 'now' }, step: { role: 'dev', cli: 'claude', repos: [{ repo: 'demo' }] } });
  await h.queue.tick();
  const { item, chain } = await h.start('dev');
  assert.equal(item.state, 'waiting');
  assert.equal(chain.steps[0].status, 'queued');
  h.chains.stop(TASK);
  assert.equal(h.queue.get(item.id)!.state, 'cancelled');
  assert.equal(h.stopped.length, 0);
});

test('a chain step cancelled in the queue ends the chain', async () => {
  const h = harness({ cap: 1 });
  h.queue.enqueue({ kind: 'task', key: 'TASK-EAR-9', label: 'other', trigger: { kind: 'now' }, step: { role: 'dev', cli: 'claude', repos: [{ repo: 'demo' }] } });
  await h.queue.tick();
  const { item } = await h.start('dev');
  h.queue.cancel(item.id);
  await h.chains.tick();
  assert.equal(h.ended()!.kind, 'operator');
  assert.match(h.ended()!.reason, /cancelled in the queue/);
});

test('one chain per task; a second is refused while it runs', async () => {
  const h = harness();
  await h.start('dev');
  await assert.rejects(h.start('dev'), /already running on TASK-EAR-1/);
  await assert.rejects(h.start('dev', { cap: 0 }), /step cap must be a whole number/);
});

test('after another task\'s chain ends: waits for the chain, then fires with why it ended', async () => {
  const h = harness();
  await h.start('dev');
  const waiting = h.queue.enqueue({ kind: 'task', key: 'TASK-EAR-2', label: 'TASK-EAR-2 dev', trigger: { kind: 'after', taskId: TASK, scope: 'chain' }, step: { role: 'dev', cli: 'claude', repos: [{ repo: 'demo' }] } });
  assert.equal(waiting.after!.chainId, h.chains.latest(TASK)!.id);
  h.finish(); await h.chains.tick(); await h.queue.tick();
  assert.equal(h.queue.itemView(waiting.id)!.waitingFor, `${TASK}'s chain to end`, 'a step ending is not the chain ending');
  h.verdict('approved'); h.finish(); await h.chains.tick(); await h.queue.tick();
  const fired = h.queue.get(waiting.id)!;
  assert.equal(fired.state, 'started');
  assert.match(fired.fired!, /^TASK-EAR-1's chain ended: decide-next-step.rb: done/);
});

test('after a chain ends, with no chain running: waits for the next chain on that task, and fires when it stops', async () => {
  const h = harness();
  const waiting = h.queue.enqueue({ kind: 'task', key: 'TASK-EAR-2', label: 'TASK-EAR-2 dev', trigger: { kind: 'after', taskId: TASK, scope: 'chain' }, step: { role: 'dev', cli: 'claude', repos: [{ repo: 'demo' }] } });
  await h.queue.tick();
  assert.equal(h.queue.itemView(waiting.id)!.waitingFor, `${TASK}'s next chain to start and end`);
  h.advance(1000);
  await h.start('dev');
  h.chains.stop(TASK);
  await h.queue.tick();
  assert.match(h.queue.get(waiting.id)!.fired!, /chain ended: stopped by the operator/);
});

test('integration: the real decide-next-step.rb, authorization check and status.yaml drive the chain', async () => {
  const office = makeOffice();
  try {
    const dir = office.task(TASK, { current_agent: 'dev' });
    const h = harness({
      override: {
        decide: (taskId, role) => decideNextStep(office.root, taskId, role),
        authorize: (taskId, role) => authorizationCheck(office.root, taskId, role),
        hold: (taskId) => taskHold(office.runs, taskId),
        verdict: (taskId) => reviewVerdict(office.runs, taskId),
      },
    });
    await h.start('dev');
    fs.writeFileSync(path.join(dir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    h.finish(); await h.chains.tick();
    assert.deepEqual(h.roles(), ['dev:claude', 'reviewer:codex']);
    assert.deepEqual(h.chains.latest(TASK)!.steps[0].decision, { next: 'reviewer', terminal: false });
    fs.writeFileSync(path.join(dir, 'reviewer-output.yaml'), 'summary: "Looks right."\nreview_verdict: approved\nissues: []\n');
    h.finish(); await h.chains.tick();
    assert.equal(h.ended()!.kind, 'done');
    assert.equal(h.chains.latest(TASK)!.steps[1].verdict, 'approved');
  } finally { office.cleanup(); }
});

test('the default pairing from the environment: claude writes, codex reviews; never the same CLI twice', () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(chainPairingFrom({}), { writer: 'claude', reviewer: 'codex' });
    assert.deepEqual(chainPairingFrom({ DASHBOARD_CHAIN_WRITER_CLI: 'codex', DASHBOARD_CHAIN_REVIEWER_CLI: 'claude' }), { writer: 'codex', reviewer: 'claude' });
    assert.deepEqual(chainPairingFrom({ DASHBOARD_CHAIN_WRITER_CLI: 'codex' }), { writer: 'claude', reviewer: 'codex' }, 'codex on both sides falls back');
    assert.deepEqual(chainPairingFrom({ DASHBOARD_CHAIN_REVIEWER_CLI: 'gemini' }), { writer: 'claude', reviewer: 'codex' });
  } finally { console.warn = warn; }
});

test('stepOutcome reads the dashboard verification', () => {
  assert.deepEqual(stepOutcome(okResult('L1', { commits: [] })), { ok: true, text: 'verified · nothing to commit', gateBlocked: false });
  assert.equal(stepOutcome(okResult('L1', { lease: { ok: false, text: 'lost' }, verified: false })).kind, 'failed');
});
