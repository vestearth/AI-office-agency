import type { StepEnvelope } from './cliAdapter';
import type { TaskCli } from './officeLauncher';
import { safeRefName, type WorktreeRecord, type WorktreeTarget } from './worktrees';

// Run › one task step in its worktrees (docs/start-task-redesign-spec.md, D3/D10): the
// repositories the operator confirmed, and the sandbox envelope they give the step.

const MAX_TARGETS = 8;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The confirmed repositories from a request body ({repos: [{repo, branch?, base?, adopt?}]}), or why they are not usable. */
export function parseTargets(body: unknown): WorktreeTarget[] | { error: string } {
  const raw = (body as { repos?: unknown } | null)?.repos;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS) return { error: `Repos must be a list of at most ${MAX_TARGETS} repositories.` };
  const targets: WorktreeTarget[] = [];
  for (const item of raw) {
    const { repo, branch, base, adopt } = (item ?? {}) as Record<string, unknown>;
    if (typeof repo !== 'string' || !REPO_NAME.test(repo) || repo.includes('..')) return { error: 'Each repo must be a repository name under the workspace root.' };
    if (targets.some((t) => t.repo === repo)) return { error: `${repo} is listed twice.` };
    if (adopt !== undefined && typeof adopt !== 'boolean') return { error: 'adopt must be true or false.' };
    const target: WorktreeTarget = { repo };
    for (const [key, value] of [['branch', branch], ['base', base]] as const) {
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string' || !safeRefName(value)) return { error: `${repo}: ${key} must be a git ref name.` };
      target[key] = value;
    }
    if (adopt) target.adopt = true;
    targets.push(target);
  }
  return targets;
}

/**
 * The step's envelope from its worktrees: the first (primary) is the working directory,
 * the others and runs/<TASK> the extra writable directories. cursor-agent gets --trust
 * only on a primary worktree the dashboard created (D10), never on an adopted one.
 */
export function runEnvelope(cli: TaskCli, worktrees: WorktreeRecord[], runDir: string, model?: string): StepEnvelope {
  const [primary, ...others] = worktrees;
  if (!primary) throw Object.assign(new Error('Confirm at least one target repository: a Run works in a task worktree, never at the workspace root.'), { status: 400 });
  return {
    cwd: primary.path, writableDirs: [...others.map((w) => w.path), runDir], ...(model ? { model } : {}),
    trustWorkspace: cli === 'cursor-agent' && primary.origin === 'created',
  };
}
