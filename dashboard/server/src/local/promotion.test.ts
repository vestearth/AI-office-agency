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
    central: { recordPromotion: async (id: string, body: object) => { recorded.push({ id, body }); } } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.taskId, /^TASK-EAR-\d+$/);
    const status = fs.readFileSync(path.join(runsDir, r.taskId, 'status.yaml'), 'utf8');
    assert.match(status, /phase: pending/);
    assert.match(status, /current_agent:\s*(null|~)?/);
    assert.ok(fs.existsSync(path.join(runsDir, r.taskId, 'task.md')));
    assert.equal(recorded[0].body.projectionVersion, 'promo.v1');
    // task.md must NOT contain the tester id
    assert.equal(fs.readFileSync(path.join(runsDir, r.taskId, 'task.md'), 'utf8').includes('TSTR-x'), false);
  }
});

test('validation failure rolls back the run dir', async () => {
  const runsDir = tmpRuns();
  const r = await promoteIntake({
    intake: intake as any, triage: triage as any, gate, owner: 'earth', taskPrefix: 'EAR',
    runsDir, now: () => 1700, validate: async () => ({ ok: false, error: 'bad' }),
    central: { recordPromotion: async () => {} } as any,
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
    central: { recordPromotion: async () => {} } as any,
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
    central: { recordPromotion: async () => {} } as any,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.taskId, 'TASK-EAR-007');
});

test('does not invoke run-agent.sh or any dispatch mechanism', async () => {
  const runsDir = tmpRuns();
  const calls: string[] = [];
  const central = {
    recordPromotion: async () => { calls.push('recordPromotion'); },
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
