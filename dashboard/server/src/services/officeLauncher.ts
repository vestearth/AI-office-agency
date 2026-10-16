import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { OfficeLaunch, OfficeLaunchKind } from '../../../shared/types';

// Start buttons (Monitor › run detail, Knowledge › Open findings) open an agent
// CLI with a prompt the server builds from the task's own files (or the weekly
// re-check's), never a free prompt. The task prompt carries the runtime adapter
// contract (docs/runtime-adapter-contract.md): role output, validate, enforce,
// sync; the route checks the result after the run (taskContract.ts).
//
// The process is detached and writes to files, so it outlives a dashboard
// restart: <id>.json holds the launch, <id>.log its output, and the shell
// wrapper writes <id>.exit when the command ends. A launch with no exit file
// and no live pid was killed hard (kill -9, reboot): reported as "lost".

export const TASK_ROLES = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam'] as const;
export const TASK_CLIS = ['claude', 'codex', 'cursor-agent'] as const;
export type TaskRole = typeof TASK_ROLES[number];
export type TaskCli = typeof TASK_CLIS[number];

/** The Weekly Re-check Run's model (workflows/knowledge-librarian.md). */
export const KNOWLEDGE_MODEL = 'claude-opus-5-5';
const LOG_TAIL_BYTES = 64 * 1024;
const KEEP_PER_KEY = 10;

/** Guards for an unattended Claude run: no merges, force pushes or paid prod runtime (CLAUDE.md guardrail 5). */
const CLAUDE_TASK_DENY = 'Bash(gh pr merge:*),Bash(git push --force:*),Bash(git push -f:*),Bash(aws ecs update-service:*),Bash(aws rds start-db-instance:*),Bash(aws rds start-db-cluster:*)';

/** argv for one role step. Runs from the workspace root so the agent reaches the office and the target repo. */
export function taskCliArgs(cli: string, executable: string, prompt: string): string[] {
  switch (cli) {
    case 'claude':
      return [executable, '-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Grep,Glob,Write,Edit,Agent,Bash', '--disallowedTools', CLAUDE_TASK_DENY];
    case 'codex':
      // workspace-write: edits inside the workspace root, no network (no push, no AWS).
      return [executable, '--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt];
    case 'cursor-agent':
      return [executable, '-p', '--trust', prompt];
    default:
      throw new Error(`CLI must be one of ${TASK_CLIS.join(', ')}.`);
  }
}

/** Non-interactive Claude Code: edits accepted, git writes and deletes refused (the run never commits). */
export function knowledgeLaunchArgs(claude: string, prompt: string): string[] {
  return [claude, '-p', prompt, '--model', KNOWLEDGE_MODEL, '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Grep,Glob,Write,Edit,Agent,Bash',
    '--disallowedTools', 'Bash(git commit:*),Bash(git push:*),Bash(git reset:*),Bash(git checkout:*),Bash(rm:*)'];
}

/** First executable named `name` on PATH. */
export function findOnPath(name: string, envPath = process.env.PATH || ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next entry */ }
  }
  return null;
}

interface Stored {
  id: string; kind: OfficeLaunchKind; key: string; label: string; display: string;
  cwd: string; pid: number; startedAt: string; stopRequested?: boolean;
  /** Task launches: the role, for the contract check. */
  role?: string;
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

export class OfficeLauncher {
  constructor(
    private readonly dir = path.join(os.tmpdir(), 'ai-dev-office-dashboard', 'launches'),
    private readonly now = () => new Date(),
  ) {}

  private file(id: string, ext: 'json' | 'log' | 'exit') { return path.join(this.dir, `${id}.${ext}`); }

  private stored(): Stored[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).flatMap((n) => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')) as Stored]; } catch { return []; }
    });
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
    let status: OfficeLaunch['status'];
    if (exitCode !== undefined) status = s.stopRequested ? 'stopped' : exitCode === 0 ? 'succeeded' : 'failed';
    else if (alive(s.pid)) status = s.stopRequested ? 'stopping' : 'running';
    else status = s.stopRequested ? 'stopped' : 'lost';
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
      status, ...(exitCode !== undefined ? { exitCode } : {}), ...(finishedAt ? { finishedAt } : {}), log, truncated };
  }

  /** The newest launch for a task id (or 'knowledge'), finished or not. */
  latest(key: string): OfficeLaunch | null {
    const newest = this.stored().filter((s) => s.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return newest ? this.view(newest) : null;
  }

  /** argv[0] is the executable; `display` is what the page shows (the knowledge prompt is long). */
  start(input: { kind: OfficeLaunchKind; key: string; label: string; argv: string[]; display: string; cwd: string; role?: string }): OfficeLaunch {
    const current = this.latest(input.key);
    if (current && ['running', 'stopping'].includes(current.status)) throw new Error(`${input.label} is already running (started ${current.startedAt}).`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune(input.key);
    const id = `${this.now().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
    const log = fs.openSync(this.file(id, 'log'), 'a');
    let pid: number | undefined;
    try {
      // "$@" runs argv verbatim (no shell parsing of the arguments); $? lands in the
      // exit file even after the dashboard that started it is gone.
      const child = spawn('/bin/sh', ['-c', '"$@"; echo $? > "$OFFICE_LAUNCH_EXIT"', 'office-launch', ...input.argv], {
        cwd: input.cwd, detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, OFFICE_LAUNCH_EXIT: this.file(id, 'exit') },
      });
      pid = child.pid;
      child.unref();
    } finally { fs.closeSync(log); }
    if (!pid) throw new Error(`Could not start ${input.label}.`);
    const stored: Stored = { id, kind: input.kind, key: input.key, label: input.label, display: input.display, cwd: input.cwd, pid, startedAt: this.now().toISOString(), ...(input.role ? { role: input.role } : {}) };
    fs.writeFileSync(this.file(id, 'json'), JSON.stringify(stored, null, 2));
    return this.view(stored);
  }

  /** SIGTERM to the whole process group (the shell wrapper, the CLI and anything it spawned). */
  stop(id: string): OfficeLaunch {
    const s = this.stored().find((x) => x.id === id);
    if (!s) throw new Error('Launch not found. Refresh first.');
    const current = this.view(s);
    if (!['running', 'stopping'].includes(current.status)) return current;
    s.stopRequested = true;
    fs.writeFileSync(this.file(id, 'json'), JSON.stringify(s, null, 2));
    try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ } }
    return this.view(s);
  }

  private prune(key: string) {
    const old = this.stored().filter((s) => s.key === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(KEEP_PER_KEY - 1);
    for (const s of old) for (const ext of ['json', 'log', 'exit'] as const) fs.rmSync(this.file(s.id, ext), { force: true });
  }
}

export const officeLauncher = new OfficeLauncher();
