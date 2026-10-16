import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KnowledgeChain } from './knowledgeChain';
import { OfficeLauncher } from './officeLauncher';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-chain-'));

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
  const chain = new KnowledgeChain(launcher, startRound, path.join(dir, 'knowledge-chain.json'));
  return { launcher, chain, rounds: () => calls };
}

async function runOut(chain: KnowledgeChain) {
  for (let i = 0; i < 200 && !chain.view()?.ended; i++) {
    await chain.tick();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return chain.view()!;
}

test('runs the rounds back to back and ends after the last', async () => {
  const { chain, rounds } = setup([0, 0, 0]);
  const { launch, chain: view } = await chain.start(3);
  assert.ok(launch);
  assert.deepEqual([view!.total, view!.round], [3, 1]);
  const done = await runOut(chain);
  assert.equal(rounds(), 3);
  assert.deepEqual([done.round, done.ended!.reason], [3, 'all 3 rounds finished']);
});

test('a failed round ends the chain without starting the next', async () => {
  const { chain, rounds } = setup([0, 1, 0]);
  await chain.start(5);
  const done = await runOut(chain);
  assert.equal(rounds(), 2);
  assert.equal(done.ended!.reason, 'round 2 failed');
});

test('stops early when the next brief has nothing to re-check', async () => {
  const { chain } = setup([0, 0], { emptyAfter: 2 });
  await chain.start(5);
  const done = await runOut(chain);
  assert.equal(done.round, 2);
  assert.equal(done.ended!.reason, 'nothing left to re-check after round 2');
});

test('Stop ends the chain and stops the running round', async () => {
  const { launcher } = setup([]);
  const dir = tmp();
  const slow = new KnowledgeChain(launcher, async () => launcher.start({ kind: 'knowledge', key: 'knowledge', label: 'k', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], display: '', cwd: process.cwd() }), path.join(dir, 'c.json'));
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
