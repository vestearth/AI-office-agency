import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stepArgv } from './cliAdapter';
import { claudeTaskModel, findOnPath, KNOWLEDGE_MODEL, OfficeLauncher, stepTimeLimitMinutes, type LaunchInput } from './officeLauncher';
import { knowledgeRecheckPrompt } from './knowledgeRecheckPrompt';
import type { KnowledgeRecheckBrief, OfficeLaunch } from '../../../shared/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-launch-'));
const node = (code: string) => [process.execPath, '-e', code];

async function settled(launcher: OfficeLauncher, key: string): Promise<OfficeLaunch> {
  for (let i = 0; i < 200; i++) {
    const launch = launcher.latest(key)!;
    if (!['running', 'stopping'].includes(launch.status)) return launch;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('launch did not finish');
}

const start = (launcher: OfficeLauncher, key: string, argv: string[], more: Partial<LaunchInput> = {}) =>
  launcher.start({ kind: 'task', key, label: key, argv, display: argv.join(' '), cwd: process.cwd(), ...more });

test('runs argv verbatim, captures stdout+stderr and the exit code, refuses a second start while running', async () => {
  const dir = tmp();
  const launcher = new OfficeLauncher(dir);
  const literal = 'a & b; $(not-run) "quoted" ภาษาไทย';
  start(launcher, 'TASK-1', node(`console.log(process.argv[1]); console.error('to stderr'); setTimeout(() => {}, 300);`).concat(literal));
  assert.throws(() => start(launcher, 'TASK-1', node('')), /already running/);
  const done = await settled(launcher, 'TASK-1');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.termination, 'completed');
  assert.equal(done.exitCode, 0);
  assert.ok(done.log.includes(literal));
  assert.ok(done.log.includes('to stderr'));
  assert.ok(done.finishedAt);
});

test('a failing command is failed with its exit code', async () => {
  const launcher = new OfficeLauncher(tmp());
  start(launcher, 'TASK-2', node('process.exit(9)'));
  const done = await settled(launcher, 'TASK-2');
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 9);
});

test('survives a dashboard restart: a new launcher on the same dir sees the running launch, then its result', async () => {
  const dir = tmp();
  start(new OfficeLauncher(dir), 'TASK-3', node('setTimeout(() => process.exit(3), 300)'));
  const restarted = new OfficeLauncher(dir);
  assert.equal(restarted.latest('TASK-3')!.status, 'running');
  assert.throws(() => start(restarted, 'TASK-3', node('')), /already running/);
  assert.equal((await settled(restarted, 'TASK-3')).exitCode, 3);
});

test('Stop sends SIGTERM to the process group and reports stopped', async () => {
  const launcher = new OfficeLauncher(tmp());
  const launch = start(launcher, 'TASK-4', node('setInterval(() => {}, 1000)'));
  start(launcher, 'TASK-4b', node('process.exit(0)'));
  await settled(launcher, 'TASK-4b');
  assert.deepEqual(launcher.active().map((l) => l.key), ['TASK-4'], 'only what still runs');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(launcher.stop(launch.id).status, 'stopping');
  const stopped = await settled(launcher, 'TASK-4');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.termination, 'operator_stop');
});

test('a launch whose process is gone without an exit file is lost, not running', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ id: 'x', kind: 'task', key: 'TASK-5', label: 'TASK-5', display: '', cwd: '/', pid: 2 ** 22 + 12345, startedAt: '2026-10-16T00:00:00.000Z' }));
  assert.equal(new OfficeLauncher(dir).latest('TASK-5')!.status, 'lost');
  assert.equal(new OfficeLauncher(dir).latest('TASK-5')!.termination, 'unknown');
});

test('keeps the newest launches per key and returns the newest', async () => {
  let t = Date.parse('2026-10-16T00:00:00Z');
  const dir = tmp();
  const launcher = new OfficeLauncher(dir, () => new Date(t += 1000));
  for (let i = 0; i < 12; i++) {
    start(launcher, 'TASK-6', node(`console.log(${i})`));
    await settled(launcher, 'TASK-6');
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 10);
  assert.ok(launcher.latest('TASK-6')!.log.includes('11'));
});

// Rewritten on purpose for docs/start-task-redesign-spec.md (D5/D10): the old argv put
// the prompt in argv and guarded Claude with Bash prefix denies (gh pr merge, git push
// --force, aws …), which the decision drops; the sandbox envelope (network off, writes
// only in the working dir and runs/<TASK>) replaces them, and the prompt goes on stdin.
// cliAdapter.test.ts covers the per-CLI argv; these keep the old guarantees in the new shape.
test('task CLIs never get the prompt in argv, and keep their unattended guards in the envelope', () => {
  const exe = (command: string) => ({ command, prefix: [] });
  const envelope = { cwd: '/ws', writableDirs: ['/ws/ai-dev-office/runs/TASK-1'] };
  for (const cli of ['claude', 'codex', 'cursor-agent'] as const) assert.ok(!stepArgv(cli, exe(`/bin/${cli}`), envelope).includes('P'));
  const claude = stepArgv('claude', exe('/bin/claude'), envelope);
  const settings = JSON.parse(claude[claude.indexOf('--settings') + 1]);
  assert.ok(settings.permissions.deny.includes('Bash(git push *)'));
  assert.equal(settings.sandbox.network.allowedDomains.length, 0);
  const codex = stepArgv('codex', exe('/bin/codex'), envelope);
  assert.equal(codex[codex.indexOf('-s') + 1], 'workspace-write');
  // The account rejected the config's model (gpt-6.1-sol, 2026-10-16): the step pins one.
  assert.equal(codex[codex.indexOf('-m') + 1], 'gpt-5.6-sol');
  const custom = stepArgv('codex', exe('/bin/codex'), { ...envelope, model: 'gpt-5.5' });
  assert.equal(custom[custom.indexOf('-m') + 1], 'gpt-5.5');
  assert.equal(codex.at(-1), '-');
  assert.deepEqual(stepArgv('claude', { command: 'node.exe', prefix: ['C:/npm/cli.js'] }, envelope).slice(0, 3), ['node.exe', 'C:/npm/cli.js', '-p']);
});

test('the knowledge run never commits or pushes and pins the weekly model', () => {
  // Rewritten with the task argv above (D5/D10): the guards now sit in --settings.
  const argv = stepArgv('claude', { command: '/bin/claude', prefix: [] }, {
    cwd: '/ws', writableDirs: [], model: KNOWLEDGE_MODEL, extraDeny: ['Bash(git commit *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(rm *)'],
  });
  assert.deepEqual(argv.slice(0, 4), ['/bin/claude', '-p', '--model', 'claude-opus-5-5']);
  const denied: string[] = JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions.deny;
  assert.ok(denied.some((d) => /git commit/.test(d)));
  assert.ok(denied.some((d) => /git push/.test(d)));
});

test('the prompt reaches the CLI on stdin from a private file, and the environment is the one given', async () => {
  const launcher = new OfficeLauncher(tmp());
  const prompt = 'line one\nquote " & $(not-run) ภาษาไทย';
  const launch = start(launcher, 'TASK-IN', node(`let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => console.log(JSON.stringify({ s, go: process.env.GOCACHE })));`),
    { stdin: prompt, env: { ...process.env, GOCACHE: '/w/.cache/go-build' } });
  const done = await settled(launcher, 'TASK-IN');
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(JSON.parse(done.log.trim()), { s: prompt, go: '/w/.cache/go-build' });
  assert.ok(!done.command.includes('line one'));
  assert.equal(fs.statSync(path.join(launcher.dir, `${launch.id}.prompt`)).mode & 0o777, 0o600);
});

const emit = (events: unknown[], exit = 0) => node(`for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e)); process.exit(${exit});`);

test('a streamed launch shows readable progress, and an error result fails it even on exit 0', async () => {
  const launcher = new OfficeLauncher(tmp());
  start(launcher, 'TASK-OK', emit([
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -a .' } }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'DONE' },
  ]), { stream: 'claude' });
  const ok = await settled(launcher, 'TASK-OK');
  assert.equal(ok.status, 'succeeded');
  assert.equal(ok.cli, 'claude');
  assert.deepEqual(ok.progress, ['Session started · model claude-opus-5-5', '→ Bash: ls -a .', 'Result: DONE']);
  assert.equal(ok.failureReason, undefined);

  // Observed 2026-10-17: an unknown model gives subtype "success" with is_error true.
  start(launcher, 'TASK-ERR', emit([{ type: 'result', subtype: 'success', is_error: true, result: 'There is an issue with the selected model.' }]), { stream: 'claude' });
  const failed = await settled(launcher, 'TASK-ERR');
  assert.deepEqual([failed.status, failed.exitCode], ['failed', 0]);
  assert.equal(failed.failureReason, 'There is an issue with the selected model.');
  assert.equal(failed.termination, 'runner_failure');
});

test('a streamed launch that exits 0 without its final event is failed; a non-zero exit names the code', async () => {
  const launcher = new OfficeLauncher(tmp());
  start(launcher, 'TASK-CUT', emit([{ type: 'thread.started' }, { type: 'turn.started' }]), { stream: 'codex' });
  const cut = await settled(launcher, 'TASK-CUT');
  assert.equal(cut.status, 'failed');
  assert.match(cut.failureReason ?? '', /without its final result event/);
  start(launcher, 'TASK-EXIT', node('console.error("Workspace Trust Required"); process.exit(1)'), { stream: 'cursor-agent' });
  const exited = await settled(launcher, 'TASK-EXIT');
  assert.equal(exited.failureReason, 'exit code 1');
  assert.equal(exited.termination, 'runner_failure');
  assert.deepEqual(exited.progress, ['Workspace Trust Required']);
});

test('past its time limit a step is stopped with its process group and failed with the reason', { skip: process.platform === 'win32' }, async () => {
  const launcher = new OfficeLauncher(tmp());
  const marker = path.join(tmp(), 'grandchild-alive');
  // The CLI spawns a grandchild that would outlive it unless the whole group is signalled.
  const grandchild = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 100)`;
  const launch = start(launcher, 'TASK-SLOW', node(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`),
    { stream: 'claude', timeLimitMs: 600 });
  const done = await settled(launcher, 'TASK-SLOW');
  assert.equal(done.status, 'failed');
  assert.equal(done.failureReason, 'time limit of 1 s reached: the step was stopped');
  assert.equal(done.termination, 'timeout');
  assert.ok(fs.existsSync(path.join(launcher.dir, `${launch.id}.timeout`)));
  const last = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  assert.ok(last, 'the grandchild ran before the limit');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', last, 'the grandchild was stopped too');
});

test('a launch recorded before the adapter (no stream) has no progress and reads as before', async () => {
  const launcher = new OfficeLauncher(tmp());
  start(launcher, 'TASK-OLD', node('console.log("{}")'));
  const done = await settled(launcher, 'TASK-OLD');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.progress, undefined);
  assert.equal(done.cli, undefined);
});

test('findOnPath finds executables only', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plain'), '');
  assert.deepEqual(findOnPath('tool', dir, 'darwin'), { command: path.join(dir, 'tool'), prefix: [] });
  assert.equal(findOnPath('plain', dir, 'darwin'), null);
});

test('on Windows a .exe runs directly and an npm .cmd shim runs its script under node; a bare .cmd is unavailable', () => {
  // TASK-EAR-404 runs the dashboard on Windows; Node refuses to spawn .cmd without a shell.
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, 'codex.exe'), '');
  fs.mkdirSync(path.join(b, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  fs.writeFileSync(path.join(b, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), '');
  fs.writeFileSync(path.join(b, 'claude.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(b, 'cursor-agent.cmd'), '@powershell -File "%~dp0\\cursor-agent.ps1" %*\r\n');
  const envPath = `${a};${b}`;
  assert.deepEqual(findOnPath('codex', envPath, 'win32'), { command: path.join(a, 'codex.exe'), prefix: [] });
  assert.deepEqual(findOnPath('claude', envPath, 'win32'), { command: process.execPath, prefix: [path.join(b, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')] });
  assert.equal(findOnPath('cursor-agent', envPath, 'win32'), null);
});

test('Stop on Windows ends the tree with taskkill /T /F instead of a process-group signal', async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const fakeSync = ((command: string, args: readonly string[]) => { calls.push({ command, args }); return { status: 0 }; }) as unknown as typeof import('child_process').spawnSync;
  const launcher = new OfficeLauncher(tmp(), () => new Date(), 'win32', fakeSync);
  const launch = start(launcher, 'TASK-W', node('setInterval(() => {}, 1000)'));
  try {
    launcher.stop(launch.id);
    assert.equal(calls.length, 1);
    assert.match(calls[0].command, /taskkill\.exe$/);
    assert.deepEqual(calls[0].args.slice(1), [String((JSON.parse(fs.readFileSync(path.join(launcher.dir, `${launch.id}.json`), 'utf8')) as { pid: number }).pid), '/T', '/F']);
  } finally {
    new OfficeLauncher(launcher.dir).stop(launch.id);
  }
});

test('a command that cannot start is failed with exit 127 and says why', async () => {
  const launcher = new OfficeLauncher(tmp());
  start(launcher, 'TASK-X', ['/no/such/cli', '--flag']);
  const done = await settled(launcher, 'TASK-X');
  assert.deepEqual([done.status, done.exitCode], ['failed', 127]);
  assert.match(done.log, /Launch failed: .*ENOENT/);
});

const brief = (over: Partial<KnowledgeRecheckBrief> = {}): KnowledgeRecheckBrief => ({
  generatedAt: '2026-10-16T09:00:00.000Z', audience: 'task', text: 'BRIEF TEXT', notes: [], considered: 0, totalOpen: 0,
  remainingNotes: 0, limits: { maxNotes: 5, maxFindings: 15 }, humanDecisionsExcluded: 0, recentlyRechecked: 0, answers: [], ...over,
});

test('re-check prompt inlines the brief and keeps the weekly steps; nothing in scope gives no prompt', () => {
  assert.equal(knowledgeRecheckPrompt(brief(), '/ws'), null);
  const prompt = knowledgeRecheckPrompt(brief({ notes: [{ notePath: 'a.md', remaining: 0, findings: [] }] }), '/ws')!;
  assert.ok(prompt.endsWith('BRIEF TEXT'));
  assert.match(prompt, /knowledge-librarian/);
  assert.match(prompt, /approved_scope_auto_write/);
  assert.match(prompt, /\/ws\/ai-dev-office\/knowledge-reviews\/<UTC timestamp like \d+T\d+Z>-weekly-recheck\.yaml/);
  assert.match(prompt, /ruby \/ws\/ai-dev-office\/scripts\/validate-knowledge-librarian\.rb/);
  assert.match(prompt, /never commit or push/);
});

test('the launch is not a descendant of the process that started it, so a tree kill of the dashboard misses it', { skip: process.platform === 'win32' }, async () => {
  // 2026-10-16: nodemon restarted the dashboard and killed every descendant (psTree),
  // which took a running re-check with it (status lost, vault edits with no audit).
  const launcher = new OfficeLauncher(tmp());
  const launch = start(launcher, 'TASK-TREE', node('setInterval(() => {}, 1000)'));
  try {
    const pid = (JSON.parse(fs.readFileSync(path.join(launcher.dir, `${launch.id}.json`), 'utf8')) as { pid: number }).pid;
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    assert.notEqual(ppid, process.pid);
  } finally {
    launcher.stop(launch.id);
  }
});

test('a signal that ends the wrapper still records an exit code (failed 143, not lost)', { skip: process.platform === 'win32' }, async () => {
  const launcher = new OfficeLauncher(tmp());
  const launch = start(launcher, 'TASK-SIG', node('setInterval(() => {}, 1000)'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const pid = (JSON.parse(fs.readFileSync(path.join(launcher.dir, `${launch.id}.json`), 'utf8')) as { pid: number }).pid;
  process.kill(pid, 'SIGTERM');
  const done = await settled(launcher, 'TASK-SIG');
  assert.deepEqual([done.status, done.exitCode], ['failed', 143]);
});

test('a heartbeat command runs on its interval while the CLI is alive and stops with it (the step keeps its task lease)', { skip: process.platform === 'win32' }, async () => {
  const launcher = new OfficeLauncher(tmp());
  const beats = path.join(tmp(), 'beats');
  const heartbeat = { argv: node(`require('fs').appendFileSync(${JSON.stringify(beats)}, 'x')`), intervalMs: 100 };
  start(launcher, 'TASK-HB', node('setTimeout(() => {}, 650)'), { heartbeat });
  await settled(launcher, 'TASK-HB');
  const count = fs.existsSync(beats) ? fs.readFileSync(beats, 'utf8').length : 0;
  assert.ok(count >= 3, `renewed ${count} times while alive`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(fs.readFileSync(beats, 'utf8').length, count, 'no renewal once the CLI is gone');
});

test('a launch can take a preset id (the step record and lease name it before the spawn), and get(id) returns it', async () => {
  const launcher = new OfficeLauncher(tmp());
  const id = launcher.newId();
  const launch = start(launcher, 'TASK-ID', node(''), { id });
  assert.equal(launch.id, id);
  await settled(launcher, 'TASK-ID');
  assert.equal(launcher.get(id)?.status, 'succeeded');
  assert.equal(launcher.get('nope'), null);
});

test('claude task steps default to Opus 5.5; DASHBOARD_CLAUDE_MODEL overrides', () => {
  // Operator decision 2026-10-17: task steps ran on the CLI default (Sonnet 5.5); pin the lanes' model.
  assert.equal(claudeTaskModel({}), 'claude-opus-5-5');
  assert.equal(claudeTaskModel({ DASHBOARD_CLAUDE_MODEL: ' claude-sonnet-5-5 ' }), 'claude-sonnet-5-5');
  assert.equal(claudeTaskModel({ DASHBOARD_CLAUDE_MODEL: '' }), 'claude-opus-5-5');
});

test('a knowledge round has its own time limit (60 min by default); task steps keep theirs', () => {
  // Operator decision 2026-10-17: a large re-check round must not be cut off at the task steps' 30 minutes.
  const cfg = { stepTimeLimitMinutes: 30, knowledgeTimeLimitMinutes: 60 };
  assert.equal(stepTimeLimitMinutes('task', cfg), 30);
  assert.equal(stepTimeLimitMinutes('knowledge', cfg), 60);
});
