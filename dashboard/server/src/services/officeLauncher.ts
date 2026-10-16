import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { OfficeLaunch, OfficeLaunchKind } from '../../../shared/types';
import { StreamProgress, type StreamSummary } from './streamProgress';

// Start buttons (Monitor › run detail, Knowledge › Open findings) open an agent
// CLI with a prompt the server builds from the task's own files (or the weekly
// re-check's), never a free prompt. The task prompt asks the agent for its role
// output only; after the step the dashboard runs validate, enforce and sync itself,
// holding the task's lease, and commits the diff (stepGovernance.ts). The argv and
// sandbox envelope come from cliAdapter.ts, the usability checks from cliProbe.ts.
//
// The process is detached and writes to files, so it outlives a dashboard
// restart: <id>.json holds the launch, <id>.log its output, <id>.prompt the prompt
// fed to the CLI's stdin (never argv: no ps exposure, no Windows length limit), and
// a small node wrapper writes <id>.exit when the command ends (node, not /bin/sh,
// so the same path runs on Windows). The wrapper is started through a short-lived
// middle process, so it is not a descendant of the dashboard: nodemon kills the
// whole process tree on every restart (psTree), and took a running re-check with it
// on 2026-10-16. A launch with no exit file and no live pid was killed hard
// (kill -9, reboot): reported as "lost".
//
// The wrapper also enforces the step's time limit: when it passes it writes
// <id>.timeout, stops the process group (SIGTERM, then SIGKILL to the CLI after
// 10 s) and the launch reads as failed with that reason. A streamed launch (the
// CLI's JSON output) is parsed into readable progress, and a protocol failure in it
// fails the launch even on exit 0 (streamProgress.ts).

export const TASK_ROLES = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam'] as const;
export const TASK_CLIS = ['claude', 'codex', 'cursor-agent'] as const;
export type TaskRole = typeof TASK_ROLES[number];
export type TaskCli = typeof TASK_CLIS[number];

/** The Weekly Re-check Run's model (workflows/knowledge-librarian.md). */
export const KNOWLEDGE_MODEL = 'claude-opus-5-5';
const LOG_TAIL_BYTES = 64 * 1024;
const KEEP_PER_KEY = 10;

/** What to spawn for a CLI: the executable plus any leading arguments (a node script behind an npm shim). */
export interface Executable { command: string; prefix: string[] }

/**
 * Codex model for unattended steps. ~/.codex/config.toml can name a model the ChatGPT
 * account rejects (gpt-6.1-sol on 2026-10-16: 400 "not supported when using Codex with
 * a ChatGPT account"), so the dashboard always pins one; DASHBOARD_CODEX_MODEL overrides.
 */
export const CODEX_MODEL = process.env.DASHBOARD_CODEX_MODEL?.trim() || 'gpt-5.6-sol';

/** Claude model for task steps: DASHBOARD_CLAUDE_MODEL, or the CLI's own default when unset (as before). */
export const CLAUDE_TASK_MODEL = process.env.DASHBOARD_CLAUDE_MODEL?.trim() || undefined;

const executableFile = (file: string) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

/**
 * First usable `name` on PATH. On Windows a .exe/.com runs directly; an npm .cmd shim
 * cannot run without a shell (Node refuses, and a shell would parse the arguments), so
 * its target script runs under node instead, or the CLI reads as unavailable.
 */
export function findOnPath(name: string, envPath = process.env.PATH || '', platform: NodeJS.Platform = process.platform): Executable | null {
  const dirs = envPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    if (platform !== 'win32') {
      if (executableFile(path.join(dir, name))) return { command: path.join(dir, name), prefix: [] };
      continue;
    }
    for (const ext of ['.exe', '.com']) if (fs.existsSync(path.join(dir, name + ext))) return { command: path.join(dir, name + ext), prefix: [] };
    const shim = path.join(dir, `${name}.cmd`);
    if (!fs.existsSync(shim)) continue;
    const target = /"%~?dp0%?\\?([^"]+?\.(?:c|m)?js)"/i.exec(fs.readFileSync(shim, 'utf8'))?.[1];
    const script = target && path.join(dir, ...target.split(/[\\/]/));
    if (script && fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
  }
  return null;
}

/**
 * Runs argv[2..] with argv[0] the exit file and argv[1] its options (JSON: stdin file,
 * time limit, timeout file, heartbeat), mirrors its output, and records its exit code.
 * The heartbeat (a task step's lease renewal, stepGovernance.ts) runs on its interval
 * only while the wrapper lives, so it stops with the CLI and survives a dashboard
 * restart; after a refusal (the lease was lost) it stops renewing. A signal
 * to the wrapper is passed to the CLI, so the exit code still lands. On the time limit
 * it signals its own process group (the wrapper leads it: it was started detached),
 * which reaches the CLI and anything the CLI spawned.
 */
const WRAPPER = `const fs = require('fs'); const [exitFile, optionsJson, cmd, ...args] = process.argv.slice(1);
const options = JSON.parse(optionsJson);
const done = (code) => { try { fs.writeFileSync(exitFile, String(code)); } finally { process.exit(code); } };
const stdin = options.stdin ? fs.openSync(options.stdin, 'r') : 'ignore';
const child = require('child_process').spawn(cmd, args, { stdio: [stdin, 'inherit', 'inherit'], windowsHide: true });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
if (options.limitMs > 0) setTimeout(() => {
  fs.writeFileSync(options.timeoutFile, String(options.limitMs));
  console.error('Time limit reached: stopping the step.');
  try { process.kill(-process.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => child.kill('SIGKILL'), 10000).unref();
}, options.limitMs).unref();
if (options.heartbeat) {
  const [hbCmd, ...hbArgs] = options.heartbeat.argv;
  const beat = setInterval(() => {
    const hb = require('child_process').spawn(hbCmd, hbArgs, { stdio: 'ignore', windowsHide: true });
    hb.on('error', () => {});
    hb.on('exit', (code) => { if (code !== 0) { console.error('Lease renewal refused (exit ' + code + '): the task lease is lost; no further renewals.'); clearInterval(beat); } });
  }, options.heartbeat.intervalMs);
  beat.unref();
}
child.on('error', (err) => { console.error('Launch failed: ' + err.message); done(127); });
child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (require('os').constants.signals[signal] || 0) : 1)));`;

/** Starts the wrapper detached with output to the log file, prints its pid, and exits (argv: wrapper source, log, exit file, options, cmd…). */
const DETACH = `const fs = require('fs'); const [wrapper, log, ...rest] = process.argv.slice(1);
const fd = fs.openSync(log, 'a');
const child = require('child_process').spawn(process.execPath, ['-e', wrapper, ...rest], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
child.unref(); process.stdout.write(String(child.pid));`;

/** step: the task step's governance record (stepGovernance.ts); integrity: its task-input snapshot. */
type LaunchFile = 'json' | 'log' | 'exit' | 'prompt' | 'timeout' | 'step' | 'integrity';
const LAUNCH_FILES: LaunchFile[] = ['json', 'log', 'exit', 'prompt', 'timeout', 'step', 'integrity'];

interface Stored {
  id: string; kind: OfficeLaunchKind; key: string; label: string; display: string;
  cwd: string; pid: number; startedAt: string; stopRequested?: boolean;
  /** Task launches: the role, for the contract check. */
  role?: string;
  /** The CLI whose streamed JSON the log holds (adapter launches); absent: plain output. */
  stream?: TaskCli;
  timeLimitMs?: number;
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A launch's stream parsed so far: the log is read on from where the last view stopped. */
interface StreamCursor { offset: number; parser: StreamProgress; ended: boolean }

export interface LaunchInput {
  kind: OfficeLaunchKind; key: string; label: string;
  /** argv[0] is the executable; it runs verbatim (no shell). */
  argv: string[];
  /** What the page shows (the full argv can be long). */
  display: string;
  cwd: string; role?: string;
  /** Fed to the CLI's stdin from a file (0600), never put on the command line. */
  stdin?: string;
  /** The CLI's environment (default: the dashboard's). */
  env?: NodeJS.ProcessEnv;
  /** The log is this CLI's streamed JSON: parse it into progress and protocol failures. */
  stream?: TaskCli;
  /** Stop the tree and fail the launch after this long (unset or 0: no limit). */
  timeLimitMs?: number;
  /** A launch id from newId(), when records made before the spawn must name it (a task step's lease and step record). */
  id?: string;
  /** Run argv every intervalMs while the CLI is alive (a task step's lease renewal). */
  heartbeat?: { argv: string[]; intervalMs: number };
}

export class OfficeLauncher {
  private readonly streams = new Map<string, StreamCursor>();

  constructor(
    readonly dir = path.join(os.tmpdir(), 'ai-dev-office-dashboard', 'launches'),
    private readonly now = () => new Date(),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runTaskkill: typeof spawnSync = spawnSync,
  ) {}

  private file(id: string, ext: LaunchFile) { return path.join(this.dir, `${id}.${ext}`); }

  private stored(): Stored[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).flatMap((n) => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')) as Stored]; } catch { return []; }
    });
  }

  /** Parses the log past what earlier views read; once the process is gone, flushes the parser for good. */
  private streamSummary(id: string, cli: TaskCli, exited: boolean): StreamSummary {
    let cursor = this.streams.get(id);
    if (!cursor) { cursor = { offset: 0, parser: new StreamProgress(cli), ended: false }; this.streams.set(id, cursor); }
    if (!cursor.ended) {
      try {
        const logFile = this.file(id, 'log');
        const size = fs.statSync(logFile).size;
        if (size > cursor.offset) {
          const fd = fs.openSync(logFile, 'r');
          try {
            const buffer = Buffer.alloc(size - cursor.offset);
            fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
            cursor.parser.push(buffer);
            cursor.offset = size;
          } finally { fs.closeSync(fd); }
        }
      } catch { /* no output yet */ }
      if (exited) { cursor.parser.end(); cursor.ended = true; }
    }
    return cursor.parser.summary();
  }

  private view(s: Stored): OfficeLaunch {
    let exitCode: number | null | undefined;
    let finishedAt: string | undefined;
    try {
      const exitFile = this.file(s.id, 'exit');
      exitCode = Number.parseInt(fs.readFileSync(exitFile, 'utf8').trim(), 10);
      if (Number.isNaN(exitCode)) exitCode = null;
      finishedAt = fs.statSync(exitFile).mtime.toISOString();
    } catch { /* still running, or lost */ }
    const running = exitCode === undefined && alive(s.pid);
    const timedOut = fs.existsSync(this.file(s.id, 'timeout'));
    const stream = s.stream ? this.streamSummary(s.id, s.stream, !running) : undefined;
    // claude and cursor-agent always end on a result event, codex on turn.completed:
    // an exit 0 without one means the stream was cut short.
    const protocolFailure = stream?.failure ?? (stream && exitCode === 0 && !stream.finished ? 'the CLI exited without its final result event' : undefined);
    const limitMs = s.timeLimitMs ?? 0;
    const overTime = `time limit of ${limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} min` : `${Math.round(limitMs / 1000)} s`} reached: the step was stopped`;
    let status: OfficeLaunch['status'];
    let failureReason: string | undefined;
    if (exitCode !== undefined) {
      if (s.stopRequested) status = 'stopped';
      else if (timedOut) { status = 'failed'; failureReason = overTime; }
      else if (exitCode === 0 && !protocolFailure) status = 'succeeded';
      else { status = 'failed'; failureReason = protocolFailure ?? `exit code ${exitCode ?? 'unknown'}`; }
    } else if (running) status = s.stopRequested ? 'stopping' : 'running';
    else if (s.stopRequested) status = 'stopped';
    else if (timedOut) { status = 'failed'; failureReason = overTime; }
    else status = 'lost';
    let log = '';
    let truncated = false;
    try {
      const logFile = this.file(s.id, 'log');
      const size = fs.statSync(logFile).size;
      const fd = fs.openSync(logFile, 'r');
      try {
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        log = buffer.toString('utf8');
        truncated = size > length;
      } finally { fs.closeSync(fd); }
    } catch { /* no output yet */ }
    return { id: s.id, kind: s.kind, key: s.key, label: s.label, ...(s.role ? { role: s.role } : {}), command: s.display, cwd: s.cwd, startedAt: s.startedAt,
      status, ...(exitCode !== undefined ? { exitCode } : {}), ...(finishedAt ? { finishedAt } : {}), log, truncated,
      ...(s.stream ? { cli: s.stream, progress: stream?.progress ?? [] } : {}),
      ...(failureReason ? { failureReason } : {}),
      ...(s.timeLimitMs ? { timeLimitMinutes: Math.round(s.timeLimitMs / 60_000) } : {}) };
  }

  /** A fresh launch id: time first, so ids sort by start. */
  newId(): string {
    return `${this.now().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  }

  /** One launch by id, or null. */
  get(id: string): OfficeLaunch | null {
    const s = this.stored().find((x) => x.id === id);
    return s ? this.view(s) : null;
  }

  /** The newest launch for a task id (or 'knowledge'), finished or not. */
  latest(key: string): OfficeLaunch | null {
    const newest = this.stored().filter((s) => s.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return newest ? this.view(newest) : null;
  }

  /** Every launch still running (any task, or the knowledge re-check), newest first. */
  active(): OfficeLaunch[] {
    return this.stored().map((s) => this.view(s)).filter((l) => ['running', 'stopping'].includes(l.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  start(input: LaunchInput): OfficeLaunch {
    const current = this.latest(input.key);
    if (current && ['running', 'stopping'].includes(current.status)) throw new Error(`${input.label} is already running (started ${current.startedAt}).`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune(input.key);
    const id = input.id ?? this.newId();
    if (fs.existsSync(this.file(id, 'json'))) throw new Error(`Launch ${id} exists already.`);
    if (input.stdin !== undefined) fs.writeFileSync(this.file(id, 'prompt'), input.stdin, { mode: 0o600 });
    const options = {
      ...(input.stdin !== undefined ? { stdin: this.file(id, 'prompt') } : {}),
      ...(input.timeLimitMs ? { limitMs: input.timeLimitMs, timeoutFile: this.file(id, 'timeout') } : {}),
      ...(input.heartbeat ? { heartbeat: input.heartbeat } : {}),
    };
    // argv runs verbatim (no shell parses anything); the middle process exits at
    // once, so the wrapper is re-parented away from the dashboard's process tree.
    const middle = spawnSync(process.execPath, ['-e', DETACH, WRAPPER, this.file(id, 'log'), this.file(id, 'exit'), JSON.stringify(options), ...input.argv], {
      cwd: input.cwd, env: input.env ?? process.env, windowsHide: true, encoding: 'utf8', timeout: 10_000,
    });
    const pid = Number.parseInt(middle.stdout ?? '', 10) || undefined;
    if (!pid && middle.stderr) fs.appendFileSync(this.file(id, 'log'), middle.stderr);
    if (!pid) throw new Error(`Could not start ${input.label}.`);
    const stored: Stored = { id, kind: input.kind, key: input.key, label: input.label, display: input.display, cwd: input.cwd, pid, startedAt: this.now().toISOString(),
      ...(input.role ? { role: input.role } : {}), ...(input.stream ? { stream: input.stream } : {}), ...(input.timeLimitMs ? { timeLimitMs: input.timeLimitMs } : {}) };
    fs.writeFileSync(this.file(id, 'json'), JSON.stringify(stored, null, 2));
    return this.view(stored);
  }

  /** Ends the whole tree (wrapper, CLI, anything it spawned): SIGTERM to the group, or taskkill /T on Windows. */
  stop(id: string): OfficeLaunch {
    const s = this.stored().find((x) => x.id === id);
    if (!s) throw new Error('Launch not found. Refresh first.');
    const current = this.view(s);
    if (!['running', 'stopping'].includes(current.status)) return current;
    s.stopRequested = true;
    fs.writeFileSync(this.file(id, 'json'), JSON.stringify(s, null, 2));
    if (this.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      this.runTaskkill(taskkill, ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true, shell: false });
    } else {
      try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ } }
    }
    return this.view(s);
  }

  private prune(key: string) {
    const old = this.stored().filter((s) => s.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(KEEP_PER_KEY - 1);
    for (const s of old) {
      this.streams.delete(s.id);
      for (const ext of LAUNCH_FILES) fs.rmSync(this.file(s.id, ext), { force: true });
    }
  }
}

export const officeLauncher = new OfficeLauncher();
