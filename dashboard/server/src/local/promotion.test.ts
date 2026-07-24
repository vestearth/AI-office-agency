import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { promoteIntake } from './promotion';

// IMPORTANT: every test uses an fs.mkdtempSync temp dir as runsDir. Never the
// real ai-dev-office/runs/ directory (which holds live, unrelated task state).
function tmpRuns() { return fs.mkdtempSync(path.join(os.tmpdir(), 'runs-')); }

const intake = { id: 'INTAKE-1', title: 'Wallet debit fails', body: 'repro', product_hint: 'wallet', tester_id: 'TSTR-x', revision: 2 };
const triage = { schemaVersion: 'triage.v1', classification: 'triaged', summary: 's', contextHash: 'h' };
const gate = { allowed: true, reason: 'triage_valid', gateOverridden: false };

test('promotes to a collision-safe TASK id with a valid pending status.yaml and records the relationship', async () => {
  const runsDir = tmpRuns();
  const recorded: any[] = [];
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async (id: string, body: object) => { recorded.push({ id, body }); return { created: true, taskId: (body as any).taskId }; } } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.taskId, /^TASK-EAR-\d+$/);
    const status = fs.readFileSync(path.join(runsDir, r.taskId, 'status.yaml'), 'utf8');
    assert.match(status, /phase: pending/);
    assert.match(status, /current_agent:\s*(null|~)?/);
    assert.ok(fs.existsSync(path.join(runsDir, r.taskId, 'task.md')));
    assert.equal(recorded[0].body.projectionVersion, 'promo.v2');
    // task.md must NOT contain the tester id
    assert.equal(fs.readFileSync(path.join(runsDir, r.taskId, 'task.md'), 'utf8').includes('TSTR-x'), false);
  }
});

test('promo.v2 structured fields render into task.md when present', async () => {
  const runsDir = tmpRuns();
  const richIntake = { ...intake, severity: 'high', repro_steps: '1. open app', expected: 'no crash', actual: 'crash', environment: 'iOS 18' };
  const r = await promoteIntake({
    intake: richIntake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async (id: string, body: object) => ({ created: true, taskId: (body as any).taskId }) } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const md = fs.readFileSync(path.join(runsDir, r.taskId, 'task.md'), 'utf8');
    assert.match(md, /## Severity\nhigh/);
    assert.match(md, /## Steps to reproduce\n1\. open app/);
    assert.match(md, /## Expected\nno crash/);
    assert.match(md, /## Actual\ncrash/);
    assert.match(md, /## Environment\niOS 18/);
  }
});

test('long body with no structured repro_steps: task.md still carries the full body tail (no info loss vs promo.v1)', async () => {
  const runsDir = tmpRuns();
  const longBody = 'x'.repeat(2500) + 'TAIL-MARKER-END';
  const bigIntake = { ...intake, body: longBody };
  const r = await promoteIntake({
    intake: bigIntake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async (id: string, body: object) => ({ created: true, taskId: (body as any).taskId }) } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const md = fs.readFileSync(path.join(runsDir, r.taskId, 'task.md'), 'utf8');
    // summary is truncated (pre-existing behavior, unchanged) ...
    assert.match(md, /## Summary\nx+\n/);
    // ... but Steps to reproduce falls back to the full body, so the tail survives.
    assert.match(md, /## Steps to reproduce\n[\s\S]*TAIL-MARKER-END/);
  }
});

test('validation failure rolls back the run dir', async () => {
  const runsDir = tmpRuns();
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: false, error: 'bad' }),
    central: { recordPromotion: async () => ({ created: true, taskId: 'unused' }) } as any,
  });
  assert.equal(r.ok, false);
  // no leftover run dir
  assert.equal(fs.readdirSync(runsDir).length, 0);
});

test('blocked gate without override aborts', async () => {
  const runsDir = tmpRuns();
  const r = await promoteIntake({
    intake: intake as any, triage: null as any,
    gate: { allowed: false, reason: 'triage_required', gateOverridden: false },
    owner: 'earth', taskPrefix: 'EAR', runsDir, now: () => 1, validate: async () => ({ ok: true }),
    central: { recordPromotion: async () => ({ created: true, taskId: 'unused' }) } as any,
  });
  assert.equal(r.ok, false);
  // no filesystem work at all on a blocked gate
  assert.equal(fs.readdirSync(runsDir).length, 0);
});

test('allocates the next id after existing TASK-EAR-* runs and skips a colliding dir', async () => {
  const runsDir = tmpRuns();
  fs.mkdirSync(path.join(runsDir, 'TASK-EAR-001'));
  fs.mkdirSync(path.join(runsDir, 'TASK-EAR-005'));
  // pre-create the dir the naive next-number (006) would use, to prove the
  // exclusive-mkdir retry-on-EEXIST path is exercised, not just max()+1.
  fs.mkdirSync(path.join(runsDir, 'TASK-EAR-006'));
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async () => ({ created: true, taskId: 'unused' }) } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.taskId, 'TASK-EAR-007');
});

test('retry that re-materializes the canonical id after a lost-response rollback keeps the dir', async () => {
  // Simulates: first promote's recordPromotion COMMITS on Central, but the
  // HTTP response is lost on the LAN so the outer catch in promoteIntake
  // rolls back the run dir it just created. On retry, nextTaskNumber sees
  // the canonical id free again and re-creates it; recordPromotion now
  // returns {created:false, taskId: <that same canonical id>} because
  // Central already has the row. The !created branch must NOT delete the
  // dir it just re-materialized — that would silently vanish the task even
  // though Central believes it's promoted.
  const runsDir = tmpRuns();

  // First call: central "commits" (created: true) so promoteIntake succeeds
  // and creates TASK-EAR-001 on disk.
  const r1 = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async () => ({ created: true, taskId: 'TASK-EAR-001' }) } as any,
  });
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.taskId, 'TASK-EAR-001');
  assert.ok(fs.existsSync(path.join(runsDir, 'TASK-EAR-001')));

  // Simulate the lost-response rollback: the disk-side effect of that first
  // attempt is gone, even though Central already recorded the promotion.
  fs.rmSync(path.join(runsDir, 'TASK-EAR-001'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(runsDir, 'TASK-EAR-001')), false);

  // Retry: nextTaskNumber sees the canonical id free again and re-creates
  // TASK-EAR-001; central now reports created:false with that SAME id
  // (Central's row already existed from the first, "lost", attempt).
  const r2 = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: { recordPromotion: async () => ({ created: false, taskId: 'TASK-EAR-001' }) } as any,
  });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.taskId, 'TASK-EAR-001');
  // The canonical dir must survive — this is the whole point of the fix.
  assert.ok(fs.existsSync(path.join(runsDir, 'TASK-EAR-001')));
});

test('normal double-promote still removes the throwaway id and keeps only the canonical one', async () => {
  // Contrast case for the test above: when the retry allocates a DIFFERENT
  // id than the canonical one Central already has on file, that throwaway
  // dir IS an orphan and must be removed.
  const runsDir = tmpRuns();
  fs.mkdirSync(path.join(runsDir, 'TASK-EAR-001')); // canonical, already promoted on Central

  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    // nextTaskNumber allocates TASK-EAR-002 (001 already exists); central
    // reports the intake was already promoted under the ORIGINAL 001.
    central: { recordPromotion: async () => ({ created: false, taskId: 'TASK-EAR-001' }) } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.taskId, 'TASK-EAR-001');
  const taskDirs = fs.readdirSync(runsDir).filter((e) => e.startsWith('TASK-'));
  assert.deepEqual(taskDirs, ['TASK-EAR-001']); // 002 was rolled back, only canonical remains
});

test('does not invoke run-agent.sh or any dispatch mechanism', async () => {
  const runsDir = tmpRuns();
  const calls: string[] = [];
  const central = {
    recordPromotion: async () => { calls.push('recordPromotion'); return { created: true, taskId: 'unused' }; },
    // if promoteIntake ever calls anything dispatch-shaped on central it
    // would show up here; central only exposes recordPromotion per the brief
  };
  await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: true }),
    central: central as any,
  });
  assert.deepEqual(calls, ['recordPromotion']);
});
