import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { makeOffice, VALID_DEV_OUTPUT } from '../testing/officeFixture';
import { LeaseRefusedError, TaskLease } from './taskLease';

// D6/D8: the dashboard takes the task's ownership lease through the office's own
// scripts/task-ownership.rb, so run-agent.sh and every fenced status writer is refused
// while a dashboard step holds it. Every test runs the real scripts in a temp office root.

const RUN_A = 'run-20261017T010000Z-TASK-T-1-dev-aaaaaa';
const RUN_B = 'run-20261017T010001Z-TASK-T-1-dev-bbbbbb';
const ownership = (taskDir: string) => yaml.load(fs.readFileSync(path.join(taskDir, 'ownership.yaml'), 'utf8')) as {
  epoch: number; holder: { run_id: string; lease_expires_at: string } | null; history: { run_id: string; ended_by: string }[];
};

test('acquire takes the office lease for the step; another holder is refused with the holder and the reason', async () => {
  const office = makeOffice();
  try {
    const dir = office.task('TASK-T-1');
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step L1' });
    assert.equal(grant.epoch, 1);
    assert.equal(grant.disabled, false);
    assert.equal(grant.renewIntervalSeconds, 300);
    assert.equal(lease.holder(dir)?.runId, RUN_A);
    assert.equal(lease.holder(dir)?.live, true);
    await assert.rejects(lease.acquire(dir, 'TASK-T-1', { runId: RUN_B, agent: 'reviewer', reason: 'second' }), (err: unknown) => {
      assert.ok(err instanceof LeaseRefusedError);
      assert.match(err.message, new RegExp(`held by run ${RUN_A}`));
      assert.match(err.message, /agent=dev/);
      assert.equal(err.status, 409);
      return true;
    });
  } finally { office.cleanup(); }
});

test('while the dashboard holds the lease run-agent.sh is refused (exit 9) and changes nothing; after release it dispatches', async () => {
  const office = makeOffice();
  try {
    const dir = office.task('TASK-T-1');
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    const statusBefore = fs.readFileSync(path.join(dir, 'status.yaml'), 'utf8');
    // The cursor runner assembles the prompt and invokes no AI: the dispatch path up to
    // ownership_acquire is the real one.
    const held = spawnSync('bash', ['run-agent.sh', 'TASK-T-1', 'dev', 'cursor'], { cwd: office.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...process.env, AI_DEV_OFFICE_RUN_ID: '' } });
    assert.equal(held.status, 9, held.stdout + held.stderr);
    assert.match(held.stderr, new RegExp(`TASK ownership refused: TASK-T-1 is held by run ${RUN_A}`));
    assert.equal(fs.readFileSync(path.join(dir, 'status.yaml'), 'utf8'), statusBefore);
    assert.equal(ownership(dir).holder?.run_id, RUN_A);

    await lease.release(grant, 'step finished');
    const free = spawnSync('bash', ['run-agent.sh', 'TASK-T-1', 'dev', 'cursor'], { cwd: office.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...process.env, AI_DEV_OFFICE_RUN_ID: '' } });
    assert.equal(free.status, 0, free.stdout + free.stderr);
    assert.match(free.stdout, /Prompt saved/);
  } finally { office.cleanup(); }
});

test('a status writer without the lease is fenced while it is held; the holder\'s epoch passes', async () => {
  const office = makeOffice();
  try {
    const dir = office.task('TASK-T-1');
    fs.writeFileSync(path.join(dir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    const sync = (env: NodeJS.ProcessEnv) => spawnSync('ruby', ['scripts/sync-status-from-output.rb', 'TASK-T-1', 'dev', path.join(dir, 'status.yaml'), path.join(dir, 'dev-output.yaml'), '2026-10-17', 'in_review'],
      { cwd: office.root, encoding: 'utf8', env: { ...process.env, ...env } });
    const outsider = sync({});
    assert.equal(outsider.status, 9, outsider.stderr);
    assert.match(outsider.stderr, /Status write refused: .*holds no lease/);
    const owner = sync(lease.fencedEnv(grant));
    assert.equal(owner.status, 0, owner.stderr);
    assert.match(owner.stdout, /Status synced: assigned -> in_review/);
  } finally { office.cleanup(); }
});

test('release frees the task at once; a renew after it reports the lease lost', async () => {
  const office = makeOffice();
  try {
    const dir = office.task('TASK-T-1');
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    assert.deepEqual(await lease.release(grant, 'verified and committed'), { ok: true, message: 'ownership released: TASK-T-1 epoch=1' });
    assert.equal(lease.holder(dir), null);
    assert.equal(ownership(dir).history.at(-1)?.ended_by, 'released');
    const renewed = await lease.renew(grant);
    assert.equal(renewed.ok, false);
    assert.match(renewed.message, /Lease lost/);
    const next = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_B, agent: 'reviewer', reason: 'next step' });
    assert.equal(next.epoch, 2);
  } finally { office.cleanup(); }
});

test('the heartbeat argv renews the lease while the step runs', async () => {
  const office = makeOffice();
  try {
    const dir = office.task('TASK-T-1');
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    const before = ownership(dir).holder!.lease_expires_at;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const [command, ...args] = lease.renewArgv(grant);
    execFileSync(command, args, { encoding: 'utf8' });
    assert.ok(ownership(dir).holder!.lease_expires_at > before, 'expiry moved forward');
  } finally { office.cleanup(); }
});

test('a lease left behind by a dead dashboard lapses after lease_seconds and the next step reclaims it (no forced release)', async () => {
  const office = makeOffice({ leaseSeconds: 2, renewSeconds: 1 });
  try {
    const dir = office.task('TASK-T-1');
    // The dashboard that took this lease is gone: no heartbeat, no release.
    await new TaskLease(office.root).acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    const restarted = new TaskLease(office.root);
    await assert.rejects(restarted.acquire(dir, 'TASK-T-1', { runId: RUN_B, agent: 'dev', reason: 'too early' }), LeaseRefusedError);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(restarted.holder(dir)?.live, false);
    const grant = await restarted.acquire(dir, 'TASK-T-1', { runId: RUN_B, agent: 'dev', reason: 'after restart' });
    assert.equal(grant.epoch, 2);
    assert.deepEqual(ownership(dir).history.map((h) => [h.run_id, h.ended_by]), [[RUN_A, 'reclaimed']]);
  } finally { office.cleanup(); }
});

test('with ownership disabled in the office config, acquire says so and the fenced scripts get the office kill switch', async () => {
  const office = makeOffice();
  try {
    // ownership.enabled is protected from local overlays: change the tracked config of the copy.
    const cfg = path.join(office.root, 'office.config.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^(ownership:\n(?:.*\n)*?\s+enabled:) true/m, '$1 false'));
    const dir = office.task('TASK-T-1');
    const lease = new TaskLease(office.root);
    const grant = await lease.acquire(dir, 'TASK-T-1', { runId: RUN_A, agent: 'dev', reason: 'dashboard step' });
    assert.equal(grant.disabled, true);
    assert.equal(grant.epoch, null);
    assert.equal(lease.fencedEnv(grant).AI_DEV_OFFICE_OWNERSHIP, 'off');
    assert.equal(fs.existsSync(path.join(dir, 'ownership.yaml')), false);
  } finally { office.cleanup(); }
});
