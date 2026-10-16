import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CODEX_MODEL, type Executable, type TaskCli } from './officeLauncher';

// Run › one unattended step (docs/start-task-redesign-spec.md, D5 and "Per-CLI
// invocation"): the argv, environment and working-directory files each CLI gets.
// One envelope for all three, through each CLI's macOS sandbox: writes only in the
// working directory and the extra writable directories (runs/<TASK>), network off,
// local tests and builds allowed, and the step fails rather than run unsandboxed.
// The prompt goes over stdin (officeLauncher), never on the command line; the output
// is streamed JSON (streamProgress).

export interface StepEnvelope {
  /** The step's working directory (the sandbox's writable root). */
  cwd: string;
  /** Other writable directories: runs/<TASK>. */
  writableDirs: string[];
  /** claude: --model when set (the CLI default otherwise); codex: always pinned (CODEX_MODEL). */
  model?: string;
  /** cursor-agent --trust: only ever on a working directory the dashboard created (D3/D10). */
  trustWorkspace?: boolean;
  /** claude: permission denies on top of the envelope's (the knowledge re-check's git guards). */
  extraDeny?: string[];
}

/** claude permissions: file tools allowed, push and web refused (network is off in the sandbox as well). */
export const CLAUDE_DENY = ['Bash(git push *)', 'WebFetch', 'WebSearch'];

/** claude --settings: Bash runs only inside the sandbox, which must start, with no domains allowed. */
export function claudeSettings(extraDeny: string[] = []): string {
  return JSON.stringify({
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [], strictAllowlist: true },
    },
    permissions: { allow: ['Edit', 'Write', 'Read'], deny: [...CLAUDE_DENY, ...extraDeny] },
  });
}

/** The arguments after the executable. The prompt is not among them: it goes on stdin. */
export function stepArgs(cli: TaskCli, env: StepEnvelope): string[] {
  const addDirs = env.writableDirs.flatMap((dir) => ['--add-dir', dir]);
  switch (cli) {
    case 'claude':
      // --setting-sources user: the working directory's project settings (and their
      // hooks, checked 2026-10-17) are not loaded; -p with no prompt argument reads stdin.
      return ['-p', ...(env.model ? ['--model', env.model] : []), '--output-format', 'stream-json', '--verbose', ...addDirs,
        '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', 'user', '--no-session-persistence',
        '--settings', claudeSettings(env.extraDeny)];
    case 'codex':
      // No --skip-git-repo-check: codex runs only in a git repository or a directory the operator trusted.
      return ['exec', '-m', env.model ?? CODEX_MODEL, '--json', '-s', 'workspace-write', '-C', env.cwd, ...addDirs,
        '-c', 'sandbox_workspace_write.network_access=false', '-c', 'approval_policy="never"', '--ephemeral', '-'];
    case 'cursor-agent':
      // Extra writable paths and the network policy live in <cwd>/.cursor/sandbox.json (prepareWorkspace).
      return ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', ...(env.trustWorkspace ? ['--trust'] : []), '--workspace', env.cwd];
    default:
      throw new Error(`CLI must be one of claude, codex, cursor-agent.`);
  }
}

export const stepArgv = (cli: TaskCli, exe: Executable, env: StepEnvelope) => [exe.command, ...exe.prefix, ...stepArgs(cli, env)];

/** Values the adapter relies on, beyond the flags themselves, that each CLI's help must list. */
const HELP_VALUES: Record<TaskCli, string[]> = {
  claude: ['stream-json', 'dontAsk'],
  codex: ['workspace-write'],
  'cursor-agent': ['stream-json'],
};

/** Where each CLI lists the flags stepArgs uses. */
export const HELP_ARGS: Record<TaskCli, string[]> = { claude: ['--help'], codex: ['exec', '--help'], 'cursor-agent': ['--help'] };

/** Every flag stepArgs can pass (all options on), plus the values it relies on: what the help probe looks for. */
export function requiredHelpTokens(cli: TaskCli): string[] {
  const all = stepArgs(cli, { cwd: '/w', writableDirs: ['/r'], model: 'm', trustWorkspace: true });
  return [...new Set([...all.filter((a) => /^--?[A-Za-z]/.test(a)), ...HELP_VALUES[cli]])];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tokens missing from a help text, matched as whole words (`-m` is not `-model`). */
export function missingFromHelp(help: string, tokens: string[]): string[] {
  return tokens.filter((t) => !new RegExp(`(^|[\\s,\\[("'])${escape(t)}(?=[\\s,=<\\[\\])"'.|]|$)`, 'm').test(help));
}

/** The step's environment: Go's build cache inside the working directory, the one place the sandbox lets it write. */
export function stepEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GOCACHE: path.join(cwd, '.cache', 'go-build') };
}

/** cursor-agent's sandbox policy file content. */
export function cursorSandboxPolicy(writableDirs: string[]) {
  return { type: 'workspace_readwrite', additionalReadwritePaths: writableDirs, networkPolicy: { default: 'deny' } };
}

/**
 * The repository's info/exclude for `cwd` (the common dir's for a linked worktree, as git
 * resolves it) and cwd's path inside the repository; null outside a git work tree.
 */
export type ExcludeLocator = (cwd: string) => { excludeFile: string; prefix: string } | null;

export const gitExclude: ExcludeLocator = (cwd) => {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-prefix', '--git-path', 'info/exclude'], {
      cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [prefix = '', file = ''] = out.split('\n');
    return file.trim() ? { excludeFile: path.resolve(cwd, file.trim()), prefix: prefix.trim() } : null;
  } catch { return null; }
};

/** Adds `/<prefix><entry>` lines missing from the exclude file (never the tracked .gitignore). */
function exclude(cwd: string, entries: string[], locate: ExcludeLocator) {
  const found = locate(cwd);
  if (!found) return;
  let current = '';
  try { current = fs.readFileSync(found.excludeFile, 'utf8'); } catch { /* not written yet */ }
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = entries.map((e) => `/${found.prefix}${e}`).filter((l) => !have.has(l));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(found.excludeFile), { recursive: true });
  fs.appendFileSync(found.excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}# ai-dev-office dashboard step files\n${missing.join('\n')}\n`);
}

/**
 * Files a step needs in its working directory before it starts: the Go build cache
 * directory for every CLI, and cursor-agent's .cursor/sandbox.json. In a git work tree
 * both stay out of git through info/exclude. Throws, with the reason, rather than
 * replace a sandbox.json that is not a deny-network workspace policy like the dashboard's.
 */
export function prepareWorkspace(cli: TaskCli, env: StepEnvelope, locate: ExcludeLocator = gitExclude) {
  fs.mkdirSync(path.join(env.cwd, '.cache', 'go-build'), { recursive: true });
  const entries = ['.cache/'];
  if (cli === 'cursor-agent') {
    const file = path.join(env.cwd, '.cursor', 'sandbox.json');
    if (fs.existsSync(file)) {
      let existing: { type?: unknown; networkPolicy?: { default?: unknown } } | null = null;
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not JSON */ }
      if (existing?.type !== 'workspace_readwrite' || existing.networkPolicy?.default !== 'deny') {
        throw new Error(`${file} exists and is not a deny-network workspace policy; the dashboard will not replace it.`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(cursorSandboxPolicy(env.writableDirs), null, 2)}\n`);
    entries.push('.cursor/');
  }
  exclude(env.cwd, entries, locate);
}

/** argv as the page shows it: the CLI name, then each argument (quoted when it has spaces or JSON). */
export function displayCommand(cli: TaskCli, args: string[]): string {
  return [cli, ...args.map((a) => (/[\s"'{}*]/.test(a) ? `'${a}'` : a))].join(' ');
}
