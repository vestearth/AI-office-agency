import { spawn, ChildProcess, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface CliRun {
  id: string; taskId: string; workspace: string; sandbox: string;
  status: 'running' | 'stopping' | 'stopped' | 'succeeded' | 'failed';
  startedAt: string; finishedAt?: string; exitCode?: number | null;
  output: string; truncated: boolean;
}

export function findCodex(): { command: string; prefix: string[] } | null {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
    if (process.platform !== 'win32') {
      const binary = path.join(dir, 'codex');
      try { fs.accessSync(binary, fs.constants.X_OK); return { command: binary, prefix: [] }; } catch { /* next PATH entry */ }
    }
  }
  return null;
}

export const codexArgs = (sandbox: string) => ['exec', '--json', '--color', 'never', '--sandbox', sandbox, '-c', 'approval_policy="never"', '-'];

export class CliRunner {
  private runs = new Map<string, { view: CliRun; child: ChildProcess; timer: NodeJS.Timeout }>();
  constructor(private adapter = findCodex(), private spawnProcess: typeof spawn = spawn) {}
  available() { return Boolean(this.adapter); }
  latest(taskId: string) { return this.runs.get(taskId)?.view ?? null; }
  start(taskId: string, workspace: string, sandbox: string, prompt: string): CliRun {
    if (!this.adapter) throw new Error('Codex CLI is not installed on the dashboard server PATH.');
    const current = this.latest(taskId);
    if (current && ['running', 'stopping'].includes(current.status)) throw new Error('This task already has an active CLI run.');
    if (this.runs.size >= 50 && !this.runs.has(taskId)) {
      const old = [...this.runs].find(([, run]) => !['running', 'stopping'].includes(run.view.status));
      if (old) this.runs.delete(old[0]);
      else throw new Error('CLI run limit reached. Stop an active run first.');
    }
    const view: CliRun = { id: randomUUID(), taskId, workspace, sandbox, status: 'running', startedAt: new Date().toISOString(), output: '', truncated: false };
    const child = this.spawnProcess(this.adapter.command, [...this.adapter.prefix, ...codexArgs(sandbox)], {
      cwd: workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const append = (data: string) => {
      view.output += data;
      if (view.output.length > 200000) { view.output = view.output.slice(-200000); view.truncated = true; }
    };
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      view.status = view.status === 'stopping' ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
      view.exitCode = code; view.finishedAt = new Date().toISOString();
    };
    child.on('error', (err) => { append(`\nLaunch failed: ${err.message}\n`); finish(null); });
    child.on('close', finish);
    child.stdin?.on('error', (err) => append(`\nInput failed: ${err.message}\n`));
    const timer = setTimeout(() => { append('\n30-minute limit reached. Stopping CLI.\n'); this.stop(taskId, view.id); }, 30 * 60 * 1000);
    timer.unref();
    this.runs.set(taskId, { view, child, timer });
    child.stdin?.end(prompt);
    return view;
  }
  stop(taskId: string, id: string): CliRun {
    const run = this.runs.get(taskId);
    if (!run || run.view.id !== id) throw new Error('CLI run no longer matches. Refresh first.');
    if (!['running', 'stopping'].includes(run.view.status)) return run.view;
    run.view.status = 'stopping';
    if (run.child.pid) {
      if (process.platform === 'win32') {
        const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, shell: false });
        if (result.status !== 0) { run.view.status = 'running'; throw new Error('Could not stop CLI process tree. Retry Stop.'); }
      } else {
        try { process.kill(-run.child.pid, 'SIGKILL'); } catch { run.child.kill('SIGKILL'); }
      }
    }
    return run.view;
  }
  shutdown() {
    for (const [taskId, { view }] of this.runs) {
      try { this.stop(taskId, view.id); } catch { /* process exiting */ }
    }
  }
}

export const cliRunner = new CliRunner();
