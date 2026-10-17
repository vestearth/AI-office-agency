import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { authorizationCheck, decideNextStep, parseDecision, reviewVerdict, taskHold } from './chainOffice';
import { makeOffice, VALID_DEV_OUTPUT } from '../testing/officeFixture';

// The office answers a role chain asks between steps, from the real scripts in a
// throwaway office (officeFixture.ts copies them; runs/ belongs to the test).

const TASK = 'TASK-EAR-7';

const status = (extra: string) => `task_id: ${TASK}\nphase: in_review\nstate: in_review\niteration: 2\ncurrent_agent: reviewer\n${extra}`;

test('parseDecision reads the one line decide-next-step.rb prints', () => {
  assert.deepEqual(parseDecision('next=reviewer terminal=false\n'), { next: 'reviewer', terminal: false });
  assert.deepEqual(parseDecision('next= terminal=false'), { next: '', terminal: false });
  assert.deepEqual(parseDecision('next=done terminal=true'), { next: 'done', terminal: true });
  assert.equal(parseDecision('Usage: ...'), null);
});

test('decide-next-step.rb: next_action, the reviewer verdict, and a completion gate holding done', async () => {
  const office = makeOffice();
  try {
    const dir = office.task(TASK);
    fs.writeFileSync(path.join(dir, 'dev-output.yaml'), VALID_DEV_OUTPUT);
    assert.deepEqual(await decideNextStep(office.root, TASK, 'dev'), { next: 'reviewer', terminal: false });

    fs.writeFileSync(path.join(dir, 'reviewer-output.yaml'), 'summary: "ok"\nreview_verdict: changes_requested\nissues: []\n');
    assert.deepEqual(await decideNextStep(office.root, TASK, 'reviewer'), { next: 'debugger', terminal: false });
    assert.equal(reviewVerdict(office.runs, TASK), 'changes_requested');

    fs.writeFileSync(path.join(dir, 'reviewer-output.yaml'), 'summary: "ok"\nreview_verdict: approved\nissues: []\n');
    assert.deepEqual(await decideNextStep(office.root, TASK, 'reviewer'), { next: 'done', terminal: true });

    fs.writeFileSync(path.join(dir, 'status.yaml'), status('completion_gates:\n  staging_acceptance:\n    status: pending\n'));
    const held = await decideNextStep(office.root, TASK, 'reviewer');
    assert.deepEqual([held.next, held.terminal], ['', false]);
    assert.match(held.note ?? '', /Completion blocked: .*staging_acceptance/);
  } finally { office.cleanup(); }
});

test('decide-next-step.rb with no output file for the role falls back to the phase map', async () => {
  const office = makeOffice();
  try {
    office.task(TASK);
    assert.deepEqual(await decideNextStep(office.root, TASK, 'pm'), { next: 'dev', terminal: false });
  } finally { office.cleanup(); }
});

test('authorization-dispatch-check.rb: a pending deploy gate needs a grant for devops; other roles are not checked', async () => {
  const office = makeOffice();
  try {
    const dir = office.task(TASK);
    assert.deepEqual(await authorizationCheck(office.root, TASK, 'devops'), { ok: true, text: 'no authorization needed' });
    fs.writeFileSync(path.join(dir, 'status.yaml'), status('completion_gates:\n  deploy_production:\n    status: pending\n    requires_authorization: deploy_production\n'));
    const devops = await authorizationCheck(office.root, TASK, 'devops');
    assert.equal(devops.ok, false);
    assert.match(devops.text, /the devops step needs an authorization grant for deploy_production \(authorization_dispatch mode warn_only\)/);
    assert.deepEqual(await authorizationCheck(office.root, TASK, 'dev'), { ok: true, text: 'no authorization needed' });
    fs.writeFileSync(path.join(dir, 'status.yaml'), status('completion_gates: [broken]\n'));
    assert.match((await authorizationCheck(office.root, TASK, 'devops')).text, /could not judge/);
  } finally { office.cleanup(); }
});

test('taskHold reads status.yaml: blocked, waits, finished, escalated, unreadable; null when free', () => {
  const office = makeOffice();
  try {
    const dir = office.task(TASK);
    assert.equal(taskHold(office.runs, TASK), null);
    const write = (s: string) => fs.writeFileSync(path.join(dir, 'status.yaml'), s);
    write(status('waits_on:\n  - kind: operator_approval\n    ref: TASK-EAR-8\n'));
    assert.deepEqual(taskHold(office.runs, TASK), { kind: 'blocked', reason: 'the task is held: waits on operator_approval:TASK-EAR-8' });
    write(`task_id: ${TASK}\nphase: blocked\nblocked_on: [TASK-EAR-8]\n`);
    assert.deepEqual(taskHold(office.runs, TASK), { kind: 'blocked', reason: 'the task is blocked: blocked on TASK-EAR-8' });
    write(`task_id: ${TASK}\nphase: done\n`);
    assert.equal(taskHold(office.runs, TASK)!.kind, 'done');
    write(`task_id: ${TASK}\nphase: escalated\n`);
    assert.equal(taskHold(office.runs, TASK)!.kind, 'escalated');
    write(`task_id: ${TASK}\nphase: validation_failed\n`);
    assert.equal(taskHold(office.runs, TASK)!.kind, 'verification');
    write(': : :\n  - [');
    assert.match(taskHold(office.runs, TASK)!.reason, /cannot be read/);
  } finally { office.cleanup(); }
});
