import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { RunSummary } from '@shared/types';
import {
  AwsCall, ClusterConfig, ProdSignalsService, SignalsConfig, classifyCoverage, collapseFailures, corpusHas, errorPhrase,
  groupFailures, parseLine, pathTerm, readErrorEvents, redact,
} from './prodSignals';
import { RunScanner } from './runScanner';

// Real line shapes seen on 2026-10-15: slip-api (request_id, a "reports request failed"
// line plus its access line), api-gateway (x-correlation-id, query string in path), and a
// plain-text Go log with a leading timestamp (Missions).
const T = Date.parse('2026-10-15T03:43:00Z');
const slipReport = (rid: string, t = T) => [
  { message: JSON.stringify({ time: '…', level: 'ERROR', msg: 'reports request failed', method: 'GET', path: '/v1/admin/verifications/daily', request_id: rid, error: 'admin daily verifications: admin daily verifications: timeout: context deadline exceeded' }), timestamp: t },
  { message: JSON.stringify({ time: '…', level: 'ERROR', msg: 'http request completed', method: 'GET', path: '/v1/admin/verifications/daily', status: 500, request_id: rid, duration_ms: 10001 }), timestamp: t },
];
const gateway = (cid: string, t = T) => ({
  message: JSON.stringify({ level: 'error', method: 'GET', path: '/api/v1/admin/reports/game/019cad64-8110-77c0-ab03-b7b097bc7dcf/players?search&limit=10', status: 500, 'x-correlation-id': cid }),
  timestamp: t,
});
const cluster: ClusterConfig = { cluster: 'upslip-production-ecs', env: 'prod', product: 'VerifySlip', taskPrefix: 'VS' };
const parse = (events: { message: string; timestamp: number }[]) => events.map((e) => parseLine(e.message, e.timestamp));

test('parseLine reads JSON levels, strips the query string, and detects plain-text errors after a timestamp', () => {
  const g = parseLine(gateway('c1').message, T);
  assert.equal(g.isError, true);
  assert.equal(g.path, '/api/v1/admin/reports/game/019cad64-8110-77c0-ab03-b7b097bc7dcf/players');
  assert.equal(g.requestKey, 'c1');
  const plain = parseLine('2026/10/09 07:15:13 [schedule-worker] AcquireScheduleLock error: driver: bad connection', T);
  assert.equal(plain.isError, true);
  assert.equal(plain.msg, '[schedule-worker] AcquireScheduleLock error: driver: bad connection');
  // A 4xx warning carrying "outcome":"error" is not an error.
  assert.equal(parseLine(JSON.stringify({ level: 'WARN', outcome: 'error', status: 401 }), T).isError, false);
});

test('lines sharing a request id are one failure, explained by the line that carries the error', () => {
  const failures = collapseFailures(parse([...slipReport('r1'), ...slipReport('r2')]));
  assert.equal(failures.length, 2);
  assert.equal(failures[0]!.status, 500);
  assert.match(failures[0]!.error, /^admin daily verifications/);
  const [group] = groupFailures({ cluster, service: 'slip-api-production', logGroup: '/ecs/slip-api-production' }, failures);
  assert.equal(group!.failures, 2);
  assert.equal(group!.logLines, 4);
  assert.equal(group!.signature, 'GET /v1/admin/verifications/daily -> 500 admin daily verifications: admin daily verifications: timeout: context deadline exceeded');
  assert.deepEqual(group!.terms, ['/v1/admin/verifications/daily', 'admin daily verifications']);
  assert.equal(group!.searchPhrase, 'admin daily verifications');
  assert.equal(group!.recurring, false);
});

test('ids in paths collapse into one group; failures in two clock hours are recurring', () => {
  const failures = collapseFailures(parse([gateway('a', T), gateway('b', T + 2 * 3_600_000)]));
  const groups = groupFailures({ cluster, service: 'api-gateway-staging', logGroup: '/ecs/api-gateway-staging' }, failures);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.signature, 'GET /api/v1/admin/reports/game/<id>/players -> 500');
  assert.equal(groups[0]!.recurring, true);
  assert.deepEqual(groups[0]!.terms, ['/api/v1/admin/reports/game/']);
});

test('errorPhrase skips generic fragments; pathTerm needs two literal segments', () => {
  const f = collapseFailures(parse([{ message: JSON.stringify({ level: 'ERROR', msg: 'persist duplicate slip attempt failed', error: 'generate verification id: context canceled' }), timestamp: T }]))[0]!;
  assert.equal(errorPhrase(f), 'generate verification id');
  const t = collapseFailures(parse([{ message: JSON.stringify({ level: 'ERROR', msg: 'x', error: 'timeout: context deadline exceeded' }), timestamp: T }]))[0]!;
  assert.equal(errorPhrase(t), '');
  const d = collapseFailures(parse([{ message: JSON.stringify({ level: 'ERROR', msg: 'x', error: 'bank flow day 2026-10-10: summarize bank flows: timeout' }), timestamp: T }]))[0]!;
  assert.equal(errorPhrase(d), 'bank flow day');
  assert.equal(pathTerm('/healthz'), null);
  assert.equal(pathTerm('/v1/merchants/816d9bc9-76f1-4817-89ee-e86dbe5deb2c/branches'), null);
  assert.deepEqual(pathTerm('/v1/slips/verify'), { term: '/v1/slips/verify', exact: true });
});

test('corpusHas: exact path terms need a token boundary; prefixes and phrases are substrings', () => {
  const corpus = 'see `get /v1/admin/verifications?from=x` and /v1/admin/verifications/daily. count verifications timed out';
  assert.equal(corpusHas(corpus, '/v1/admin/verifications'), true);
  assert.equal(corpusHas('only /v1/admin/verifications/daily here', '/v1/admin/verifications'), false);
  assert.equal(corpusHas(corpus, '/v1/admin/'), true);
  assert.equal(corpusHas(corpus, 'Count Verifications'), true);
});

test('redact hides ids, IPs, emails and long numbers but keeps the text', () => {
  assert.equal(
    redact('failed for a@b.co at 10.80.167.237:5432 ref 016287195319DTF03835 id 816d9bc9-76f1-4817-89ee-e86dbe5deb2c: bad'),
    'failed for <email> at <ip> ref <n> id <id>: bad',
  );
});

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, title: `${id} title`, status: 'running', runPath: `runs/${id}`, ...over });

test('coverage: an open run mentioning the signal owns it; a run closed in the window it recurs after; otherwise unowned', () => {
  const now = new Date('2026-10-15T05:00:00Z');
  const group = { terms: ['/v1/admin/verifications/daily', 'admin daily verifications'], taskPrefix: 'VS', lastAt: '2026-10-15T01:50:45Z' };
  const open = classifyCoverage(group, [
    { run: run('TASK-VS-026'), text: 'admin daily verifications: timeout' },
    { run: run('TASK-EAR-1'), text: 'admin daily verifications' }, // other product: ignored
  ], now, 14);
  assert.equal(open.coverage, 'mentioned');
  assert.deepEqual(open.mentionedBy.map((r) => [r.id, r.terms]), [['TASK-VS-026', ['admin daily verifications']]]);

  const closed = classifyCoverage(group, [
    { run: run('TASK-VS-014', { status: 'completed', completedAt: '2026-10-14T05:00:00Z' }), text: '/v1/admin/verifications/daily totals' },
    { run: run('TASK-VS-003', { status: 'completed', completedAt: '2026-09-01T00:00:00Z' }), text: 'admin daily verifications' }, // outside 14 days
    { run: run('TASK-VS-030', { status: 'completed', completedAt: '2026-10-15T04:00:00Z' }), text: 'admin daily verifications' }, // closed after the last failure
  ], now, 14);
  assert.equal(closed.coverage, 'recurs_after');
  assert.deepEqual(closed.recursAfter.map((r) => r.id), ['TASK-VS-014']);

  assert.equal(classifyCoverage(group, [{ run: run('TASK-VS-9'), text: 'unrelated' }], now, 14).coverage, 'unowned');

  // Date-only completedAt: a failure later that same Bangkok day is not "after" the close.
  const sameDay = classifyCoverage({ ...group, lastAt: '2026-10-14T06:00:00Z' },
    [{ run: run('TASK-VS-021', { status: 'completed', completedAt: '2026-10-14' }), text: 'admin daily verifications' }], now, 14);
  assert.equal(sameDay.coverage, 'unowned');
  const nextDay = classifyCoverage(group,
    [{ run: run('TASK-VS-021', { status: 'completed', completedAt: '2026-10-14' }), text: 'admin daily verifications' }], now, 14);
  assert.equal(nextDay.coverage, 'recurs_after');
});

test('readErrorEvents reads every page and stops with truncated at the event cap', async () => {
  const calls: string[][] = [];
  const aws: AwsCall = async (args) => {
    calls.push(args);
    const token = args[args.indexOf('--next-token') + 1];
    if (!args.includes('--next-token')) return { events: [{ message: 'a', timestamp: 1 }], nextToken: 'p2' };
    if (token === 'p2') return { events: [{ message: 'b', timestamp: 2 }], nextToken: 'p3' };
    return { events: [{ message: 'c', timestamp: 3 }] };
  };
  const src = { service: 's', container: 'c', logGroup: '/ecs/s', streamPrefix: 'ecs' };
  const all = await readErrorEvents(aws, src, 0, 10, Date.now() + 60_000);
  assert.deepEqual(all.events.map((e) => e.message), ['a', 'b', 'c']);
  assert.equal(all.truncated, false);
  assert.ok(calls[0]!.includes('--no-paginate'));
  assert.deepEqual(calls[0]!.slice(calls[0]!.indexOf('--log-stream-name-prefix'), calls[0]!.indexOf('--log-stream-name-prefix') + 2), ['--log-stream-name-prefix', 'ecs/c/']);
  const cut = await readErrorEvents(aws, src, 0, 10, Date.now() - 1);
  assert.equal(cut.truncated, true);
  assert.equal(cut.stop, 'deadline');
  assert.equal(cut.events.length, 1);
});

test('service: a cluster with no running service reports not_running instead of "no errors"; groups get coverage from run files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signals-'));
  await fs.mkdir(path.join(dir, 'TASK-VS-026'));
  await fs.writeFile(path.join(dir, 'TASK-VS-026', 'task.md'), 'Admin daily verifications timeouts');
  await fs.writeFile(path.join(dir, 'TASK-VS-026', 'evidence.yaml'), 'not read: not in the corpus allowlist');
  const cfg: SignalsConfig = {
    awsProfile: 'vestearth', region: 'ap-southeast-1', windowHours: 24, closedWindowDays: 14, cacheMinutes: 15,
    clusters: [cluster, { cluster: 'sparqlab-production-ecs', env: 'prod', product: 'Games Labs', taskPrefix: 'EAR' }],
  };
  let calls = 0;
  const aws: AwsCall = async (args) => {
    calls++;
    const clusterName = args[args.indexOf('--cluster') + 1];
    if (args[1] === 'list-services') return { serviceArns: clusterName === 'upslip-production-ecs' ? ['arn/slip-api-production'] : ['arn/games-labs-game-prod'] };
    if (args[1] === 'describe-services') {
      return clusterName === 'upslip-production-ecs'
        ? { services: [{ serviceName: 'slip-api-production', desiredCount: 3, taskDefinition: 'td:87' }] }
        : { services: [{ serviceName: 'games-labs-game-prod', desiredCount: 0, taskDefinition: 'td:1' }] };
    }
    if (args[1] === 'describe-task-definition') {
      return { taskDefinition: { containerDefinitions: [{ name: 'slip-api', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/slip-api-production', 'awslogs-stream-prefix': 'ecs' } } }] } };
    }
    if (args[1] === 'filter-log-events') return { events: [...slipReport('r1'), ...slipReport('r2')] };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const scanner = { listRuns: async () => [run('TASK-VS-026')] } as unknown as RunScanner;
  const service = new ProdSignalsService(scanner, async () => cfg, () => aws, () => new Date('2026-10-15T05:00:00Z'), dir);
  const res = await service.get('prod');
  assert.deepEqual(res.clusters.map((c) => [c.cluster, c.status, c.servicesRunning, c.sourcesRead]), [
    ['upslip-production-ecs', 'ok', 1, 1],
    ['sparqlab-production-ecs', 'not_running', 0, 0],
  ]);
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0]!.failures, 2);
  assert.equal(res.groups[0]!.coverage, 'mentioned');
  assert.deepEqual(res.groups[0]!.mentionedBy.map((r) => r.id), ['TASK-VS-026']);
  assert.deepEqual(res.counts, { unowned: 0, recurs_after: 0, mentioned: 1 });
  // Cached within cache_minutes: a second call makes no AWS calls; refresh does.
  const before = calls;
  await service.get('prod');
  assert.equal(calls, before);
  await service.get('prod', true);
  assert.ok(calls > before);
  await fs.rm(dir, { recursive: true, force: true });
});

test('service: an AWS failure marks the cluster as error and keeps the response', async () => {
  const cfg: SignalsConfig = { awsProfile: 'vestearth', region: 'ap-southeast-1', windowHours: 24, closedWindowDays: 14, cacheMinutes: 15, clusters: [cluster] };
  const scanner = { listRuns: async () => [] } as unknown as RunScanner;
  const service = new ProdSignalsService(scanner, async () => cfg, () => async () => { throw new Error('Unable to locate credentials'); });
  const res = await service.get('prod');
  assert.equal(res.clusters[0]!.status, 'error');
  assert.equal(res.clusters[0]!.error, 'Unable to locate credentials');
  assert.deepEqual(res.groups, []);
});
