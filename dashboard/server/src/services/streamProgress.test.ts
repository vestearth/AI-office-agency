import test from 'node:test';
import assert from 'node:assert/strict';
import { clip, PROGRESS_LINES, StreamProgress } from './streamProgress';
import type { TaskCli } from './officeLauncher';

// Fixtures are events the installed CLIs printed on 2026-10-17 (ids and long
// fields trimmed), from a throwaway repo under $HOME.

const parse = (cli: TaskCli, events: unknown[], { split = false } = {}) => {
  const p = new StreamProgress(cli);
  const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
  if (split) for (const ch of Buffer.from(text)) p.push(Buffer.from([ch]));
  else p.push(text);
  p.end();
  return p.summary();
};

test('claude stream-json: init, text, tool calls, a failed tool, the result', () => {
  const s = parse('claude', [
    { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
    { type: 'system', subtype: 'init', cwd: '/r', model: 'claude-haiku-5', tools: ['Bash'] },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -a .', description: 'List all files' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '.\n..\nREADME.md', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/runs/TASK-X/a.txt', content: 'hello' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'operation not\npermitted' }], is_error: true }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 3 },
  ]);
  assert.deepEqual(s.progress, [
    'Session started · model claude-haiku-5', '→ Bash: ls -a .', '→ Write: /runs/TASK-X/a.txt', '✗ operation not permitted', 'DONE', 'Result: DONE',
  ]);
  assert.equal(s.failure, undefined);
  assert.equal(s.finished, true);
});

test('claude: a result with is_error or an error subtype is a protocol failure', () => {
  // Observed for an unknown model: subtype "success", is_error true, exit 1.
  const model = parse('claude', [{ type: 'result', subtype: 'success', is_error: true, result: "There's an issue with the selected model (no-such-model-xyz)." }]);
  assert.equal(model.failure, "There's an issue with the selected model (no-such-model-xyz).");
  assert.equal(model.finished, true);
  const turns = parse('claude', [{ type: 'result', subtype: 'error_max_turns', is_error: false }]);
  assert.equal(turns.failure, 'error_max_turns');
  const listed = parse('claude', [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom', 'bang'] }]);
  assert.equal(listed.failure, 'boom; bang');
});

test('codex JSONL: messages, commands, file changes; a failing command is shown, not fatal', () => {
  const s = parse('codex', [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run the listing.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -a .'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'ls -a .'", aggregated_output: '.\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/runs/TASK-X/b.txt', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'go test ./...', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'DONE' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
  ]);
  assert.deepEqual(s.progress, [
    'Session started', 'I’ll run the listing.', "→ $ /bin/zsh -lc 'ls -a .'", '→ add /runs/TASK-X/b.txt', '✗ exit 1: go test ./...', 'DONE', 'Turn completed.',
  ]);
  assert.equal(s.failure, undefined);
  assert.equal(s.finished, true);
});

test('codex: error and turn.failed are a protocol failure, shown once; an error item is only a warning', () => {
  // Observed with a model the ChatGPT account rejects (exit 1).
  const body = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } });
  const s = parse('codex', [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata.' } },
    { type: 'turn.started' },
    { type: 'error', message: body },
    { type: 'turn.failed', error: { message: body } },
  ]);
  const reason = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  assert.equal(s.failure, reason);
  assert.deepEqual(s.progress, ['Session started', 'warning: Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata.', `✗ ${reason}`]);
  assert.equal(s.finished, true);
  const warningOnly = parse('codex', [{ type: 'item.completed', item: { type: 'error', message: 'just a notice' } }, { type: 'turn.completed' }]);
  assert.equal(warningOnly.failure, undefined);
});

test('cursor-agent stream-json: init, text, tool calls by kind, a failed shell command, the result', () => {
  const shell = (subtype: string, result?: unknown) => ({
    type: 'tool_call', subtype, call_id: 'c1',
    tool_call: { shellToolCall: { args: { command: 'ls -a .', workingDirectory: '', timeout: 30000 }, ...(result ? { result } : {}) }, toolCallId: 'c1' },
  });
  const s = parse('cursor-agent', [
    { type: 'system', subtype: 'init', apiKeySource: 'login', cwd: '/r', model: 'Auto', permissionMode: 'default' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } },
    { type: 'thinking', subtype: 'delta', text: 'Running ls first.' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll list the directory." }] } },
    shell('started'),
    shell('completed', { success: { command: 'ls -a .', exitCode: 0, stdout: '.\n' }, isBackground: false }),
    { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: '/runs/TASK-X/c.txt' } } } },
    { type: 'tool_call', subtype: 'completed', tool_call: { readToolCall: { args: { path: '/runs/TASK-X/c.txt' }, result: { success: { content: 'hello' } } } } },
    shell('completed', { success: { command: 'go test', exitCode: 2 } }),
    { type: 'tool_call', subtype: 'completed', tool_call: { editToolCall: { args: { path: '/x' }, result: { error: { message: 'Operation not permitted' } } } } },
    { type: 'tool_call', subtype: 'completed', tool_call: { editToolCall: { args: { path: '/runs/x' }, result: { rejected: { path: '/runs/x', reason: '' } } } } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } },
    { type: 'result', subtype: 'success', duration_ms: 12028, is_error: false, result: 'DONE', session_id: 's' },
  ]);
  assert.deepEqual(s.progress, [
    'Session started · model Auto', "I'll list the directory.", '→ shell: ls -a .', '→ read: /runs/TASK-X/c.txt', '✗ shell exit 2',
    '✗ edit error: Operation not permitted', '✗ edit rejected', 'DONE', 'Result: DONE',
  ]);
  assert.equal(s.failure, undefined);
  assert.equal(s.finished, true);
  assert.equal(parse('cursor-agent', [{ type: 'result', subtype: 'error', is_error: true, result: 'rate limited' }]).failure, 'rate limited');
});

test('non-JSON lines (stderr, the wrapper) are kept; nothing finished means no terminal event yet', () => {
  const s = parse('cursor-agent', ['', '⚠ Workspace Trust Required', '  Pass --trust if you trust this directory', '[1, 2]']);
  assert.deepEqual(s.progress, ['⚠ Workspace Trust Required', 'Pass --trust if you trust this directory', '[1, 2]']);
  assert.equal(s.finished, false);
  assert.equal(s.failure, undefined);
});

test('events split across chunks, even inside a multi-byte character, parse the same', () => {
  const events = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'ภาษาไทย ok' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'เสร็จ' }];
  assert.deepEqual(parse('claude', events, { split: true }), parse('claude', events));
  assert.deepEqual(parse('claude', events).progress, ['ภาษาไทย ok', 'Result: เสร็จ']);
});

test('a line without its newline is parsed at end(), progress keeps the newest lines and long text is clipped', () => {
  const p = new StreamProgress('codex');
  p.push('{"type":"turn.completed"}');
  assert.equal(p.summary().finished, false);
  p.end();
  assert.equal(p.summary().finished, true);
  const many = parse('codex', Array.from({ length: PROGRESS_LINES + 5 }, (_, i) => ({ type: 'item.completed', item: { type: 'agent_message', text: `m${i}` } })));
  assert.equal(many.progress.length, PROGRESS_LINES);
  assert.equal(many.progress[0], 'm5');
  assert.equal(clip('a\n  b\tc'), 'a b c');
  assert.equal(clip('x'.repeat(500)).length, 400);
  assert.ok(clip('x'.repeat(500)).endsWith('…'));
});
