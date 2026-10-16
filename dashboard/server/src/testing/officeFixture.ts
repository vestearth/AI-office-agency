import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Test support (excluded from the build): a throwaway office root with copies of the
// real office scripts, validators and config, so the governance tests run the very
// scripts the dashboard drives, against runs/ that belong to the test. Copies, never
// symlinks: the office scripts resolve their office dir from their own realpath, so a
// symlinked scripts/ would write into the real runs/.

/** The office checkout these sources live in (dashboard/server/src/testing → office root). */
export const REAL_OFFICE = path.resolve(__dirname, '../../../..');

const COPY = ['scripts', 'agents', 'schemas', 'runners', 'templates', 'profiles', 'workflows', 'validate-yaml.rb', 'run-agent.sh', 'office.config.yaml', 'office.team.yaml'];

export interface OfficeFixture {
  root: string;
  runs: string;
  /** Creates runs/<id> with task.md and status.yaml (phase assigned, dev next by default). */
  task(id: string, status?: Record<string, unknown>): string;
  cleanup(): void;
}

export function makeOffice(options: { leaseSeconds?: number; renewSeconds?: number } = {}): OfficeFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-fixture-'));
  const root = path.join(base, 'office');
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  for (const item of COPY) fs.cpSync(path.join(REAL_OFFICE, item), path.join(root, item), { recursive: true });
  // No SocratiCode lookups from a test dispatch; a short lease when the test needs one.
  const local = ['context_provider:', '  enabled: false'];
  if (options.leaseSeconds) local.push('ownership:', `  lease_seconds: ${options.leaseSeconds}`, `  renew_interval_seconds: ${options.renewSeconds ?? 1}`);
  fs.writeFileSync(path.join(root, 'office.config.local.yaml'), `${local.join('\n')}\n`);
  const runs = path.join(root, 'runs');
  return {
    root, runs,
    task(id, status = {}) {
      const dir = path.join(runs, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.md'), `# ${id}: fixture task\n\nRepo: demo\n`);
      const fields = { task_id: id, phase: 'assigned', state: 'assigned', iteration: 1, current_agent: 'dev', ...status };
      fs.writeFileSync(path.join(dir, 'status.yaml'), `${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`);
      return dir;
    },
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

/** A throwaway repository with one commit on main, and a linked worktree on task/<task>. */
export function makeRepoWorktree(task: string): { repo: string; worktree: string; branch: string; cleanup(): void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-repo-'));
  const repo = path.join(base, 'demo');
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'fixture@example.invalid');
  g(repo, 'config', 'user.name', 'Fixture Operator');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'chore: initial');
  const branch = `task/${task}`;
  const worktree = path.join(base, '.worktrees', `demo-${task}`);
  g(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
  return { repo, worktree, branch, cleanup() { fs.rmSync(base, { recursive: true, force: true }); } };
}

/** A role output that passes validate-yaml.rb for dev (next: reviewer). */
export const VALID_DEV_OUTPUT = `summary: "Change hello.txt greeting."
artifacts:
  - path: hello.txt
    action: modified
next_action:
  agent: reviewer
  reason: "Ready for review."
blockers: []
claims:
  - claim: "the greeting reads hello world"
    command: "cat hello.txt"
    result: pass
`;

/** Fails validate-yaml.rb: next_action.agent is not a role. */
export const INVALID_DEV_OUTPUT = `summary: "Broken."
artifacts: []
next_action:
  agent: not-a-role
  reason: "x"
blockers: []
`;
