import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HELP_ARGS, missingFromHelp, requiredHelpTokens } from './cliAdapter';
import { CODEX_MODEL, findOnPath, TASK_CLIS, type Executable, type TaskCli } from './officeLauncher';

// Run › which CLIs can take a step (docs/start-task-redesign-spec.md, D4). A CLI is
// usable only when it is installed, its help lists every flag the adapter passes,
// its login probe says logged in, and (codex) the pinned model is in the account's
// catalog. Each check that fails gives the reason the page shows. Probes run with
// execFile (no shell) and short timeouts, and are cached for 15 s.
//
// cursor-agent's status JSON carries the account's email, user id and names: only
// its isAuthenticated boolean is read, and nothing of its output is logged or returned.

export interface ProbeResult {
  /** The exit code; null when the process did not exit normally (timeout, not found). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it did not run to an exit code: never the output itself. */
  error?: string;
}

export type ProbeExec = (exe: Executable, args: string[]) => Promise<ProbeResult>;

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_CACHE_MS = 15_000;

export const execProbe: ProbeExec = (exe, args) => new Promise((resolve) => {
  execFile(exe.command, [...exe.prefix, ...args], {
    timeout: PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1' },
  }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
    const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
    const error = e && code === null ? (e.killed ? `timed out after ${PROBE_TIMEOUT_MS / 1000} s` : String(e.code ?? 'could not run')) : undefined;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(error ? { error } : {}) });
  });
});

export interface CliUsability {
  id: TaskCli;
  usable: boolean;
  /** The first check that failed. */
  reason?: string;
  /** A check that was skipped, said plainly. */
  note?: string;
  /** The model a step will use, when the adapter pins one. */
  model?: string;
  /** Server side only: what to spawn. */
  executable?: Executable;
}

/** `claude auth status` prints JSON; only `loggedIn` is read. */
export function claudeLogin(r: ProbeResult): string | null {
  try {
    if ((JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true) return null;
    return 'not logged in (claude auth status: loggedIn is not true); run `claude auth login`';
  } catch { return `could not read \`claude auth status\` (${r.error ?? `exit ${r.code}`}, no JSON)`; }
}

/**
 * `codex login status` prints one line of text ("Logged in using ChatGPT"). A bare
 * /logged in/i would also match "Not logged in", so that phrase is ruled out first.
 */
export function codexLogin(r: ProbeResult): string | null {
  const text = `${r.stdout}\n${r.stderr}`;
  if (/not logged in/i.test(text)) return 'not logged in (codex login status); run `codex login`';
  if (/\blogged in\b/i.test(text)) return null;
  return `could not tell from \`codex login status\` (${r.error ?? `exit ${r.code}`}); run \`codex login\``;
}

/** `cursor-agent status --format json`: only `isAuthenticated` is read; the rest is personal data. */
export function cursorLogin(r: ProbeResult): string | null {
  let authenticated: unknown;
  try { authenticated = (JSON.parse(r.stdout) as { isAuthenticated?: unknown }).isAuthenticated; }
  catch { return `could not read \`cursor-agent status --format json\` (${r.error ?? `exit ${r.code}`}, no JSON)`; }
  return authenticated === true ? null : 'not logged in (cursor-agent status: isAuthenticated is not true); run `cursor-agent login`';
}

const LOGIN: Record<TaskCli, { args: string[]; check: (r: ProbeResult) => string | null }> = {
  claude: { args: ['auth', 'status'], check: claudeLogin },
  codex: { args: ['login', 'status'], check: codexLogin },
  'cursor-agent': { args: ['status', '--format', 'json'], check: cursorLogin },
};

/** The codex account catalog lists the models this login may use (`models[].slug`). */
export function codexModelAllowed(catalog: string | null, model: string, file: string): string | null {
  if (catalog === null) return `cannot confirm model ${model}: ${file} is missing`;
  let slugs: string[];
  try {
    const models = (JSON.parse(catalog) as { models?: { slug?: unknown }[] }).models;
    slugs = Array.isArray(models) ? models.map((m) => String(m?.slug ?? '')) : [];
  } catch { return `cannot confirm model ${model}: ${file} is not JSON`; }
  return slugs.includes(model) ? null : `model ${model} is not in the account catalog (${file}); set DASHBOARD_CODEX_MODEL to one of ${slugs.filter(Boolean).join(', ') || 'its models'}`;
}

export interface ProbeDeps {
  find: (name: string) => Executable | null;
  exec: ProbeExec;
  platform: NodeJS.Platform;
  /** The codex catalog file and a reader (null when missing). */
  codexCatalogFile: string;
  readFile: (file: string) => string | null;
  codexModel: string;
  now: () => number;
}

const readOrNull = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

export class CliProbe {
  private readonly deps: ProbeDeps;
  private readonly cache = new Map<TaskCli, { at: number; result: Promise<CliUsability> }>();

  constructor(deps: Partial<ProbeDeps> = {}, private readonly ttlMs = PROBE_CACHE_MS) {
    this.deps = {
      find: (name) => findOnPath(name), exec: execProbe, platform: process.platform,
      codexCatalogFile: path.join(os.homedir(), '.codex', 'model-catalogs', 'auto.json'), readFile: readOrNull,
      codexModel: CODEX_MODEL, now: () => Date.now(), ...deps,
    };
  }

  /** Cached for ttlMs (a failed probe too: it is re-run after that). */
  usability(id: TaskCli): Promise<CliUsability> {
    const hit = this.cache.get(id);
    if (hit && this.deps.now() - hit.at < this.ttlMs) return hit.result;
    const result = this.probe(id);
    this.cache.set(id, { at: this.deps.now(), result });
    return result;
  }

  all(): Promise<CliUsability[]> { return Promise.all(TASK_CLIS.map((id) => this.usability(id))); }

  private async probe(id: TaskCli): Promise<CliUsability> {
    const { deps } = this;
    const model = id === 'codex' ? deps.codexModel : undefined;
    const no = (reason: string): CliUsability => ({ id, usable: false, reason, ...(model ? { model } : {}) });
    // D9: the envelope is each CLI's macOS sandbox; Windows is a follow-up verified on a real machine.
    if (deps.platform === 'win32') return no('Run is not enabled on Windows yet: the sandboxed step is verified on macOS only');
    const exe = deps.find(id);
    if (!exe) return no(`${id} is not on the dashboard server PATH`);
    const help = await deps.exec(exe, HELP_ARGS[id]);
    const missing = missingFromHelp(`${help.stdout}\n${help.stderr}`, requiredHelpTokens(id));
    if (missing.length) return no(`\`${id} ${HELP_ARGS[id].join(' ')}\` does not list ${missing.join(', ')} (${help.error ?? 'update the CLI'})`);
    const login = LOGIN[id].check(await deps.exec(exe, LOGIN[id].args));
    if (login) return no(login);
    if (id === 'codex') {
      const denied = codexModelAllowed(deps.readFile(deps.codexCatalogFile), deps.codexModel, deps.codexCatalogFile);
      if (denied) return no(denied);
      return { id, usable: true, model, executable: exe };
    }
    return { id, usable: true, note: `model not checked: ${id} has no account catalog to check against`, executable: exe };
  }
}
