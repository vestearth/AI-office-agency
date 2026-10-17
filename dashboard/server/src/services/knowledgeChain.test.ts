import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OfficeLaunch } from '../../../shared/types';
import { KnowledgeChain } from './knowledgeChain';
import { OfficeLauncher } from './officeLauncher';
import { RunQueue } from './runQueue';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-chain-'));
const isRunning = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));

/** The Run queue the rounds go through (runQueue.ts), over a real launcher; a key is busy while its launch runs. */
function queueFor(launcher: OfficeLauncher, dir: string, startRound: () => Promise<OfficeLaunch | null>, cap = 2) {
  return new RunQueue(path.join(dir, 'queue.json'), {
    launches: launcher, cap, verifying: () => false,
    start: async () => { const launch = await startRound(); return launch ? { launch } : null; },
    busy: (key) => (isRunning(launcher.latest(key)) ? 'running' : null),
  });
}

/** Waits (by condition, not a fixed count) until no knowledge round runs. */
async function roundEnded(launcher: OfficeLauncher) {
  const deadline = Date.now() + 20_000;
  while (isRunning(launcher.latest('knowledge')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** A launcher plus a round starter whose rounds exit with the given codes, in order. */
function setup(exitCodes: number[], opts: { emptyAfter?: number } = {}) {
  const dir = tmp();
  const launcher = new OfficeLauncher(dir);
  let calls = 0;
  const startRound = async () => {
    calls++;
    if (opts.emptyAfter !== undefined && calls > opts.emptyAfter) return null;
    const code = exitCodes[calls - 1] ?? 0;
    return launcher.start({ kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', argv: [process.execPath, '-e', `setTimeout(() => process.exit(${code}), 50)`], display: 'fixture', cwd: process.cwd() });
  };
  const queue = queueFor(launcher, dir, startRound);
  const chain = new KnowledgeChain(launcher, queue, path.join(dir, 'knowledge-chain.json'));
  return { launcher, chain, queue, dir, rounds: () => calls };
}

/** Ticks the chain each time its round has ended, until the chain ends (each tick queues and starts the next round). */
async function runOut(chain: KnowledgeChain, launcher: OfficeLauncher) {
  for (let i = 0; i < 20 && !chain.view()?.ended; i++) {
    await roundEnded(launcher);
    await chain.tick();
  }
  return chain.view()!;
}

test('runs the rounds back to back and ends after the last', async () => {
  const { chain, launcher, rounds } = setup([0, 0, 0]);
  const { launch, chain: view } = await chain.start(3);
  assert.ok(launch);
  assert.deepEqual([view!.total, view!.round], [3, 1]);
  const done = await runOut(chain, launcher);
  assert.equal(rounds(), 3);
  assert.deepEqual([done.round, done.ended!.reason], [3, 'all 3 rounds finished']);
});

test('a failed round ends the chain without starting the next', async () => {
  const { chain, launcher, rounds } = setup([0, 1, 0]);
  await chain.start(5);
  const done = await runOut(chain, launcher);
  assert.equal(rounds(), 2);
  assert.equal(done.ended!.reason, 'round 2 failed');
});

test('stops early when the next brief has nothing to re-check', async () => {
  const { chain, launcher } = setup([0, 0], { emptyAfter: 2 });
  await chain.start(5);
  const done = await runOut(chain, launcher);
  assert.equal(done.round, 2);
  assert.equal(done.ended!.reason, 'nothing left to re-check after round 2');
});

test('Stop ends the chain and stops the running round', async () => {
  const { launcher } = setup([]);
  const dir = tmp();
  const slowRound = async () => launcher.start({ kind: 'knowledge', key: 'knowledge', label: 'k', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], display: '', cwd: process.cwd() });
  const slow = new KnowledgeChain(launcher, queueFor(launcher, dir, slowRound), path.join(dir, 'c.json'));
  await slow.start(3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  slow.stop();
  assert.match(slow.view()!.ended!.reason, /stopped by the operator in round 1/);
  for (let i = 0; i < 100 && ['running', 'stopping'].includes(launcher.latest('knowledge')!.status); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(launcher.latest('knowledge')!.status, 'stopped');
  await slow.tick();
  assert.equal(slow.view()!.round, 1);
});

test('refuses a start while a round runs, a bad round count, and returns no chain when nothing is in scope', async () => {
  const { chain } = setup([0]);
  await assert.rejects(chain.start(2), /Rounds must be one of 1, 3, 5/);
  await chain.start(1);
  await assert.rejects(chain.start(1), /already running/);
  const empty = setup([], { emptyAfter: 0 });
  assert.deepEqual(await empty.chain.start(3), { launch: null, chain: null });
});

test('rounds go through the Run queue: with the cap taken by a task step, round 1 waits, then starts when the slot frees', async () => {
  const dir = tmp();
  const launcher = new OfficeLauncher(dir);
  let calls = 0;
  const startRound = async () => {
    calls++;
    return launcher.start({ kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'], display: 'fixture', cwd: process.cwd() });
  };
  const queue = queueFor(launcher, dir, startRound, 1);
  const chain = new KnowledgeChain(launcher, queue, path.join(dir, 'knowledge-chain.json'));
  const task = launcher.start({ kind: 'task', key: 'TASK-EAR-1', label: 'TASK-EAR-1 dev', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], display: 'fixture', cwd: process.cwd() });

  const first = await chain.start(1);
  assert.equal(first.launch, null);
  assert.equal(calls, 0);
  assert.deepEqual([first.chain!.round, first.chain!.queued?.waitingFor], [0, 'a free slot (1 of 1 running)']);
  assert.equal(first.queued?.label, 'Knowledge re-check');
  await assert.rejects(chain.start(1), /already queued/);

  launcher.stop(task.id);
  for (let i = 0; i < 400 && launcher.active().length; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  await queue.tick();
  await chain.tick();
  assert.equal(calls, 1);
  assert.equal(chain.view()!.round, 1);
  const done = await runOut(chain, launcher);
  assert.equal(done.ended!.reason, 'all 1 rounds finished');
});

test('Stop while the next round waits in the queue cancels it and ends the chain', async () => {
  const dir = tmp();
  const launcher = new OfficeLauncher(dir);
  const round = async () => launcher.start({ kind: 'knowledge', key: 'knowledge', label: 'k', argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'], display: '', cwd: process.cwd() });
  const queue = queueFor(launcher, dir, round, 1);
  const chain = new KnowledgeChain(launcher, queue, path.join(dir, 'c.json'));
  await chain.start(3);
  await roundEnded(launcher);
  // A task step takes the only slot before round 2 is queued.
  const task = launcher.start({ kind: 'task', key: 'TASK-EAR-2', label: 'TASK-EAR-2 dev', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], display: '', cwd: process.cwd() });
  await chain.tick();
  assert.deepEqual([chain.view()!.round, Boolean(chain.view()!.queued)], [1, true]);
  chain.stop();
  assert.match(chain.view()!.ended!.reason, /stopped by the operator in round 2/);
  assert.equal(queue.view().items.length, 0);
  assert.equal(queue.view().recent[0].state, 'cancelled');
  launcher.stop(task.id);
});
