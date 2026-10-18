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

test('a task carried by two trains is proven only when every live carrying train passed (split changes, 2026-10-15)', () => {
  // TASK-EAR-389: Go part on TASK-EAR-402, backoffice tab on TASK-EAR-406. The Go train
  // runs first, so a pass there must not credit prod while the backoffice train waits.
  const goTrain = view([gate('deploy_production', 'pass', { ran: { by: 'devops', ref: 'td:21' } }), gate('production_acceptance', 'pass')]);
  const boTrain = view([gate('deploy_production', 'pending'), gate('production_acceptance', 'pending')]);
  const staged = view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass')]);
  const both = buildReleaseLadder([
    { run: run('TASK-EAR-402', { status: 'completed', updatedAt: '2026-10-14' }), gates: goTrain, carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-406', { status: 'queued', updatedAt: '2026-10-15' }), gates: boTrain, carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-389'), gates: staged },
  ]).products[0].tasks.find((t) => t.id === 'TASK-EAR-389')!;
  assert.equal(both.rungs.deploy_production.status, 'pending');
  assert.equal(both.rungs.deploy_production.via, 'TASK-EAR-406');
  assert.equal(both.highest, 'staging_acceptance');
  assert.equal(both.waitingOnProd, true);
  assert.deepEqual(both.carriedBy, ['TASK-EAR-406', 'TASK-EAR-402']);

  // An aborted or cancelled train never ships, so it does not hold the task back.
  const aborted = buildReleaseLadder([
    { run: run('TASK-EAR-402', { status: 'completed', updatedAt: '2026-10-14' }), gates: goTrain, carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-363', { status: 'cancelled', updatedAt: '2026-09-17' }), gates: boTrain, carries: ['TASK-EAR-389'] },
    { run: run('TASK-EAR-389'), gates: staged },
  ]).products[0].tasks.find((t) => t.id === 'TASK-EAR-389')!;
  assert.equal(aborted.rungs.deploy_production.status, 'pass');
  assert.equal(aborted.rungs.deploy_production.via, 'TASK-EAR-402');
  assert.deepEqual(aborted.carriedBy, ['TASK-EAR-402']);
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

test('unblockedByProdRun lists open tasks waiting on prod_run, with the train ref when recorded', () => {
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-391', { status: 'blocked' }), gates: null, waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] },
    { run: run('TASK-EAR-368', { status: 'blocked' }), gates: null, waitsOn: [{ kind: 'prod_run' }, { kind: 'qa' }] },
    { run: run('TASK-EAR-369', { status: 'blocked' }), gates: null, waitsOn: [{ kind: 'aws_permission' }] },
    { run: run('TASK-EAR-300', { status: 'completed' }), gates: null, waitsOn: [{ kind: 'prod_run' }] },
  ]);
  assert.deepEqual(ladder.products[0].unblockedByProdRun, [
    { id: 'TASK-EAR-368', title: 'TASK-EAR-368 title' },
    { id: 'TASK-EAR-391', title: 'TASK-EAR-391 title', ref: 'TASK-EAR-402' },
  ]);
});

test('trains are the production run: not counted as waiting on prod, not listed as unblocked by their own run; pendingTrains names each train still due', () => {
  const staged = view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass')]);
  const pending = view([gate('deploy_production', 'pending'), gate('production_acceptance', 'pending')]);
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-402', { status: 'blocked', updatedAt: '2026-10-14' }), gates: pending, carries: ['TASK-EAR-389', 'TASK-EAR-392'], waitsOn: [{ kind: 'prod_run' }] },
    { run: run('TASK-EAR-406', { status: 'running', updatedAt: '2026-10-15' }), gates: pending, carries: ['TASK-EAR-389', 'TASK-EAR-396'], waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] },
    { run: run('TASK-EAR-389'), gates: staged },
    { run: run('TASK-EAR-392'), gates: staged },
    { run: run('TASK-EAR-396'), gates: staged },
    { run: run('TASK-EAR-391', { status: 'blocked' }), gates: null, waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] },
  ]);
  const ear = ladder.products[0];
  const byId = (id: string) => ear.tasks.find((t) => t.id === id)!;
  assert.deepEqual(byId('TASK-EAR-389').pendingTrains, ['TASK-EAR-406', 'TASK-EAR-402']);
  assert.deepEqual(byId('TASK-EAR-392').pendingTrains, ['TASK-EAR-402']);
  assert.deepEqual(byId('TASK-EAR-396').pendingTrains, ['TASK-EAR-406']);
  assert.deepEqual(byId('TASK-EAR-402').pendingTrains, []);
  assert.equal(ear.counts.waitingOnProd, 3, 'the three carried tasks, not the two trains');
  // A train waiting on its OWN run is not listed; TASK-EAR-406 waits on TASK-EAR-402, a real wait
  // (rule narrowed 2026-10-15 in the Command review: the first version also dropped 406).
  assert.deepEqual(ear.unblockedByProdRun.map((t) => t.id), ['TASK-EAR-391', 'TASK-EAR-406']);
});

test('a carried task is listed once (under what the train would prove), and trains are counted apart from tasks', () => {
  const staged = view([gate('implementation_verification', 'pass'), gate('deploy_staging', 'pass'), gate('staging_acceptance', 'pass')]);
  const pending = view([gate('deploy_production', 'pending'), gate('production_acceptance', 'pending')]);
  const ear = buildReleaseLadder([
    { run: run('TASK-EAR-402', { status: 'blocked' }), gates: pending, carries: ['TASK-EAR-391'], waitsOn: [{ kind: 'prod_run' }] },
    { run: run('TASK-EAR-391', { status: 'blocked' }), gates: staged, waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] },
    { run: run('TASK-EAR-368', { status: 'blocked' }), gates: null, waitsOn: [{ kind: 'prod_run' }] },
  ]).products[0];
  assert.deepEqual(ear.unblockedByProdRun.map((t) => t.id), ['TASK-EAR-368']);
  assert.equal(ear.counts.trains, 1);
  assert.equal(ear.counts.byHighest.none, 0, 'the train is not "no rung yet"');
  assert.equal(ear.counts.byHighest.staging_acceptance, 1);
  assert.equal(ear.tasks.length, 2, 'the train still has its table row');
});

test('authenticated_staging stands in for staging_acceptance when the task has none, so an uncarried one is flagged', () => {
  const ladder = buildReleaseLadder([
    // TASK-EAR-388's shape: done, only authenticated_staging (pass), no prod gates, no train.
    { run: run('TASK-EAR-388'), gates: view([gate('authenticated_staging', 'pass', { ran: { by: 'dev', ref: 'sha-3f3601b' } })]) },
    // Its own staging_acceptance wins over the alias.
    { run: run('TASK-EAR-500'), gates: view([gate('staging_acceptance', 'pending'), gate('authenticated_staging', 'pass')]) },
  ]);
  const t388 = ladder.products[0].tasks.find((t) => t.id === 'TASK-EAR-388')!;
  assert.equal(t388.highest, 'staging_acceptance');
  assert.deepEqual(t388.rungs.staging_acceptance, { status: 'pass', ran: { by: 'dev', ref: 'sha-3f3601b' }, grant: null, from: 'authenticated_staging' });
  assert.deepEqual(t388.extra, []);
  assert.equal(t388.noProdGates, true);
  const t500 = ladder.products[0].tasks.find((t) => t.id === 'TASK-EAR-500')!;
  assert.equal(t500.rungs.staging_acceptance.status, 'pending');
  assert.equal(t500.rungs.staging_acceptance.from, undefined);
  assert.deepEqual(t500.extra, [{ name: 'authenticated_staging', status: 'pass' }]);
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

test('an aborted task is left out of the ladder and its tally, and counted apart', () => {
  // 2026-10-17: TASK-VS-030 (superseded by VS-040) was aborted with its five gates set to na,
  // and still sat in VerifySlip's table as open work, counted under "no rung yet".
  const na = ['implementation_verification', 'deploy_staging', 'staging_acceptance', 'deploy_production', 'production_acceptance'].map((g) => gate(g, 'na'));
  const ladder = buildReleaseLadder([
    { run: run('TASK-VS-30', { status: 'cancelled', currentStep: 'aborted' }), gates: view(na) },
    { run: run('TASK-VS-40', { status: 'running' }), gates: view([gate('implementation_verification', 'pending')]) },
    { run: run('TASK-VS-41', { status: 'cancelled', currentStep: 'aborted' }), gates: null },
  ]);
  const vs = ladder.products[0];
  assert.deepEqual(vs.tasks.map((t) => t.id), ['TASK-VS-40']);
  assert.equal(vs.counts.byHighest.none, 1);
  assert.equal(vs.counts.aborted, 1);
  assert.deepEqual(vs.noGates.map((r) => r.id), ['TASK-VS-41'], 'an aborted run without gates stays in the no-gates list, as before');
});

test('the knowledge_closeout gate every task carries is not a delivery gate: a task with only it stays under no gates', () => {
  const ladder = buildReleaseLadder([
    { run: run('TASK-EAR-950', { status: 'running' }), gates: view([gate('knowledge_closeout', 'pending')]) },
    { run: run('TASK-EAR-951'), gates: view([gate('implementation_verification', 'pass'), gate('knowledge_closeout', 'pass')]) },
  ]);
  const ear = ladder.products[0];
  assert.deepEqual(ear.noGates.map((r) => r.id), ['TASK-EAR-950']);
  assert.equal(ear.counts.noGates, 1);
  assert.deepEqual(ear.tasks.map((t) => t.id), ['TASK-EAR-951']);
  assert.deepEqual(ear.tasks[0].extra, [{ name: 'knowledge_closeout', status: 'pass' }], 'still listed with the other gates on a delivery task');
  // Unreadable gate state is never hidden behind the no-gates list.
  const unreadable = buildReleaseLadder([{ run: run('TASK-EAR-952'), gates: view([gate('knowledge_closeout', 'pending')], false) }]);
  assert.equal(unreadable.products[0].counts.unreadable, 1);
});
