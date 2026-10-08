import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { GateViewService, hasCompletionGates, parseGateView } from './gateView';

const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb');

const GATE = {
  name: 'deploy', status: 'pending', resolved: false, waits_on: [], requires_authorization: 'deploy_staging',
  grant: 'missing', requires_record: false, ran: null, passable: false, unresolved_reason: null,
  detail: 'waits for a deploy_staging grant',
};
const VIEW = {
  readable: true, problem: null, finished_phase: null,
  summary: { total: 1, resolved: 0, passable: 0, by_status: { pending: 1 } },
  gates: [GATE],
};

async function taskDir(status: Record<string, unknown>): Promise<string> {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-view-')), 'TASK-001');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.yaml'), yaml.dump(status));
  return dir;
}

async function stubScript(body: string): Promise<string> {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-view-stub-')), 'stub.rb');
  await fs.writeFile(file, body);
  return file;
}

test('parseGateView maps the script JSON to the camelCase GateView', () => {
  const view = parseGateView(JSON.stringify(VIEW));
  assert.deepEqual(view, {
    readable: true, problem: null, finishedPhase: null,
    summary: { total: 1, resolved: 0, passable: 0, byStatus: { pending: 1 } },
    gates: [{
      name: 'deploy', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: 'deploy_staging',
      grant: 'missing', requiresRecord: false, ran: null, passable: false, unresolvedReason: null,
      detail: 'waits for a deploy_staging grant',
    }],
  });
});

test('parseGateView rejects a wrong shape instead of guessing', () => {
  const bad: unknown[] = [
    { ...VIEW, readable: 'yes' },
    { ...VIEW, gates: undefined },
    { ...VIEW, summary: { total: 1, resolved: 0, by_status: {} } },
    { ...VIEW, gates: [{ ...GATE, grant: 'maybe' }] },
    { ...VIEW, gates: [{ ...GATE, waits_on: 'a' }] },
    { ...VIEW, gates: [{ ...GATE, ran: { by: 1 } }] },
    { ...VIEW, gates: [{ ...GATE, detail: undefined }] },
    [VIEW],
  ];
  for (const value of bad) {
    assert.throws(() => parseGateView(JSON.stringify(value)), Error, JSON.stringify(value));
  }
  assert.throws(() => parseGateView('not json'));
});

test('hasCompletionGates is true for any completion_gates value, so a broken one is still reported', () => {
  assert.equal(hasCompletionGates({ phase: 'assigned' }), false);
  assert.equal(hasCompletionGates({ completion_gates: {} }), true);
  assert.equal(hasCompletionGates({ completion_gates: 'oops' }), true);
  assert.equal(hasCompletionGates({ completion_gates: null }), true);
});

test('load runs the real script and returns the CLI text per gate', async () => {
  const dir = await taskDir({
    task_id: 'TASK-001', phase: 'assigned',
    completion_gates: { smoke: { status: 'pending', actor: 'pm', reason: 's', updated_at: '2026-10-08T01:00:00Z' } },
  });
  const view = await new GateViewService(SCRIPT).load(dir);
  assert.equal(view.readable, true, view.problem ?? '');
  assert.deepEqual(view.summary, { total: 1, resolved: 0, passable: 1, byStatus: { pending: 1 } });
  assert.equal(view.gates[0].name, 'smoke');
  assert.equal(view.gates[0].passable, true);
  assert.equal(view.gates[0].detail, 'can pass now');
});

test('load passes through a view the script reports as unreadable', async () => {
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: 'oops' });
  const view = await new GateViewService(SCRIPT).load(dir);
  assert.equal(view.readable, false);
  assert.equal(view.problem, 'completion_gates is not a map');
  assert.deepEqual(view.gates, []);
});

test('load fails closed: every failure is an unreadable view, never a rejection or an empty all-clear', async () => {
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: {} });
  const cases: Array<[string, GateViewService, RegExp]> = [
    ['missing script', new GateViewService(path.join(os.tmpdir(), 'no-such-gate-view.rb')), /^gate view unavailable: ruby exited 1$/],
    ['non-JSON output', new GateViewService(await stubScript('puts "not json"\n')), /^gate view unavailable: unexpected output/],
    ['wrong shape', new GateViewService(await stubScript('puts \'{"readable":true}\'\n')), /^gate view unavailable: unexpected output/],
    ['non-zero exit', new GateViewService(await stubScript('exit 1\n')), /^gate view unavailable: ruby exited 1$/],
    ['timeout', new GateViewService(await stubScript('sleep 5\n'), 200), /^gate view unavailable: timed out after 200 ms$/],
  ];
  for (const [label, service, problem] of cases) {
    const view = await service.load(dir);
    assert.equal(view.readable, false, label);
    assert.match(view.problem ?? '', problem, label);
    assert.deepEqual(view.gates, [], label);
    assert.deepEqual(view.summary, { total: 0, resolved: 0, passable: 0, byStatus: {} }, label);
  }
});
