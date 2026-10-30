import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import type { GateEntry, GateView } from '@shared/types';
import { AuthorizationGrants, awaitingGrants, resolveGrantor, type Grantor } from './authorizationGrants';
import { GateViewService } from './gateView';

const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
// The real time, in whole seconds: the ledger writer and the gate view read the real clock, so a fixed
// date here put the 4-hour expiry behind them once that date passed (2026-10-29 after 14:00Z).
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const EARTH: Grantor = { actor: 'Earth', prefix: 'EAR' };

function gate(over: Partial<GateEntry> & { name: string }): GateEntry {
  return {
    status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null, grantValidUntil: null,
    requiresRecord: false, ran: null, passable: false, unresolvedReason: null, detail: '', ...over,
  };
}
function view(gates: GateEntry[], over: Partial<GateView> = {}): GateView {
  return {
    readable: true, problem: null, finishedPhase: null, ledgerReadable: true,
    summary: { total: gates.length, resolved: 0, passable: 0, byStatus: {} }, gates, ...over,
  };
}

test('awaitingGrants lists every pending bound gate without a grant, dependencies or not', () => {
  const gates = [
    gate({ name: 'stg', requiresAuthorization: 'deploy_staging', grant: 'missing' }),
    gate({ name: 'prod', requiresAuthorization: 'deploy_production', grant: 'missing', waitsOn: ['stg (pending)'] }),
    gate({ name: 'granted', requiresAuthorization: 'production_backfill', grant: 'available' }),
    gate({ name: 'passed', status: 'pass', requiresAuthorization: 'live_load', grant: null }),
    gate({ name: 'plain' }),
  ];
  assert.deepEqual(awaitingGrants(view(gates)), [
    { gate: 'stg', action: 'deploy_staging' },
    { gate: 'prod', action: 'deploy_production' },
  ]);
  for (const over of [{ readable: false }, { ledgerReadable: false }, { finishedPhase: 'done' }]) {
    assert.deepEqual(awaitingGrants(view(gates, over)), [], JSON.stringify(over));
  }
});

test('resolveGrantor is the office.team.yaml owner of the checkout prefix, or why there is none', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grantor-'));
  assert.deepEqual(await resolveGrantor(root), { actor: null, problem: 'This checkout has no task prefix. Set your name in the dashboard first.' });
  await fs.writeFile(path.join(root, 'office.config.local.yaml'), 'office:\n  task_prefix: EAR\n');
  assert.deepEqual(await resolveGrantor(root), { actor: null, problem: 'Task prefix EAR has no owner in office.team.yaml. Set your name in the dashboard first.' });
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes:\n  EAR: "Earth"\n  VS: "VerifySlip (project)"\n');
  assert.deepEqual(await resolveGrantor(root), { actor: 'Earth', prefix: 'EAR' });
});

// --- end to end: the real gate view and the real ledger writer, in a scratch runs dir ---

const governedStatus = (taskId: string, phase = 'assigned') => ({
  task_id: taskId, phase, state: phase, iteration: 1, current_agent: 'dev', ready: true,
  blocked_on: [], waiting_for: [], assignment: { primary: 'dev', parallel: false }, updated_at: '2026-10-01', history: [],
});
function office(runsDir: string, script: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_OFFICE_RUNS_DIR: runsDir };
  delete env.AI_OFFICE_NOW;
  execFileSync('ruby', [path.join(OFFICE_ROOT, 'scripts', script), ...args], { env, stdio: 'pipe' });
}

/** A runs dir with TASK-001: deploy_staging and deploy_production gates, both waiting for a grant. */
async function gatedTask(phase = 'assigned'): Promise<{ runsDir: string; grants: AuthorizationGrants }> {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-'));
  await fs.mkdir(path.join(runsDir, 'TASK-001'));
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'status.yaml'), yaml.dump(governedStatus('TASK-001')));
  office(runsDir, 'update-completion-gate.rb', 'TASK-001', 'declare', 'stg', '--actor', 'pm', '--reason', 's', '--requires-authorization', 'deploy_staging');
  office(runsDir, 'update-completion-gate.rb', 'TASK-001', 'declare', 'prod', '--actor', 'pm', '--reason', 'p', '--requires-authorization', 'deploy_production', '--after', 'stg');
  if (phase !== 'assigned') {
    const file = path.join(runsDir, 'TASK-001', 'status.yaml');
    const status = yaml.load(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(file, yaml.dump({ ...status, phase, state: phase }));
  }
  const gateViews = new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb'));
  return { runsDir, grants: new AuthorizationGrants(OFFICE_ROOT, runsDir, gateViews, async () => EARTH, () => NOW) };
}

async function ledger(runsDir: string): Promise<Array<Record<string, unknown>>> {
  const doc = yaml.load(await fs.readFile(path.join(runsDir, 'TASK-001', 'authorization.yaml'), 'utf8')) as { authorizations: Array<Record<string, unknown>> };
  return doc.authorizations;
}

const VALID = { action: 'deploy_staging', scope: 'slip-api #79 main -> staging', reason: 'operator approved in the dashboard' };

test('view: what the task waits for, and who a grant would be recorded as', async () => {
  const { grants } = await gatedTask();
  assert.deepEqual(await grants.view('TASK-001'), {
    taskId: 'TASK-001',
    awaiting: [{ gate: 'stg', action: 'deploy_staging' }, { gate: 'prod', action: 'deploy_production' }],
    problem: null,
    grantor: EARTH,
  });
});

test('record writes one grant through the ledger writer, as the grantor and via dashboard', async () => {
  const { runsDir, grants } = await gatedTask();

  const result = await grants.record('TASK-001', { ...VALID, expiresInHours: 4 });

  const expiresAt = new Date(NOW.getTime() + 4 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.deepEqual(result, { ok: true, id: 'authz-001', action: 'deploy_staging', actor: 'Earth', expiresAt });
  const [entry] = await ledger(runsDir);
  assert.deepEqual(
    { ...entry, at: typeof entry.at },
    { id: 'authz-001', type: 'grant', actor: 'Earth', via: 'dashboard', reason: VALID.reason, at: 'string', action: 'deploy_staging', scope: VALID.scope, expires_at: expiresAt },
  );
  const meta = await fs.readFile(path.join(runsDir, 'TASK-001', 'meta.yaml'), 'utf8');
  assert.match(meta, /authorization_recorded/);
  assert.deepEqual((await grants.view('TASK-001')).awaiting, [{ gate: 'prod', action: 'deploy_production' }]);
});

test('record without an expiry writes no expires_at, and keeps Thai text as text', async () => {
  const { runsDir, grants } = await gatedTask();
  const result = await grants.record('TASK-001', { ...VALID, action: 'deploy_production', reason: 'อนุมัติ deploy prod' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [entry] = await ledger(runsDir);
  assert.equal(entry.reason, 'อนุมัติ deploy prod');
  assert.equal('expires_at' in entry, false);
});

test('record refuses an action no pending gate waits for, including one already granted', async () => {
  const { runsDir, grants } = await gatedTask();
  assert.equal((await grants.record('TASK-001', VALID)).ok, true);
  for (const action of ['deploy_staging', 'production_backfill']) {
    assert.deepEqual(await grants.record('TASK-001', { ...VALID, action }), {
      ok: false, status: 409, error: `No pending gate of TASK-001 waits for a ${action} grant.`,
    });
  }
  assert.equal((await ledger(runsDir)).length, 1);
});

test('record refuses a finished task and a task whose ledger cannot be read', async () => {
  const done = await gatedTask('done');
  assert.deepEqual(await done.grants.record('TASK-001', VALID), { ok: false, status: 409, error: 'TASK-001 is done: its gates cannot change.' });

  const corrupt = await gatedTask();
  await fs.writeFile(path.join(corrupt.runsDir, 'TASK-001', 'authorization.yaml'), 'authorizations: [\n');
  assert.deepEqual(await corrupt.grants.record('TASK-001', VALID), {
    ok: false, status: 409, error: 'The gate state of TASK-001 cannot be read: the authorization ledger cannot be read.',
  });
});

test('record refuses when the checkout has no grantor, before touching the ledger', async () => {
  const { runsDir } = await gatedTask();
  const gateViews = new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb'));
  const grants = new AuthorizationGrants(OFFICE_ROOT, runsDir, gateViews, async () => ({ actor: null, problem: 'no prefix' }), () => NOW);
  assert.deepEqual(await grants.record('TASK-001', VALID), { ok: false, status: 409, error: 'no prefix' });
  await assert.rejects(fs.access(path.join(runsDir, 'TASK-001', 'authorization.yaml')));
});

test('record validates its input before anything else', async () => {
  const { grants } = await gatedTask();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...VALID, action: undefined }, 'action must be a non-empty string'],
    [{ ...VALID, scope: '  ' }, 'scope must be a non-empty string'],
    [{ ...VALID, reason: 7 }, 'reason must be a non-empty string'],
    [{ ...VALID, scope: 'x'.repeat(201) }, 'scope exceeds 200 characters'],
    [{ ...VALID, reason: 'x'.repeat(501) }, 'reason exceeds 500 characters'],
    [{ ...VALID, reason: 'two\nlines' }, 'reason must be one line of text'],
    [{ ...VALID, expiresInHours: 0 }, 'expiresInHours must be a whole number of hours from 1 to 168'],
    [{ ...VALID, expiresInHours: 169 }, 'expiresInHours must be a whole number of hours from 1 to 168'],
    [{ ...VALID, expiresInHours: 1.5 }, 'expiresInHours must be a whole number of hours from 1 to 168'],
    [{ ...VALID, expiresInHours: '4' }, 'expiresInHours must be a whole number of hours from 1 to 168'],
  ];
  for (const [input, error] of cases) {
    assert.deepEqual(await grants.record('TASK-001', input), { ok: false, status: 400, error }, JSON.stringify(input));
  }
});

test('record reports the ownership fence refusing the write, and writes nothing', async () => {
  const { runsDir, grants } = await gatedTask();
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'ownership.yaml'), 'just a string\n');
  const result = await grants.record('TASK-001', VALID);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 409);
  assert.match(!result.ok ? result.error : '', /^The ownership fence of TASK-001 refused the grant: \[ownership\] ownership\.yaml is not a mapping/);
  await assert.rejects(fs.access(path.join(runsDir, 'TASK-001', 'authorization.yaml')));
});
