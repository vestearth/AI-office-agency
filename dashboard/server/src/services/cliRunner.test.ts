import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { CliRunner, codexArgs, findCodex } from './cliRunner';

async function finished(runner: CliRunner, task: string) {
  for (let i = 0; i < 100; i++) {
    const run = runner.latest(task)!;
    if (!['running', 'stopping'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Child did not terminate');
}

test('passes prompt literally through stdin, sets cwd without shell, prevents duplicate active task', async () => {
  const prompt = 'Review & echo "quotes"; $(not-a-command) ภาษาไทย';
  const fakeSpawn: typeof spawn = ((command: string, args: string[], options: any) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, codexArgs('read-only'));
    assert.equal(options.shell, false);
    assert.equal(options.cwd, process.cwd());
    return spawn(process.execPath, ['-e', 'process.stdin.setEncoding("utf8"); let text=""; process.stdin.on("data", c=>text+=c); process.stdin.on("end", ()=>{console.log(text); console.error("fixture stderr");});'], options);
  }) as typeof spawn;
  const runner = new CliRunner({ command: process.execPath, prefix: [] }, fakeSpawn);
  try {
    runner.start('fixture', process.cwd(), 'read-only', prompt);
    assert.throws(() => runner.start('fixture', process.cwd(), 'read-only', prompt), /already/);
    const view = await finished(runner, 'fixture');
    assert.equal(view.status, 'succeeded');
    assert.ok(view.output.includes(prompt));
    assert.ok(view.output.includes('fixture stderr'));
    assert.equal(view.exitCode, 0);
    assert.throws(() => runner.stop('fixture', 'old-id'), /no longer matches/);
  } finally { runner.shutdown(); }
});

test('bounds logs and reports failed exit', async () => {
  const fakeSpawn = ((_command: string, _args: string[], options: any) => spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(220000), ()=>process.exit(7));'], options)) as typeof spawn;
  const runner = new CliRunner({ command: process.execPath, prefix: [] }, fakeSpawn);
  try {
    runner.start('large', process.cwd(), 'workspace-write', 'fixture');
    const view = await finished(runner, 'large');
    assert.equal(view.status, 'failed'); assert.equal(view.exitCode, 7);
    assert.equal(view.output.length, 200000); assert.equal(view.truncated, true);
  } finally { runner.shutdown(); }
});

test('Stop terminates a real process tree and preserves stopped state', async () => {
  const fakeSpawn = ((_command: string, _args: string[], options: any) => spawn(process.execPath, ['-e', 'const child=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(child.pid); setInterval(()=>{},1000);'], options)) as typeof spawn;
  const runner = new CliRunner({ command: process.execPath, prefix: [] }, fakeSpawn);
  try {
    const view = runner.start('stop', process.cwd(), 'read-only', 'fixture');
    for (let i = 0; i < 50 && !view.output.trim(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const descendantPid = Number(view.output.trim());
    assert.ok(descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    runner.stop('stop', view.id);
    assert.equal((await finished(runner, 'stop')).status, 'stopped');
    assert.throws(() => process.kill(descendantPid, 0));
  } finally { runner.shutdown(); }
});

test('missing executable is visible as a failed run', async () => {
  const runner = new CliRunner({ command: 'missing-dashboard-cli-fixture-123', prefix: [] });
  runner.start('missing', process.cwd(), 'read-only', 'fixture');
  const view = await finished(runner, 'missing');
  assert.equal(view.status, 'failed'); assert.match(view.output, /Launch failed/);
});

test('installed Codex accepts generated arguments in help mode, without executing a task', { skip: !findCodex() }, async () => {
  const helpSpawn = ((command: string, args: string[], options: any) => spawn(command, [...args, '--help'], options)) as typeof spawn;
  const runner = new CliRunner(findCodex(), helpSpawn);
  try {
    runner.start('codex-help-smoke', process.cwd(), 'read-only', 'Do not execute: help mode fixture.');
    const view = await finished(runner, 'codex-help-smoke');
    assert.equal(view.status, 'succeeded');
    assert.match(view.output, /Run Codex non-interactively/);
  } finally { runner.shutdown(); }
});
