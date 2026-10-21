import { execFile } from 'child_process';
import path from 'path';
import { findOnPath } from './officeLauncher';

// The office scripts the dashboard drives as the runtime adapter
// (docs/runtime-adapter-contract.md): run by argv, never through a shell, from the
// office root, with an environment that names no other office or run. A dashboard
// started from inside a run-agent.sh dispatch would otherwise hand that dispatch's
// run id, epoch or office dir to every script it runs.

export interface ScriptResult { code: number; stdout: string; stderr: string }

/**
 * Variables the scripts read for run identity, ownership, the office dir and the history operator (with the
 * harness markers it falls back to: a row a person writes from the dashboard names no AI tool): only ever set explicitly.
 */
const OFFICE_ENV = ['AI_DEV_OFFICE_RUN_ID', 'AI_DEV_OFFICE_OWNERSHIP_EPOCH', 'AI_DEV_OFFICE_OWNERSHIP', 'AI_DEV_OFFICE_CONFIG_DIR', 'AI_DEV_OFFICE_HOME', 'AI_OFFICE_RUNS_DIR', 'AI_DEV_OFFICE_WORKTREE', 'OFFICE_PROFILE',
  'AI_DEV_OFFICE_HISTORY_OPERATOR', 'CURSOR_AGENT', 'CODEX_THREAD_ID', 'CLAUDECODE'];

export function scriptEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of OFFICE_ENV) delete env[key];
  return { ...env, ...extra };
}

/** Absolute ruby when it is on PATH (the detached heartbeat runs without the dashboard's shell), else "ruby". */
export const RUBY = findOnPath('ruby')?.command ?? 'ruby';

/** Runs a command and resolves with its exit code and output; never rejects. */
export function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd: options.cwd, env: scriptEnv(options.env), timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : e.killed ? 124 : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + (e && typeof e.code !== 'number' ? `${e.message}\n` : '') });
    });
    // A child that exits before reading its stdin fails the write (EPIPE); its exit code is the result.
    child.stdin?.on('error', () => {}).end(options.stdin ?? '');
  });
}

/** ruby <officeRoot>/<script> args, from the office root. */
export const ruby = (officeRoot: string, script: string, args: string[], options: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}) =>
  run(RUBY, [path.join(officeRoot, script), ...args], { cwd: options.cwd ?? officeRoot, env: options.env, stdin: options.stdin });

/** The last lines of a script's output, for the Launch card (the full output is not kept). */
export function tail(text: string, lines = 15, chars = 2000): string {
  const kept = text.trim().split('\n').slice(-lines).join('\n');
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
}
