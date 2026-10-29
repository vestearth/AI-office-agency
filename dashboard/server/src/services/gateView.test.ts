import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { GateViewService, hasCompletionGates, parseGateView, type ExpiryTimers } from './gateView';

const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb');

const GATE = {
  name: 'deploy', status: 'pending', resolved: false, waits_on: [], requires_authorization: 'deploy_staging',
  grant: 'missing', grant_valid_until: null, requires_record: false, ran: null, passable: false, unresolved_reason: null,
  detail: 'waits for a deploy_staging grant',
};
const VIEW = {
  readable: true, problem: null, finished_phase: null, ledger_readable: true,
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
    readable: true, problem: null, finishedPhase: null, ledgerReadable: true,
    summary: { total: 1, resolved: 0, passable: 0, byStatus: { pending: 1 } },
    gates: [{
      name: 'deploy', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: 'deploy_staging',
      grant: 'missing', grantValidUntil: null, requiresRecord: false, ran: null, passable: false, unresolvedReason: null,
      detail: 'waits for a deploy_staging grant',
    }],
  });
});

test('parseGateView rejects a wrong shape instead of guessing', () => {
  const bad: unknown[] = [
    { ...VIEW, readable: 'yes' },
    { ...VIEW, ledger_readable: 'yes' },
    { ...VIEW, ledger_readable: undefined },
    { ...VIEW, gates: [{ ...GATE, grant_valid_until: 5 }] },
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

test('parseGateView keeps an unreadable ledger and a grant expiry', () => {
  const view = parseGateView(JSON.stringify({
    ...VIEW, ledger_readable: false, gates: [{ ...GATE, grant: 'available', grant_valid_until: '2026-10-29T12:00:00Z' }],
  }));
  assert.equal(view.ledgerReadable, false);
  assert.equal(view.gates[0].grantValidUntil, '2026-10-29T12:00:00Z');
  assert.equal(parseGateView(JSON.stringify({ ...VIEW, readable: false, ledger_readable: null, gates: [] })).ledgerReadable, null);
});

test('load runs at most `concurrency` gate views at once, and every load still resolves', async () => {
  const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-view-cap-')), 'log');
  const mark = (sign: string) => `File.open(${JSON.stringify(log)}, "a") { |f| f.flock(File::LOCK_EX); f.puts "${sign}" }`;
  const script = await stubScript(`${mark('+')}\nsleep 0.15\n${mark('-')}\nputs ${JSON.stringify(JSON.stringify(VIEW))}\n`);
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: {} });
  const service = new GateViewService(script, 5_000, 2);

  const views = await Promise.all(Array.from({ length: 6 }, () => service.load(dir)));

  assert.equal(views.filter((view) => view.readable).length, 6);
  let open = 0;
  let peak = 0;
  for (const sign of (await fs.readFile(log, 'utf8')).trim().split('\n')) {
    open += sign === '+' ? 1 : -1;
    peak = Math.max(peak, open);
  }
  assert.equal(peak, 2);
});

/** Timers for the expiry watch: a fixed clock and a record of what was scheduled. */
function fakeTimers(nowMs: number) {
  const scheduled: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const timers: ExpiryTimers = {
    now: () => nowMs,
    set: (callback, ms) => {
      scheduled.push({ callback, ms, cleared: false });
      return scheduled.length as unknown as NodeJS.Timeout;
    },
    clear: (timer) => { scheduled[(timer as unknown as number) - 1].cleared = true; },
  };
  return { timers, scheduled };
}

/** A gate-view stub whose available grant expires at the time in <task_dir>/until (absent: never). */
async function expiryScript(): Promise<string> {
  const gate = { ...GATE, grant: 'available', passable: true };
  return stubScript(`require "json"
until_file = File.join(ARGV[0], "until")
valid_until = File.exist?(until_file) ? File.read(until_file).strip : nil
view = JSON.parse(${JSON.stringify(JSON.stringify({ ...VIEW, gates: [gate] }))})
view["gates"][0]["grant_valid_until"] = valid_until
puts JSON.generate(view)
`);
}

async function taskWithExpiry(validUntil: string | null): Promise<string> {
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: {} });
  if (validUntil) await fs.writeFile(path.join(dir, 'until'), validUntil);
  return dir;
}

test('an available grant that expires is announced once, just after its expiry, for its task', async () => {
  const { timers, scheduled } = fakeTimers(Date.parse('2026-10-29T10:00:00Z'));
  const service = new GateViewService(await expiryScript(), 5_000, 4, timers);
  const expired: string[] = [];
  service.onGrantExpiry((taskDir) => expired.push(taskDir));
  const dir = await taskWithExpiry('2026-10-29T11:00:00Z');

  await service.load(dir);
  await service.load(dir);

  assert.equal(scheduled.length, 1, 'the same expiry is not scheduled twice');
  assert.equal(scheduled[0].ms, 60 * 60_000 + 1_000);
  scheduled[0].callback();
  assert.deepEqual(expired, [dir]);
  await service.load(dir);
  assert.equal(scheduled.length, 2, 'after it fires, the next load watches again');
});

test('the expiry watch keeps only the earliest expiry and ignores grants that never expire', async () => {
  const { timers, scheduled } = fakeTimers(Date.parse('2026-10-29T10:00:00Z'));
  const service = new GateViewService(await expiryScript(), 5_000, 4, timers);
  const expired: string[] = [];
  service.onGrantExpiry((taskDir) => expired.push(taskDir));

  await service.load(await taskWithExpiry('2026-10-29T12:00:00Z'));
  await service.load(await taskWithExpiry(null));
  await service.load(await taskWithExpiry('2026-10-29T12:30:00Z'));
  assert.deepEqual(scheduled.map(({ ms, cleared }) => [ms, cleared]), [[2 * 60 * 60_000 + 1_000, false]]);

  const sooner = await taskWithExpiry('2026-10-29T10:30:00Z');
  await service.load(sooner);
  assert.deepEqual(scheduled.map(({ ms, cleared }) => [ms, cleared]), [[2 * 60 * 60_000 + 1_000, true], [30 * 60_000 + 1_000, false]]);
  scheduled[1].callback();
  assert.deepEqual(expired, [sooner]);

  await service.load(await taskWithExpiry('2026-10-29T09:00:00Z'));
  assert.equal(scheduled.at(-1)?.ms, 1_000, 'an expiry already past refreshes right away');
});
