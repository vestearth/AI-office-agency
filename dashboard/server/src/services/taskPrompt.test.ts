import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedNextAction, taskPrompt } from './taskPrompt';

test('step prompt points at the task files and ends with the adapter contract in order', () => {
  const prompt = taskPrompt({ taskId: 'TASK-VS-029', title: 'Stop logging slip data', role: 'dev', workspaceRoot: '/ws',
    nextAction: { agent: 'dev', reason: 'Implement the allowlist' }, note: '  start with audit.go  ' });
  assert.match(prompt, /`dev` lane of AI Dev Office task TASK-VS-029: Stop logging slip data/);
  assert.match(prompt, /Recorded next action \(dev\): Implement the allowlist/);
  assert.match(prompt, /\/ws\/AGENTS\.md/);
  assert.match(prompt, /\/ws\/ai-dev-office\/agents\/dev\.md/);
  assert.match(prompt, /record-evidence\.sh TASK-VS-029/);
  assert.match(prompt, /schemas\/dev-output\.schema\.yaml/);
  const validate = prompt.indexOf('ruby validate-yaml.rb TASK-VS-029');
  const enforce = prompt.indexOf('ruby scripts/enforce-output-contract.rb TASK-VS-029 dev');
  const sync = prompt.indexOf('ruby scripts/sync-status-from-output.rb TASK-VS-029 dev runs/TASK-VS-029/status.yaml runs/TASK-VS-029/dev-output.yaml "$(date +%F)" in_review');
  assert.ok(validate > 0 && enforce > validate && sync > enforce, 'validate, then enforce, then sync');
  assert.match(prompt, /Do not commit or push anything under ai-dev-office\/runs\//);
  assert.ok(prompt.endsWith('Operator note: start with audit.go'));
});

test('no recorded next action and no note leave no empty lines behind', () => {
  const prompt = taskPrompt({ taskId: 'TASK-EAR-1', title: 't', role: 'reviewer', workspaceRoot: '/ws' });
  assert.doesNotMatch(prompt, /Recorded next action|Operator note/);
  assert.doesNotMatch(prompt, /\n\n/);
});

test('next_action is read whether a lane recorded it as {agent, reason} or as plain text', () => {
  assert.deepEqual(recordedNextAction({ next_action: { agent: 'reviewer', reason: ' Review PR 71 ' } }), { agent: 'reviewer', reason: 'Review PR 71' });
  assert.deepEqual(recordedNextAction({ next_action: 'Operator checks one duplicate row first.' }), { reason: 'Operator checks one duplicate row first.' });
  assert.equal(recordedNextAction({ next_action: { agent: 'dev' } }), undefined);
  assert.equal(recordedNextAction(null), undefined);
  const prompt = taskPrompt({ taskId: 'T', title: 't', role: 'reviewer', workspaceRoot: '/ws', nextAction: { reason: 'Operator first.' } });
  assert.match(prompt, /\nRecorded next action: Operator first\.\n/);
});
