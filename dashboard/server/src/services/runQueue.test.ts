import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OfficeLaunch, RunQueueItem, RunTrigger } from '../../../shared/types';
import { parseTrigger, queueItemLine } from '../../../shared/runQueue';
import { RunQueue, type RunQueueDeps } from './runQueue';

// The Run queue with fake launches and a fake clock: every state change is a call, never a sleep.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-queue-'));

function harness(opts: { cap?: number; file?: string; refuse?: (item: RunQueueItem) => string | null; empty?: boolean } = {}) {
  let clock = Date.parse('2026-10-17T10:00:00Z');
  const launches = new Map<string, OfficeLaunch>();
  const verifying = new Set<string>();
  const started: RunQueueItem[] = [];
  let seq = 0;
  const deps: RunQueueDeps = {
    cap: opts.cap ?? 2,
    now: () => new Date(clock),
    newLaunchId: () => `L${++seq}`,
    launches: {
      get: (id) => launches.get(id) ?? null,
      latest: (key) => [...launches.values()].filter((l) => l.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
      active: () => [...launches.values()].filter((l) => ['running', 'stopping'].includes(l.status)),
    },
    verifying: (id) => verifying.has(id),
    // A dashboard step of the key running or being verified (stepInFlight in routes/launch.ts).
    busy: (key) => {
      const l = deps.launches.latest(key);
      if (l && ['running', 'stopping'].includes(l.status)) return `${l.label} is already running`;
      return l && verifying.has(l.id) ? 'the previous step is still being verified' : null;
    },
    start: async (item) => {
      const refused = opts.refuse?.(item);
      if (refused) throw new Error(refused);
      if (opts.empty) return null;
      const launch: OfficeLaunch = { id: item.launchId!, kind: item.kind, key: item.key, label: item.label, command: 'fake', cwd: '/', startedAt: new Date(clock).toISOString(), status: 'running', log: '', truncated: false };
      launches.set(launch.id, launch);
      started.push(item);
      return { launch, detail: { lease: `lease for ${item.key}` } };
    },
  };
  const file = opts.file ?? path.join(tmp(), 'queue.json');
  const queue = new RunQueue(file, deps);
  return {
    queue, file, deps, started, launches, verifying,
    advance: (ms: number) => { clock += ms; },
    end: (id: string, status: OfficeLaunch['status'] = 'succeeded') => { launches.set(id, { ...launches.get(id)!, status, finishedAt: new Date(clock).toISOString() }); },
    step: (key: string, trigger: RunTrigger = { kind: 'now' }) => queue.enqueue({ kind: 'task', key, label: `${key} dev`, trigger, step: { role: 'dev', cli: 'claude', repos: [{ repo: 'api-gateway' }] } }),
  };
}

test('now starts at once under the cap; the third waits for a free slot and starts when one ends', async () => {
  const h = harness({ cap: 2 });
  const a = h.step('TASK-A-1'); const b = h.step('TASK-B-1'); const c = h.step('TASK-C-1');
  await h.queue.tick();
  assert.deepEqual(h.started.map((i) => i.key), ['TASK-A-1', 'TASK-B-1']);
  assert.equal(h.queue.get(a.id)!.state, 'started');
  assert.equal(h.queue.get(b.id)!.launchId, 'L2');
  assert.deepEqual(h.queue.takeDetail(a.id), { lease: 'lease for TASK-A-1' });
  const view = h.queue.view();
  assert.deepEqual([view.cap, view.running, view.items.length], [2, 2, 1]);
  assert.equal(view.items[0].waitingFor, 'a free slot (2 of 2 running)');
  h.end('L1');
  await h.queue.tick();
  assert.equal(h.queue.get(c.id)!.state, 'started');
  assert.equal(h.started.length, 3);
});

test('a knowledge round counts against the same cap as task steps', async () => {
  const h = harness({ cap: 1 });
  h.step('TASK-A-1');
  const k = h.queue.enqueue({ kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', trigger: { kind: 'now' }, round: { number: 1, total: 3 } });
  await h.queue.tick();
  assert.equal(h.queue.get(k.id)!.state, 'waiting');
  h.end('L1', 'failed');
  await h.queue.tick();
  assert.equal(h.queue.get(k.id)!.state, 'started');
});

test('one step at a time per task: one waiting item per task, and an item waits while its task has a step running or being verified', async () => {
  const h = harness({ cap: 3 });
  h.step('TASK-A-1');
  await h.queue.tick();
  const later = h.step('TASK-A-1', { kind: 'at', at: '2026-10-17T10:00:00Z' });
  assert.throws(() => h.step('TASK-A-1'), /already queued/);
  await h.queue.tick();
  assert.equal(h.queue.get(later.id)!.state, 'waiting');
  assert.match(h.queue.view().items[0].waitingFor!, /its task to be free: TASK-A-1 dev is already running/);
  h.end('L1');
  h.verifying.add('L1');
  await h.queue.tick();
  assert.equal(h.queue.get(later.id)!.state, 'waiting');
  h.verifying.delete('L1');
  await h.queue.tick();
  assert.equal(h.queue.get(later.id)!.state, 'started');
});

test('a time trigger waits for its time; one first seen due more than an hour late was missed and fails', async () => {
  const h = harness();
  const soon = h.step('TASK-A-1', { kind: 'at', at: '2026-10-17T10:30:00.000Z' });
  await h.queue.tick();
  assert.equal(h.queue.get(soon.id)!.state, 'waiting');
  assert.match(h.queue.view().items[0].waitingFor!, /its time \(2026-10-17T10:30:00.000Z\)/);
  h.advance(30 * 60_000);
  await h.queue.tick();
  assert.equal(h.queue.get(soon.id)!.state, 'started');

  const missed = h.step('TASK-B-1', { kind: 'at', at: '2026-10-17T11:00:00.000Z' });
  h.advance(3 * 60 * 60_000); // the dashboard was down from before 11:00 until 13:30
  await h.queue.tick();
  const item = h.queue.get(missed.id)!;
  assert.equal(item.state, 'failed');
  assert.match(item.reason!, /^missed: it was due at 2026-10-17T11:00:00.000Z and the dashboard was not running then/);
});

test('a due time trigger waiting on the cap never expires', async () => {
  const h = harness({ cap: 1 });
  h.step('TASK-A-1');
  await h.queue.tick();
  const at = h.step('TASK-B-1', { kind: 'at', at: '2026-10-17T10:05:00Z' });
  h.advance(5 * 60_000);
  await h.queue.tick();
  h.advance(2 * 60 * 60_000);
  await h.queue.tick();
  assert.equal(h.queue.get(at.id)!.state, 'waiting');
  h.end('L1');
  await h.queue.tick();
  const item = h.queue.get(at.id)!;
  assert.equal(item.state, 'started');
  assert.equal(item.fired, '120 min after its time');
});

test('after another task\'s step: fires once that step ends (any ending) and its verification is done', async () => {
  const h = harness({ cap: 3 });
  h.step('TASK-B-1');
  await h.queue.tick(); // TASK-B-1 runs as L1
  const after = h.step('TASK-A-1', { kind: 'after', taskId: 'TASK-B-1', scope: 'step' });
  assert.deepEqual(h.queue.get(after.id)!.after, { launchId: 'L1' });
  await h.queue.tick();
  assert.equal(h.queue.view().items[0].waitingFor, "TASK-B-1's step (running)");
  h.end('L1', 'failed');
  h.verifying.add('L1');
  await h.queue.tick();
  assert.equal(h.queue.view().items[0].waitingFor, "TASK-B-1's step to be verified");
  h.verifying.delete('L1');
  await h.queue.tick();
  const item = h.queue.get(after.id)!;
  assert.equal(item.state, 'started');
  assert.equal(item.fired, "TASK-B-1's step failed");
});

test('after a task with nothing in flight waits for its next step; after a queued step follows that item', async () => {
  const h = harness({ cap: 1 });
  h.step('TASK-X-1');
  await h.queue.tick(); // L1 holds the only slot
  const queuedB = h.step('TASK-B-1');
  const afterQueued = h.step('TASK-A-1', { kind: 'after', taskId: 'TASK-B-1', scope: 'step' });
  assert.deepEqual(h.queue.get(afterQueued.id)!.after, { itemId: queuedB.id });
  const afterNext = h.step('TASK-C-1', { kind: 'after', taskId: 'TASK-D-1', scope: 'step' });
  assert.ok(h.queue.get(afterNext.id)!.after!.since);
  await h.queue.tick();
  assert.equal(h.queue.view().items.find((i) => i.id === afterQueued.id)!.waitingFor, "TASK-B-1's queued step to run and end");
  assert.equal(h.queue.view().items.find((i) => i.id === afterNext.id)!.waitingFor, "TASK-D-1's next step to start and end");

  h.end('L1');
  await h.queue.tick(); // TASK-B-1 starts as L2
  assert.equal(h.queue.get(queuedB.id)!.state, 'started');
  h.end('L2', 'stopped');
  await h.queue.tick();
  assert.equal(h.queue.get(afterQueued.id)!.state, 'started');
  assert.equal(h.queue.get(afterQueued.id)!.fired, "TASK-B-1's step stopped");
  assert.deepEqual(h.queue.get(afterQueued.id)!.after, { launchId: 'L2' });
  assert.equal(h.queue.get(afterNext.id)!.state, 'waiting');
});

test('an after trigger whose step will never run fails with that reason', async () => {
  const h = harness({ cap: 1 });
  h.step('TASK-X-1');
  await h.queue.tick();
  const b = h.step('TASK-B-1');
  const after = h.step('TASK-A-1', { kind: 'after', taskId: 'TASK-B-1', scope: 'step' });
  h.queue.cancel(b.id);
  await h.queue.tick();
  const item = h.queue.get(after.id)!;
  assert.equal(item.state, 'failed');
  assert.match(item.reason!, /^its trigger cannot fire: TASK-B-1's queued step did not run \(cancelled: cancelled by the operator before it started\)/);
});

test('cancel: a waiting item only; it never starts', async () => {
  const h = harness({ cap: 1 });
  const a = h.step('TASK-A-1');
  await h.queue.tick();
  const b = h.step('TASK-B-1');
  assert.throws(() => h.queue.cancel(a.id), /is started: only a waiting item can be cancelled \(stop its launch instead\)/);
  assert.equal(h.queue.cancel(b.id).state, 'cancelled');
  assert.throws(() => h.queue.cancel('q-nope'), /not found/);
  h.end('L1');
  await h.queue.tick();
  assert.equal(h.started.length, 1);
  assert.equal(h.queue.view().items.length, 0);
  assert.deepEqual(h.queue.view().recent.map((i) => i.state).sort(), ['cancelled', 'started']);
});

test('an item that can no longer start fails visibly with the reason and is not retried; an empty start is skipped', async () => {
  const h = harness({ refuse: (item) => (item.key === 'TASK-A-1' ? 'TASK ownership refused: TASK-A-1 is held by run R9 (agent=dev)' : null) });
  const a = h.step('TASK-A-1');
  const b = h.step('TASK-B-1');
  await h.queue.tick();
  await h.queue.tick();
  const failed = h.queue.get(a.id)!;
  assert.deepEqual([failed.state, failed.reason, failed.launchId], ['failed', 'TASK ownership refused: TASK-A-1 is held by run R9 (agent=dev)', undefined]);
  assert.equal(h.queue.get(b.id)!.state, 'started');
  assert.equal(h.queue.lastUnstarted('TASK-A-1')!.id, a.id);

  const e = harness({ empty: true });
  const k = e.queue.enqueue({ kind: 'knowledge', key: 'knowledge', label: 'Knowledge re-check', trigger: { kind: 'now' } });
  await e.queue.tick();
  assert.deepEqual([e.queue.get(k.id)!.state, e.queue.get(k.id)!.reason], ['skipped', 'nothing to do when it came up']);
});

test('the queue survives a reload: waiting items stay, and an item left starting by a stopped dashboard is resolved', async () => {
  const dir = tmp();
  const file = path.join(dir, 'queue.json');
  const first = harness({ file, cap: 1 });
  first.step('TASK-A-1');
  await first.queue.tick();
  const waiting = first.step('TASK-B-1', { kind: 'at', at: '2026-10-17T10:10:00Z' });
  // Two items the dashboard was starting when it stopped: one whose launch exists, one whose launch never did.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.items.push(
    { id: 'q-s1', kind: 'task', key: 'TASK-C-1', label: 'TASK-C-1 dev', enqueuedAt: '2026-10-17T09:00:00.000Z', trigger: { kind: 'now' }, state: 'starting', launchId: 'L1' },
    { id: 'q-s2', kind: 'task', key: 'TASK-D-1', label: 'TASK-D-1 dev', enqueuedAt: '2026-10-17T09:00:00.000Z', trigger: { kind: 'now' }, state: 'starting', launchId: 'L-gone' },
  );
  fs.writeFileSync(file, JSON.stringify(raw));

  const second = harness({ file, cap: 1 });
  second.launches.set('L1', { ...first.launches.get('L1')! });
  await second.queue.tick();
  assert.equal(second.queue.get('q-s1')!.state, 'started');
  assert.match(second.queue.get('q-s2')!.reason!, /^interrupted: the dashboard stopped while starting it/);
  assert.equal(second.queue.get(waiting.id)!.state, 'waiting');
  assert.equal(second.queue.view().items.length, 1);
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'writes are atomic: no temp file left');
});

test('overlapping ticks run one after another: an item is never started twice', async () => {
  const h = harness({ cap: 2 });
  h.step('TASK-A-1');
  await Promise.all([h.queue.tick(), h.queue.tick(), h.queue.tick()]);
  assert.equal(h.started.length, 1);
});

test('triggers from a request: now by default, a time in range, after a task\'s step or chain', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  assert.deepEqual(parseTrigger(undefined, now), { kind: 'now' });
  assert.deepEqual(parseTrigger({ kind: 'at', at: '2026-10-17T18:00:00+07:00' }, now), { kind: 'at', at: '2026-10-17T11:00:00.000Z' });
  assert.match((parseTrigger({ kind: 'at', at: '2026-10-17T09:00:00Z' }, now) as { error: string }).error, /has passed/);
  assert.match((parseTrigger({ kind: 'at', at: '2026-10-30T09:00:00Z' }, now) as { error: string }).error, /within the next 7 days/);
  assert.match((parseTrigger({ kind: 'at', at: 'soon' }, now) as { error: string }).error, /valid time/);
  assert.deepEqual(parseTrigger({ kind: 'after', taskId: 'TASK-EAR-1' }, now), { kind: 'after', taskId: 'TASK-EAR-1', scope: 'step' });
  assert.deepEqual(parseTrigger({ kind: 'after', taskId: 'TASK-EAR-1', scope: 'chain' }, now), { kind: 'after', taskId: 'TASK-EAR-1', scope: 'chain' });
  assert.match((parseTrigger({ kind: 'after', taskId: 'TASK-EAR-1', scope: 'round' }, now) as { error: string }).error, /scope must be step or chain/);
  assert.match((parseTrigger({ kind: 'after', taskId: '../etc' }, now) as { error: string }).error, /task id/);
  assert.match((parseTrigger({ kind: 'later' }, now) as { error: string }).error, /now, at or after/);
});

test('queueItemLine says what waits for what', async () => {
  const h = harness({ cap: 1 });
  h.step('TASK-A-1');
  await h.queue.tick();
  h.step('TASK-B-1', { kind: 'after', taskId: 'TASK-A-1', scope: 'step' });
  assert.equal(queueItemLine(h.queue.view().items[0]), "TASK-B-1 dev · claude · after TASK-A-1's step ends · waiting for TASK-A-1's step (running)");
});
