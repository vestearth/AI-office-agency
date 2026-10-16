import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findOnPath, knowledgeLaunchArgs, OfficeLauncher, taskCliArgs } from './officeLauncher';
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

const start = (launcher: OfficeLauncher, key: string, argv: string[]) =>
  launcher.start({ kind: 'task', key, label: key, argv, display: argv.join(' '), cwd: process.cwd() });

test('runs argv verbatim, captures stdout+stderr and the exit code, refuses a second start while running', async () => {
  const dir = tmp();
  const launcher = new OfficeLauncher(dir);
  const literal = 'a & b; $(not-run) "quoted" ภาษาไทย';
  start(launcher, 'TASK-1', node(`console.log(process.argv[1]); console.error('to stderr'); setTimeout(() => {}, 300);`).concat(literal));
  assert.throws(() => start(launcher, 'TASK-1', node('')), /already running/);
  const done = await settled(launcher, 'TASK-1');
  assert.equal(done.status, 'succeeded');
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
  assert.equal((await settled(launcher, 'TASK-4')).status, 'stopped');
});

test('a launch whose process is gone without an exit file is lost, not running', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ id: 'x', kind: 'task', key: 'TASK-5', label: 'TASK-5', display: '', cwd: '/', pid: 2 ** 22 + 12345, startedAt: '2026-10-16T00:00:00.000Z' }));
  assert.equal(new OfficeLauncher(dir).latest('TASK-5')!.status, 'lost');
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

test('task CLIs get the prompt as one argument and keep their unattended guards', () => {
  const exe = (command: string) => ({ command, prefix: [] });
  const claude = taskCliArgs('claude', exe('/bin/claude'), 'P');
  assert.deepEqual(claude.slice(0, 3), ['/bin/claude', '-p', 'P']);
  const denied = claude[claude.indexOf('--disallowedTools') + 1];
  for (const guard of ['gh pr merge', 'git push --force', 'aws ecs update-service', 'aws rds start-db-instance']) assert.ok(denied.includes(guard), guard);
  const codex = taskCliArgs('codex', exe('/bin/codex'), 'P');
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(codex.at(-1), 'P');
  assert.deepEqual(taskCliArgs('cursor-agent', exe('/bin/cursor-agent'), 'P'), ['/bin/cursor-agent', '-p', '--trust', 'P']);
  assert.deepEqual(taskCliArgs('claude', { command: 'node.exe', prefix: ['C:/npm/cli.js'] }, 'P').slice(0, 4), ['node.exe', 'C:/npm/cli.js', '-p', 'P']);
  assert.throws(() => taskCliArgs('cursor', exe('/bin/cursor'), 'P'), /CLI must be/);
});

test('the knowledge run never commits or pushes and pins the weekly model', () => {
  const argv = knowledgeLaunchArgs({ command: '/bin/claude', prefix: [] }, 'PROMPT');
  assert.deepEqual(argv.slice(0, 3), ['/bin/claude', '-p', 'PROMPT']);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
  const denied = argv[argv.indexOf('--disallowedTools') + 1];
  assert.match(denied, /git commit/);
  assert.match(denied, /git push/);
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
  remainingNotes: 0, limits: { maxNotes: 5, maxFindings: 15 }, humanDecisionsExcluded: 0, answers: [], ...over,
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
