import test from 'node:test';
import assert from 'node:assert/strict';
import type { GateEntry, GateView, RunSummary } from '@shared/types';
import { buildReleaseLadder, ladderTask, taskPrefix } from './releaseLadder';

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, title: `${id} title`, status: 'completed', runPath: `runs/${id}`, updatedAt: '2026-10-14', ...over });
const gate = (name: string, status: string, over: Partial<GateEntry> = {}): GateEntry => ({
  name, status, resolved: status !== 'pending', waitsOn: [], requiresAuthorization: null, grant: null, requiresRecord: false,
  ran: status === 'pass' ? { by: 'claude-conductor', ref: 'abc123' } : null, passable: false, unresolvedReason: null, detail: '', ...over,
});
const view = (gates: GateEntry[], readable = true): GateView => ({
  readable, problem: readable ? null : 'authorization.yaml unreadable', finishedPhase: null,
  summary: { total: gates.length, resolved: 0, passable: 0, byStatus: {} }, gates,
});

test('taskPrefix reads the project code', () => {
  assert.equal(taskPrefix('TASK-EAR-404'), 'EAR');
  assert.equal(buildReleaseLadder([{ run: run('TASK-123'), gates: null }]).products[0].name, 'Legacy runs (no prefix)');
  assert.equal(taskPrefix('TASK-VS-025'), 'VS');
  assert.equal(taskPrefix('TASK-123'), 'TASK');
});

test('highest rung is the last passed ladder gate; extra gates are listed, absent rungs marked', () => {
  const t = ladderTask(run('TASK-VS-025'), view([
    gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass'),
    gate('deploy_production', 'pass', { ran: { by: 'devops', ref: '53300', url: 'https://x/53300' } }), gate('production_acceptance', 'pending'),
    gate('shared_lib_publication', 'pass'),
  ]));
  assert.equal(t.highest, 'deploy_production');
  assert.equal(t.waitingOnProd, true);
  assert.deepEqual(t.rungs.deploy_production.ran, { by: 'devops', ref: '53300', url: 'https://x/53300' });
  assert.deepEqual(t.extra, [{ name: 'shared_lib_publication', status: 'pass' }]);
  assert.equal(ladderTask(run('TASK-EAR-1'), view([gate('implementation_verification', 'pass')])).rungs.deploy_staging.status, 'absent');
});

test('waitingOnProd: a staging-accepted task whose next pending rung is a prod gate; not one still pending on staging', () => {
  const staged = ladderTask(run('TASK-EAR-390'), view([
    gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass'), gate('deploy_production', 'pending'),
  ]));
  assert.equal(staged.highest, 'staging_acceptance');
  assert.equal(staged.waitingOnProd, true);
  assert.equal(staged.noProdGates, false);
  // Staging accepted with no production gate declared: honest about what a prod run would (not) prove.
  const noProd = ladderTask(run('TASK-EAR-392'), view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass')]));
  assert.equal(noProd.waitingOnProd, false);
  assert.equal(noProd.noProdGates, true);
  const early = ladderTask(run('TASK-EAR-401'), view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pending'), gate('deploy_production', 'pending')]));
  assert.equal(early.waitingOnProd, false);
  // na skips a rung without blocking: staging_acceptance na, prod next.
  const skipped = ladderTask(run('TASK-EAR-402'), view([gate('deploy_staging', 'pass'), gate('staging_acceptance', 'na'), gate('deploy_production', 'pending')]));
  assert.equal(skipped.waitingOnProd, true);
});

test('unreadable gate state is reported, never shown as a clean ladder', () => {
  const t = ladderTask(run('TASK-EAR-9'), view([gate('implementation_verification', 'pass')], false));
  assert.equal(t.unreadable, 'authorization.yaml unreadable');
  assert.equal(t.waitingOnProd, false);
});

test('a release train credits carried tasks: prod rungs come from its same-named gates, marked via the train', () => {
  const train = view([gate('deploy_production', 'pass', { ran: { by: 'devops', ref: 'td:21' } }), gate('production_acceptance', 'pending')]);
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-402', { status: 'blocked', updatedAt: '2026-10-14' }), gates: train, carries: ['TASK-EAR-389', 'TASK-EAR-390', 'TASK-EAR-100'] },
    { run: run('TASK-EAR-389'), gates: view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass')]) },
    // Declares its own production gate: the train never overrides it.
    { run: run('TASK-EAR-390'), gates: view([gate('staging_acceptance', 'pass'), gate('deploy_production', 'pending')]) },
    // Pre-contract run with no gates of its own: the train still proves its prod rungs.
    { run: run('TASK-EAR-100'), gates: null },
  ]);
  const ear = ladder.products[0];
  const t389 = ear.tasks.find((t) => t.id === 'TASK-EAR-389')!;
  assert.deepEqual(t389.rungs.deploy_production, { status: 'pass', ran: { by: 'devops', ref: 'td:21' }, grant: null, via: 'TASK-EAR-402' });
  assert.equal(t389.rungs.production_acceptance.via, 'TASK-EAR-402');
  assert.equal(t389.highest, 'deploy_production');
  assert.equal(t389.waitingOnProd, true);
  assert.equal(t389.noProdGates, false);
  assert.deepEqual(t389.carriedBy, ['TASK-EAR-402']);
  const t390 = ear.tasks.find((t) => t.id === 'TASK-EAR-390')!;
  assert.equal(t390.rungs.deploy_production.via, undefined);
  assert.equal(t390.rungs.deploy_production.status, 'pending');
  const t100 = ear.tasks.find((t) => t.id === 'TASK-EAR-100')!;
  assert.equal(t100.highest, 'deploy_production');
  assert.equal(ear.noGates.length, 0);
  assert.deepEqual(ear.tasks.find((t) => t.id === 'TASK-EAR-402')!.carries, ['TASK-EAR-389', 'TASK-EAR-390', 'TASK-EAR-100']);
});

test('a train with differently named gates or unreadable gates credits nothing', () => {
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-402'), gates: view([gate('train_prepared', 'pass'), gate('prod_boot_acceptance', 'pending')]), carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-403'), gates: view([gate('deploy_production', 'pass')], false), carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-389'), gates: view([gate('staging_acceptance', 'pass')]) },
  ]);
  const t = ladder.products[0].tasks.find((x) => x.id === 'TASK-EAR-389')!;
  assert.equal(t.rungs.deploy_production.status, 'absent');
  assert.equal(t.noProdGates, true);
  assert.deepEqual(t.carriedBy, ['TASK-EAR-402']);
});

test('products group by prefix; done runs without gates land in noGates, counts add up, gated tasks sort highest first', () => {
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-1', { updatedAt: '2026-10-01' }), gates: view([gate('implementation_verification', 'pass')]) },
    { run: run('TASK-EAR-2', { updatedAt: '2026-10-02' }), gates: view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass'), gate('deploy_production', 'pending')]) },
    { run: run('TASK-EAR-3'), gates: null },
    { run: run('TASK-VS-1'), gates: view([gate('production_acceptance', 'pass')]) },
    { run: run('TASK-VS-2'), gates: view([gate('implementation_verification', 'pending')], false) },
  ]);
  assert.deepEqual(ladder.products.map((p) => [p.name, p.tasks.length, p.noGates.length]), [['Games Labs', 2, 1], ['VerifySlip', 2, 0]]);
  const ear = ladder.products[0];
  assert.deepEqual(ear.tasks.map((t) => t.id), ['TASK-EAR-2', 'TASK-EAR-1']);
  assert.equal(ear.counts.byHighest.staging_acceptance, 1);
  assert.equal(ear.counts.byHighest.implementation_verification, 1);
  assert.equal(ear.counts.waitingOnProd, 1);
  assert.equal(ear.counts.noProdGates, 0);
  assert.equal(ear.counts.noGates, 1);
  const vs = ladder.products[1];
  assert.equal(vs.counts.byHighest.production_acceptance, 1);
  assert.equal(vs.counts.byHighest.none, 1);
  assert.equal(vs.counts.unreadable, 1);
  assert.equal(ladder.ladder[4].label, 'Prod accepted');
});
