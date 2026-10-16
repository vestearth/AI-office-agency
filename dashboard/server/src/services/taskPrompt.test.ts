import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedNextAction, taskPrompt } from './taskPrompt';

// Slice 3 (spec D6) changed this test on purpose: the dashboard is now the runtime
// adapter and runs validate -> enforce -> sync itself after the step, so the prompt no
// longer tells the agent to run the office scripts or record-evidence.sh (under codex,
// /bin/bash 3.2 here-documents in those scripts failed from the non-writable office
// root, 2026-10-17). The agent writes only its output YAML; the prompt still names the
// three scripts, in order, as what happens after it stops.
test('step prompt points at the task files, has the agent write only its output, and leaves the office scripts to the dashboard', () => {
  const prompt = taskPrompt({ taskId: 'TASK-VS-029', title: 'Stop logging slip data', role: 'dev', workspaceRoot: '/ws',
    nextAction: { agent: 'dev', reason: 'Implement the allowlist' }, note: '  start with audit.go  ' });
  assert.match(prompt, /`dev` lane of AI Dev Office task TASK-VS-029: Stop logging slip data/);
  assert.match(prompt, /Recorded next action \(dev\): Implement the allowlist/);
  assert.match(prompt, /\/ws\/AGENTS\.md/);
  assert.match(prompt, /\/ws\/ai-dev-office\/agents\/dev\.md/);
  assert.match(prompt, /schemas\/dev-output\.schema\.yaml/);
  assert.match(prompt, /Write \/ws\/ai-dev-office\/runs\/TASK-VS-029\/dev-output\.yaml, the only file you write in the task artifacts/);
  assert.match(prompt, /claims/, 'the checks the agent ran go in the output, as claims');
  assert.match(prompt, /Do not run the office scripts \(record-evidence\.sh, validate-yaml\.rb, enforce-output-contract\.rb, sync-status-from-output\.rb\)/);
  assert.doesNotMatch(prompt, /^\s*ruby validate-yaml\.rb/m, 'no script for the agent to run');
  assert.doesNotMatch(prompt, /record-evidence\.sh TASK-VS-029 --type/);
  const validate = prompt.indexOf('ruby validate-yaml.rb TASK-VS-029');
  const enforce = prompt.indexOf('ruby scripts/enforce-output-contract.rb TASK-VS-029 dev');
  const sync = prompt.indexOf('ruby scripts/sync-status-from-output.rb TASK-VS-029 dev');
  assert.ok(validate > 0 && enforce > validate && sync > enforce, 'the dashboard runs validate, then enforce, then sync');
  assert.match(prompt, /The dashboard verifies/);
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

test('a Run in worktrees names the primary worktree, the others, the absolute runs dir, and forbids commit, push, merge and deploy', () => {
  const prompt = taskPrompt({
    taskId: 'TASK-VS-041', title: 't', role: 'dev', workspaceRoot: '/ws', officeRoot: '/ws/ai-dev-office',
    worktrees: [
      { repo: 'slip-api', path: '/ws/.worktrees/slip-api-TASK-VS-041', branch: 'task/TASK-VS-041' },
      { repo: 'slip-contracts', path: '/ws/.worktrees/slip-contracts-TASK-VS-041', branch: 'task/TASK-VS-041-proto' },
    ],
    referenceOnly: ['Games-Lab-Android'],
  });
  assert.match(prompt, /working directory is the task worktree of slip-api, the primary repository: \/ws\/\.worktrees\/slip-api-TASK-VS-041 \(branch task\/TASK-VS-041\)/);
  assert.match(prompt, /slip-contracts: \/ws\/\.worktrees\/slip-contracts-TASK-VS-041 \(branch task\/TASK-VS-041-proto\)/);
  assert.match(prompt, /Task artifacts: \/ws\/ai-dev-office\/runs\/TASK-VS-041\//);
  assert.match(prompt, /Write \/ws\/ai-dev-office\/runs\/TASK-VS-041\/dev-output\.yaml/);
  assert.match(prompt, /write it with your shell/, 'cursor-agent\'s edit tool cannot write outside its workspace; its shell can');
  // Slice 3 (D6): checks run from the worktree they check and go in the output's claims;
  // record-evidence.sh is the dashboard's (it records the dashboard's commit), not the agent's.
  assert.match(prompt, /from the worktree they check/);
  assert.match(prompt, /Never commit, push, merge or deploy/);
  assert.match(prompt, /a commit of yours fails the step/);
  assert.match(prompt, /the dashboard commits each worktree's diff on its task branch/);
  assert.match(prompt, /Games-Lab-Android is reference only/);
  assert.doesNotMatch(prompt, /Find the target repository from task\.md/);
});

test('the runs dir comes from the office root the dashboard runs in, not a guess under the workspace root', () => {
  const prompt = taskPrompt({ taskId: 'TASK-1', title: 't', role: 'pm', workspaceRoot: '/ws', officeRoot: '/elsewhere/office' });
  assert.match(prompt, /\/elsewhere\/office\/runs\/TASK-1\//);
  assert.match(prompt, /\/elsewhere\/office\/agents\/pm\.md/);
});

test('an Open prompt (D15) is the Run prompt with the hand-off lines changed: the session validates, the dashboard neither verifies nor commits', () => {
  const input = { taskId: 'TASK-EAR-9', title: 't', role: 'dev', workspaceRoot: '/ws', worktrees: [{ repo: 'api-gateway', path: '/ws/.worktrees/api-gateway-TASK-EAR-9', branch: 'task/TASK-EAR-9' }] };
  const run = taskPrompt(input);
  const open = taskPrompt({ ...input, mode: 'open' });
  assert.match(open, /opened this step from the dashboard in a session they drive/);
  assert.match(open, /4\. Then run ruby validate-yaml\.rb TASK-EAR-9 from \/ws\/ai-dev-office/);
  assert.match(open, /does not verify or commit a session it opened/);
  assert.match(open, /unless the operator asks you to in this session/);
  assert.doesNotMatch(open, /The dashboard verifies your output|a commit of yours fails the step|Do not run the office scripts/);
  const runLines = run.split('\n');
  assert.equal(open.split('\n').filter((line) => !runLines.includes(line)).length, 4, 'only the first line, the status.yaml line, steps 4 and 5 differ');
  assert.ok(open.includes('Your working directory is the task worktree of api-gateway'));
  assert.ok(open.includes('Write /ws/ai-dev-office/runs/TASK-EAR-9/dev-output.yaml, the only file you write in the task artifacts'));
});
