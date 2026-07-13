import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelRoutingPreview } from './modelRouting';

test('routes clear documentation work to Luna low', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-001',
    pmOutput: {
      task: { id: 'TASK-EAR-001', workstream: 'docs', priority: 'low' },
      scope: { target_services: [{ service: 'ai-dev-office' }] },
      plan: { estimated_complexity: 'low' },
      assignment: { primary: 'dev', parallel: false },
    },
  });

  assert.equal(preview.tier, 'mechanical');
  assert.equal(preview.model, 'gpt-5.6-luna');
  assert.equal(preview.reasoningEffort, 'low');
  assert.equal(preview.source, 'validated-task');
});

test('routes scoped everyday work to Terra medium', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-002',
    pmOutput: {
      task: { id: 'TASK-EAR-002', workstream: 'backend', priority: 'medium' },
      scope: { target_services: [{ service: 'Games-Labs-Game' }] },
      plan: { estimated_complexity: 'medium' },
      assignment: { primary: 'dev', parallel: false },
    },
  });

  assert.equal(preview.tier, 'standard');
  assert.equal(preview.model, 'gpt-5.6-terra');
  assert.equal(preview.reasoningEffort, 'medium');
  assert.ok(preview.reasons.some((reason) => reason.code === 'standard_default'));
});

test('routes high-complexity dev-2 work to Terra high', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-003',
    pmOutput: {
      task: { id: 'TASK-EAR-003', workstream: 'backend', priority: 'high' },
      scope: { target_services: [{ service: 'Games-Labs-Game' }] },
      plan: { estimated_complexity: 'high' },
      assignment: { primary: 'dev-2', parallel: false },
    },
  });

  assert.equal(preview.tier, 'complex');
  assert.equal(preview.model, 'gpt-5.6-terra');
  assert.equal(preview.reasoningEffort, 'high');
  assert.equal(preview.role, 'dev-2');
});

test('routes multi-service contract work to Sol high', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-004',
    pmOutput: {
      task: { id: 'TASK-EAR-004', workstream: 'backend', priority: 'high' },
      scope: {
        target_services: [{ service: 'shared-lib' }, { service: 'Games-Labs-Order' }],
        affected_files: [{ path: 'shared-lib/proto/order.proto', description: 'Add an API contract field' }],
      },
      plan: { estimated_complexity: 'high' },
      assignment: { primary: 'dev-2', parallel: false },
    },
  });

  assert.equal(preview.tier, 'critical');
  assert.equal(preview.model, 'gpt-5.6-sol');
  assert.equal(preview.reasoningEffort, 'high');
  assert.ok(preview.reasons.some((reason) => reason.code === 'multi_service'));
  assert.ok(preview.reasons.some((reason) => reason.code === 'contract_change'));
});

test('uses xhigh for a critical debugger invocation', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-005',
    currentAgent: 'debugger',
    taskMarkdown: 'Investigate a production wallet idempotency failure.',
  });

  assert.equal(preview.tier, 'critical');
  assert.equal(preview.model, 'gpt-5.6-sol');
  assert.equal(preview.reasoningEffort, 'xhigh');
  assert.equal(preview.source, 'run-metadata');
  assert.equal(preview.previewOnly, true);
});

test('ignores PM evidence when its task id belongs to another run', () => {
  const preview = buildModelRoutingPreview({
    taskId: 'TASK-EAR-006',
    pmOutput: {
      task: { id: 'TASK-EAR-999', priority: 'critical' },
      scope: { target_services: [{ service: 'one' }, { service: 'two' }] },
    },
    taskMarkdown: 'Update a scoped implementation note.',
  });

  assert.equal(preview.tier, 'standard');
  assert.equal(preview.source, 'run-metadata');
  assert.ok(preview.reasons.some((reason) => reason.code === 'standard_default'));
});
