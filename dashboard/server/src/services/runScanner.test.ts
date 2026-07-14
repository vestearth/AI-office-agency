import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { sortRunsByPriority, asObject, RunScanner, mapPhaseToRunStatus, classifyActor, latestConductor, buildNextActionPreview } from './runScanner';
import type { RunSummary } from '@shared/types';

test('sortRunsByPriority puts active work first, then newest task id', () => {
  const runs: RunSummary[] = [
    { id: 'TASK-001', title: 'old running', status: 'running', runPath: 'runs/TASK-001' },
    { id: 'TASK-099', title: 'completed latest id', status: 'completed', runPath: 'runs/TASK-099' },
    { id: 'TASK-040', title: 'blocked', status: 'blocked', runPath: 'runs/TASK-040' },
    { id: 'TASK-020', title: 'waiting', status: 'waiting_review', runPath: 'runs/TASK-020' },
    { id: 'TASK-050', title: 'failed', status: 'failed', runPath: 'runs/TASK-050' },
  ];

  assert.deepEqual(sortRunsByPriority(runs).map(run => run.id), [
    'TASK-001',
    'TASK-040',
    'TASK-020',
    'TASK-050',
    'TASK-099',
  ]);
});

test('mapPhaseToRunStatus maps phases by exact enum (no substring guessing)', () => {
  // Phases that the old fuzzy matcher wrongly dropped to "unknown".
  assert.equal(mapPhaseToRunStatus('assigned'), 'running');
  assert.equal(mapPhaseToRunStatus('assigned_parallel'), 'running');
  assert.equal(mapPhaseToRunStatus('debugging'), 'running');
  assert.equal(mapPhaseToRunStatus('devops_needed'), 'running');
  assert.equal(mapPhaseToRunStatus('escalated'), 'blocked');
  assert.equal(mapPhaseToRunStatus('aborted'), 'cancelled');
  // Already-correct mappings still hold.
  assert.equal(mapPhaseToRunStatus('in_review'), 'waiting_review');
  assert.equal(mapPhaseToRunStatus('validation_failed'), 'failed');
  assert.equal(mapPhaseToRunStatus('done'), 'completed');
  assert.equal(mapPhaseToRunStatus('pending'), 'queued');
  // Off-contract / empty -> unknown, never guessed.
  assert.equal(mapPhaseToRunStatus('in-review'), 'unknown'); // wrong separator
  assert.equal(mapPhaseToRunStatus('RUNNING'), 'unknown');   // not an enum value
  assert.equal(mapPhaseToRunStatus(undefined), 'unknown');
  assert.equal(mapPhaseToRunStatus(''), 'unknown');
});

test('buildNextActionPreview prefers a complete status.yaml next_action', () => {
  assert.deepEqual(buildNextActionPreview({
    phase: 'assigned', current_agent: 'dev',
    next_action: { agent: 'reviewer', description: 'Implementation is ready for review.' },
  }), {
    previewOnly: true,
    source: 'status-next-action',
    targetRole: 'reviewer',
    reason: 'Implementation is ready for review.',
  });
});

test('buildNextActionPreview maps exact workflow phases without guessing unknown values', () => {
  assert.equal(buildNextActionPreview({ phase: 'review' }).targetRole, 'reviewer');
  assert.equal(buildNextActionPreview({ phase: 'escalated' }).targetRole, 'free-roam');
  assert.equal(buildNextActionPreview({ phase: 'assigned', current_agent: 'dev-2' }).targetRole, 'dev-2');
  assert.equal(buildNextActionPreview({ phase: 'validation_failed' }).source, 'unavailable');
  assert.equal(buildNextActionPreview({ phase: 'in-review', current_agent: 'dev' }).source, 'unavailable');
  assert.equal(buildNextActionPreview({}).source, 'unavailable');
});

test('asObject passes through a real object', () => {
  assert.deepEqual(asObject({ state: 'running', history: [] }), { state: 'running', history: [] });
});

test('asObject coerces half-written YAML (scalar/array/null) to an empty object', () => {
  // A status.yaml caught mid-write can parse to any of these.
  assert.deepEqual(asObject(yaml.load('running')), {});        // bare scalar
  assert.deepEqual(asObject(yaml.load('- a\n- b')), {});         // array
  assert.deepEqual(asObject(yaml.load('')), {});                // empty -> undefined
  assert.deepEqual(asObject(null), {});
  assert.deepEqual(asObject(undefined), {});
  // The key safety property: property access never throws afterwards.
  assert.equal(asObject(yaml.load('running')).history, undefined);
});

test('invalidate() clears the cache so the next listRuns re-scans', async () => {
  const scanner = new RunScanner();
  // Populate the cache from the real runs dir (returns an array regardless of contents).
  const first = await scanner.listRuns();
  assert.ok(Array.isArray(first));
  // Should not throw and should still return an array after invalidation.
  scanner.invalidate();
  const second = await scanner.listRuns();
  assert.ok(Array.isArray(second));
});

test('listRuns exposes task workstream from pm-output metadata', async () => {
  const taskId = `TASK-${Date.now()}-WORKSTREAM`;
  const runDir = path.resolve(__dirname, '../../../..', 'runs', taskId);

  try {
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'status.yaml'), yaml.dump({
      task_id: taskId,
      phase: 'assigned',
      state: 'assigned',
      iteration: 1,
      current_agent: 'dev',
      task_label: 'Workstream test task',
      updated_at: '2026-06-10',
    }));
    await fs.writeFile(path.join(runDir, 'pm-output.yaml'), yaml.dump({
      task: {
        id: taskId,
        title: 'Workstream test task',
        short_name: 'workstream-test',
        type: 'feature',
        workstream: 'frontend',
        priority: 'medium',
        created_at: '2026-06-10',
      },
    }));

    const scanner = new RunScanner();
    const runs = await scanner.listRuns(true);
    const run = runs.find((candidate) => candidate.id === taskId);

    assert.equal(run?.workstream, 'frontend');
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

// Operator model (ADR-0003): history[].agent may be a role, an operator
// (conductor/subagent), or an actor — classifyActor must not collapse the
// operator/actor cases to 'unknown'.

test('classifyActor: workflow roles are kind=role', () => {
  for (const r of ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam']) {
    assert.deepEqual(classifyActor(r), { name: r, kind: 'role' }, r);
  }
});

test('classifyActor: done/orchestrator/user are kind=actor', () => {
  for (const a of ['done', 'orchestrator', 'user']) {
    assert.deepEqual(classifyActor(a), { name: a, kind: 'actor' }, a);
  }
});

test('classifyActor: claude/codex/cursor/gemini are kind=operator', () => {
  for (const o of ['claude', 'codex', 'cursor', 'gemini']) {
    assert.deepEqual(classifyActor(o), { name: o, kind: 'operator' }, o);
  }
});

test('classifyActor: case-insensitive', () => {
  assert.deepEqual(classifyActor('Codex'), { name: 'codex', kind: 'operator' });
  assert.deepEqual(classifyActor('REVIEWER'), { name: 'reviewer', kind: 'role' });
});

test('classifyActor: empty/undefined/unrecognized are kind=unknown', () => {
  for (const x of ['', undefined, 'mystery', 'gpt']) {
    assert.deepEqual(classifyActor(x as string | undefined), { name: 'unknown', kind: 'unknown' }, String(x));
  }
});

// latestConductor: who is conducting = the operator of the most recent history
// transition. Derived only; undefined when no operator was ever logged.

test('latestConductor: picks the most recent operator', () => {
  const history = [
    { agent: 'codex', phase: 'pending -> assigned' },
    { agent: 'reviewer', phase: 'assigned -> in_review' },
    { agent: 'gemini', phase: 'in_review -> blocked' },
    { agent: 'user', phase: 'blocked -> pending' },
  ];
  assert.equal(latestConductor(history), 'gemini');
});

test('latestConductor: role/actor-only history has no conductor', () => {
  const history = [
    { agent: 'pm', phase: 'pending -> assigned' },
    { agent: 'dev-2', phase: 'assigned -> in_review' },
    { agent: 'user', phase: 'in_review -> blocked' },
  ];
  assert.equal(latestConductor(history), undefined);
});

test('latestConductor: empty/missing/non-array is undefined', () => {
  assert.equal(latestConductor([]), undefined);
  assert.equal(latestConductor(undefined), undefined);
  assert.equal(latestConductor('nope'), undefined);
  assert.equal(latestConductor([{ phase: 'x -> y' }]), undefined); // entry without agent
});

test('latestConductor: case-insensitive operator match', () => {
  assert.equal(latestConductor([{ agent: 'Codex' }]), 'codex');
});
