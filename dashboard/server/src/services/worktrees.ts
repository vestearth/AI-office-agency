import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { BaseOption, RepoProposal, WorktreeCleanup, WorktreePlan, WorktreeRecord, WorktreeTarget } from '../../../shared/types';

export type { BaseOption, RepoProposal, WorktreeCleanup, WorktreePlan, WorktreeRecord, WorktreeTarget };

// Run › where a step runs (docs/start-task-redesign-spec.md, D3 and D14): a git
// worktree per task per repository at <workspace>/.worktrees/<repo>-<TASK>, on the
// task's branch (task/<TASK>, or an existing task/<TASK>-<slug>), proposed from
// task.md and confirmed by the operator before a Run.
//
// What the dashboard may do is decided from git's own state each time:
// - a worktree it created (or adopted) earlier for this task and repo: reuse it;
// - a worktree at the path, or the task branch checked out in another linked
//   worktree, that it did not create: never modify, move or remove it; a Run may use
//   it only on the operator's explicit opt-in, recorded as adopted (never proposed
//   for removal);
// - the task branch checked out in the repository's main checkout: refuse;
// - the task branch exists but is checked out nowhere: add a worktree on it;
// - otherwise: create task/<TASK> from a base ref chosen from evidence (a branch
//   task.md names, else origin's default branch), shown to and overridable by the
//   operator. Only the server fetches; agents never fetch or push.
//
// A file-backed registry records each worktree the dashboard created or adopted.
// Cleanup (D14) proposes only registry entries it created, removable when the task
// is done or aborted, the branch is merged into its base or pushed to origin, and the
// worktree has no uncommitted or untracked files; removal is `git worktree remove`
// without --force, on the operator's confirmation only.

/** AGENTS.md hard guardrail 4: reference only, never a worktree or a writable target. */
export const READ_ONLY_REPOS = ['Games-Lab-Android'];

const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 90_000;

export class GitError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); }
}

/** git with argv (no shell); resolves stdout, rejects with git's stderr. */
export function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      // Never prompt for credentials on a fetch: fail instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      const detail = String(stderr).trim() || (e.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : e.message);
      reject(new GitError(`git ${args[0]}: ${detail}`, typeof e.code === 'number' ? e.code : null));
    });
  });
}

const gitOk = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const samePath = (a: string, b: string) => real(a) === real(b);

// ---------------------------------------------------------------- repositories

export interface RepoInfo { name: string; path: string; readOnly: boolean }

/**
 * The git repositories directly under the workspace root: directories whose .git is a
 * directory (a main checkout). A linked worktree placed there (.git is a file) is not
 * a repository of its own; dot-directories (.worktrees) are skipped.
 */
export function listRepos(workspaceRoot: string): RepoInfo[] {
  let names: string[];
  try { names = fs.readdirSync(workspaceRoot); } catch { return []; }
  return names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)).flatMap((name) => {
    const dir = path.join(workspaceRoot, name);
    try { if (!fs.statSync(path.join(dir, '.git')).isDirectory()) return []; } catch { return []; }
    return [{ name, path: dir, readOnly: READ_ONLY_REPOS.includes(name) }];
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A line that says which repository the task targets ("Repo:", "Repository:", "Service:", "Type: … (slip-api)"). */
const EXPLICIT_LINE = /^\s*(?:[-*]\s*)?\**\s*(?:target\s+)?(?:repo|repos|repository|repositories|service|services|type)\s*\**\s*:/i;
const BASE_ON_LINE = /\bbase(?:\s+branch)?\s*(?:[:=]|is|from)\s*`?([A-Za-z0-9][A-Za-z0-9._/-]{0,99})`?/i;
const BASE_LINE = /^\s*(?:[-*]\s*)?\**\s*base(?:\s+branch)?\s*\**\s*:\s*`?([A-Za-z0-9][A-Za-z0-9._/-]{0,99})`?/i;
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

/**
 * Target repositories proposed from task.md: real repository names named in it, as a
 * word, a path segment (`slip-api/internal/x.go`, an absolute path) or on a "Repo:" /
 * "Type: … (slip-api)" line. Explicit lines rank first, then order of first mention.
 * Read-only repositories (Games-Lab-Android) come back apart, as reference only.
 */
export function proposeRepos(taskMarkdown: string, repos: RepoInfo[]): { proposed: RepoProposal[]; referenceOnly: RepoProposal[] } {
  const lines = taskMarkdown.split('\n');
  const globalBase = lines.map((l, i) => ({ m: BASE_LINE.exec(l), i })).find((x) => x.m);
  const found: (RepoProposal & { explicit: boolean; first: number })[] = [];
  for (const repo of repos) {
    const re = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(repo.name)}(?![A-Za-z0-9_-])`, 'i');
    const hits = lines.map((text, i) => ({ text, i })).filter((l) => re.test(l.text));
    if (!hits.length) continue;
    const explicit = hits.some((h) => EXPLICIT_LINE.test(h.text));
    const sameLineBase = hits.map((h) => ({ m: BASE_ON_LINE.exec(h.text), h })).find((x) => x.m);
    const base = sameLineBase?.m ? { name: sameLineBase.m[1], evidence: `task.md line ${sameLineBase.h.i + 1}: ${clip(sameLineBase.h.text.trim())}` }
      : globalBase?.m ? { name: globalBase.m[1], evidence: `task.md line ${globalBase.i + 1}: ${clip(lines[globalBase.i].trim())}` } : undefined;
    found.push({
      repo: repo.name, readOnly: repo.readOnly, explicit, first: hits[0].i,
      evidence: hits.slice(0, 3).map((h) => `line ${h.i + 1}: ${clip(h.text.trim())}`),
      ...(base ? { base } : {}),
    });
  }
  found.sort((a, b) => Number(b.explicit) - Number(a.explicit) || a.first - b.first);
  const strip = ({ explicit: _e, first: _f, ...p }: typeof found[number]): RepoProposal => p;
  return { proposed: found.filter((p) => !p.readOnly).map(strip), referenceOnly: found.filter((p) => p.readOnly).map(strip) };
}

// ---------------------------------------------------------------- registry

/** The worktrees the dashboard created or adopted, one JSON file written atomically. */
export class WorktreeRegistry {
  constructor(readonly file: string) {}

  list(): WorktreeRecord[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { worktrees?: WorktreeRecord[] };
      return Array.isArray(data.worktrees) ? data.worktrees : [];
    } catch { return []; }
  }

  find(task: string, repo: string): WorktreeRecord | undefined { return this.list().find((r) => r.task === task && r.repo === repo); }

  put(record: WorktreeRecord) { this.write([...this.list().filter((r) => !(r.task === record.task && r.repo === record.repo)), record]); }

  remove(task: string, repo: string) { this.write(this.list().filter((r) => !(r.task === task && r.repo === repo))); }

  private write(worktrees: WorktreeRecord[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ worktrees }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- git state

interface GitWorktree { path: string; branch?: string; detached: boolean; main: boolean }

/** `git worktree list --porcelain`: the first entry is the main checkout. */
export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').map((block) => block.split('\n').filter(Boolean)).filter((l) => l.length).map((lines, i) => {
    const value = (key: string) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1);
    const ref = value('branch');
    return { path: value('worktree') ?? '', ...(ref ? { branch: ref.replace(/^refs\/heads\//, '') } : {}), detached: lines.includes('detached'), main: i === 0 };
  });
}

export const isTaskBranch = (branch: string, task: string) => branch === `task/${task}` || branch.startsWith(`task/${task}-`);

/** Local branches task/<TASK> and task/<TASK>-<slug>. */
async function taskBranches(repoPath: string, task: string): Promise<string[]> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${task}`, `refs/heads/task/${task}-*`]);
  return out.split('\n').map((s) => s.trim()).filter((b) => b && isTaskBranch(b, task));
}

const resolves = (repoPath: string, ref: string) => gitOk(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);

/** A ref or branch name the operator may pass: no option-looking or path-escaping values. */
export const safeRefName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/');

/** Base refs from evidence, best first: a branch task.md names (origin's copy first), origin's default branch, else the main checkout's branch. */
export async function baseOptions(repoPath: string, named?: { name: string; evidence: string }): Promise<BaseOption[]> {
  const options: BaseOption[] = [];
  const add = (ref: string, why: string) => { if (!options.some((o) => o.ref === ref)) options.push({ ref, why }); };
  if (named && safeRefName(named.name)) {
    const name = named.name.replace(/^origin\//, '');
    for (const ref of [`origin/${name}`, name]) if (await resolves(repoPath, ref)) { add(ref, `named in ${named.evidence}`); break; }
  }
  const originHead = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (originHead && await resolves(repoPath, originHead)) add(originHead, "origin's default branch (origin/HEAD)");
  if (!options.length) {
    const head = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (head) add(head, "the main checkout's current branch (the repository has no origin/HEAD)");
  }
  return options;
}

// ---------------------------------------------------------------- plan

export interface WorktreeContext {
  workspaceRoot: string;
  /** <workspace>/.worktrees */
  worktreesRoot: string;
  task: string;
  registry: WorktreeRegistry;
  /** task.md, for the base branch it names. */
  taskMarkdown?: string;
}

export const worktreePath = (ctx: WorktreeContext, repo: string) => path.join(ctx.worktreesRoot, `${repo}-${ctx.task}`);

/** Dependencies a step cannot fetch with the network off: a fresh worktree has no node_modules; Go needs its modules cached. */
async function dependencyWarnings(repoPath: string, where: { dir: string } | { ref: string }): Promise<string[]> {
  const has = async (file: string) => ('dir' in where ? fs.existsSync(path.join(where.dir, file)) : gitOk(repoPath, ['cat-file', '-e', `${where.ref}:${file}`]));
  const warnings: string[] = [];
  if (await has('package.json') && !('dir' in where && fs.existsSync(path.join(where.dir, 'node_modules')))) {
    warnings.push('Node project with no node_modules in the worktree: the step cannot install packages with the network off, so its npm tests and builds fail until you install them in the worktree (npm ci there) before the Run.');
  }
  if (await has('go.mod')) {
    warnings.push('Go module: the step cannot download modules with the network off; go test and go build work only when every module is already in the module cache (go mod download in the worktree before the Run).');
  }
  return warnings;
}

/** What a Run would do for one repository, from git's state now. Changes nothing. */
export async function planWorktree(ctx: WorktreeContext, target: WorktreeTarget): Promise<WorktreePlan> {
  const repos = listRepos(ctx.workspaceRoot);
  const repo = repos.find((r) => r.name === target.repo);
  const refuse = (reason: string, more: Partial<WorktreePlan> = {}): WorktreePlan => ({ repo: target.repo, action: 'refuse', reason, warnings: [], ...more });
  if (READ_ONLY_REPOS.includes(target.repo)) return refuse(`${target.repo} is read-only (AGENTS.md): reference only, never a worktree or a writable target.`);
  if (!repo) return refuse(`${target.repo} is not a git repository under ${ctx.workspaceRoot}.`);
  if (target.branch !== undefined && !(safeRefName(target.branch) && isTaskBranch(target.branch, ctx.task))) {
    return refuse(`Branch ${target.branch} must be task/${ctx.task} or task/${ctx.task}-<name>.`);
  }
  if (target.base !== undefined && !safeRefName(target.base)) return refuse(`Base ${target.base} is not a ref name the dashboard accepts.`);

  const wts = await listWorktrees(repo.path);
  const branches = await taskBranches(repo.path, ctx.task);
  const wtPath = worktreePath(ctx, repo.name);

  const record = ctx.registry.find(ctx.task, repo.name);
  if (record) {
    const live = wts.find((w) => samePath(w.path, record.path));
    if (live && live.branch === record.branch) {
      return { repo: repo.name, action: 'reuse', path: record.path, branch: record.branch, origin: record.origin, ...(record.base ? { base: record.base } : {}),
        reason: `Reuse the worktree the dashboard ${record.origin} for this task at ${record.path} (${record.branch}).`,
        warnings: await dependencyWarnings(repo.path, { dir: record.path }) };
    }
  }

  const adopt = (w: GitWorktree, why: string): WorktreePlan => ({
    repo: repo.name, action: 'adopt', path: w.path, branch: w.branch, needsOptIn: !target.adopt, warnings: [],
    reason: `${why} The dashboard did not create it and will never modify, move or remove it; a Run uses it only if you opt in, and it is recorded as adopted.`,
  });

  const atPath = wts.find((w) => samePath(w.path, wtPath));
  if (atPath) {
    if (atPath.branch && isTaskBranch(atPath.branch, ctx.task)) {
      const plan = adopt(atPath, `A worktree already exists at ${atPath.path} on ${atPath.branch}.`);
      return { ...plan, warnings: await dependencyWarnings(repo.path, { dir: atPath.path }) };
    }
    return refuse(`${atPath.path} is a worktree of ${repo.name} on ${atPath.branch ?? 'a detached HEAD'}, not a task/${ctx.task} branch; the dashboard will not touch it.`, { path: atPath.path });
  }
  if (fs.existsSync(wtPath)) return refuse(`${wtPath} exists and is not a worktree of ${repo.name}; the dashboard will not touch it.`, { path: wtPath });

  const holders = wts.filter((w) => w.branch && isTaskBranch(w.branch, ctx.task));
  const inMain = holders.find((w) => w.main);
  if (inMain) {
    return refuse(`${inMain.branch} is checked out in ${repo.name}'s main checkout (${inMain.path}); a step will not run in a main checkout. Switch that checkout to another branch, then plan again.`, { branch: inMain.branch });
  }
  const linked = holders.find((w) => !target.branch || w.branch === target.branch) ?? holders[0];
  if (linked) {
    const plan = adopt(linked, `${linked.branch} is already checked out in the worktree ${linked.path}.`);
    return { ...plan, warnings: await dependencyWarnings(repo.path, { dir: linked.path }) };
  }

  const named = target.base ? undefined : ctx.taskMarkdown ? proposeRepos(ctx.taskMarkdown, [repo]).proposed[0]?.base : undefined;
  const options = await baseOptions(repo.path, named);
  if (branches.length && !(target.branch && !branches.includes(target.branch))) {
    const chosen = target.branch ?? (branches.includes(`task/${ctx.task}`) ? `task/${ctx.task}` : branches.length === 1 ? branches[0] : undefined);
    if (!chosen) return refuse(`Several task branches exist in ${repo.name} (${branches.join(', ')}): choose one.`, { branches });
    return { repo: repo.name, action: 'add', path: wtPath, branch: chosen, ...(options[0] ? { base: target.base ?? options[0].ref } : {}), baseOptions: options, branches,
      reason: `Add a worktree at ${wtPath} on the existing branch ${chosen}.`,
      warnings: await dependencyWarnings(repo.path, { ref: chosen }) };
  }

  const branch = target.branch ?? `task/${ctx.task}`;
  if (!await gitOk(repo.path, ['check-ref-format', '--branch', branch])) return refuse(`${branch} is not a valid branch name.`);
  const base = target.base ?? options[0]?.ref;
  if (!base) return refuse(`No base ref for a new ${branch} in ${repo.name}: it has no origin/HEAD and no current branch; name one.`, { baseOptions: options });
  if (!await resolves(repo.path, base)) return refuse(`Base ${base} does not resolve to a commit in ${repo.name}.`, { baseOptions: options, branch });
  const why = target.base ? 'chosen by you' : options[0]?.why ?? '';
  return { repo: repo.name, action: 'create', path: wtPath, branch, base, baseOptions: options,
    reason: `Create ${branch} from ${base} (${why}) in a new worktree at ${wtPath}.`,
    warnings: await dependencyWarnings(repo.path, { ref: base }) };
}

// ---------------------------------------------------------------- ensure

export interface EnsureResult { plan: WorktreePlan; record: WorktreeRecord; note?: string }

/** Fetch only what the base names on origin, never prompting; a failure is reported, not fatal. */
async function fetchBase(repoPath: string, base: string): Promise<string | undefined> {
  if (!base.startsWith('origin/')) return undefined;
  try {
    await git(repoPath, ['fetch', '--quiet', '--no-tags', 'origin', base.slice('origin/'.length)], FETCH_TIMEOUT_MS);
    return `fetched ${base} before branching`;
  } catch (err) {
    return `could not fetch ${base} (${(err as Error).message}); branched from the local copy`;
  }
}

/**
 * Makes the worktree a Run needs, from a fresh plan: reuse, adopt (opt-in only), add on
 * the existing branch, or create the branch (no upstream: never tracks the base).
 * Throws, with the plan's reason, when it cannot.
 */
export async function ensureWorktree(ctx: WorktreeContext, target: WorktreeTarget, now = () => new Date(), fetch = true): Promise<EnsureResult> {
  const plan = await planWorktree(ctx, target);
  const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
  if (plan.action === 'refuse') throw fail(`${plan.repo}: ${plan.reason}`);
  const repoPath = path.join(ctx.workspaceRoot, plan.repo);
  const base: Omit<WorktreeRecord, 'origin' | 'branchCreated'> = {
    task: ctx.task, repo: plan.repo, repoPath, path: plan.path!, branch: plan.branch!, ...(plan.base ? { base: plan.base } : {}), at: now().toISOString(),
  };
  if (plan.action === 'reuse') return { plan, record: ctx.registry.find(ctx.task, plan.repo)! };
  if (plan.action === 'adopt') {
    if (plan.needsOptIn) throw fail(`${plan.repo}: ${plan.reason} Opt in to use the existing worktree.`);
    const record: WorktreeRecord = { ...base, origin: 'adopted', branchCreated: false };
    ctx.registry.put(record);
    return { plan, record };
  }
  fs.mkdirSync(ctx.worktreesRoot, { recursive: true });
  let note: string | undefined;
  if (plan.action === 'add') {
    await git(repoPath, ['worktree', 'add', '--quiet', plan.path!, plan.branch!]);
  } else {
    if (fetch) note = await fetchBase(repoPath, plan.base!);
    await git(repoPath, ['worktree', 'add', '--quiet', '--no-track', '-b', plan.branch!, plan.path!, plan.base!]);
  }
  const record: WorktreeRecord = { ...base, origin: 'created', branchCreated: plan.action === 'create' };
  ctx.registry.put(record);
  // The plan read the base before the fetch: say what the new worktree actually holds.
  const warnings = await dependencyWarnings(repoPath, { dir: record.path });
  return { plan: { ...plan, warnings }, record, ...(note ? { note } : {}) };
}

/**
 * The worktrees for every confirmed repository, all or nothing: every plan is checked
 * first, so a refused repository (or one still waiting for the opt-in) leaves no
 * worktree behind for the others. Then each is made in order (the primary first).
 */
export async function ensureWorktrees(ctx: WorktreeContext, targets: WorktreeTarget[], now = () => new Date(), fetch = true): Promise<EnsureResult[]> {
  const plans = await Promise.all(targets.map((t) => planWorktree(ctx, t)));
  const blocked = plans.flatMap((p) => (p.action === 'refuse' ? [`${p.repo}: ${p.reason}`]
    : p.action === 'adopt' && p.needsOptIn ? [`${p.repo}: ${p.reason} Opt in to use the existing worktree.`] : []));
  if (blocked.length) throw Object.assign(new Error(blocked.join(' ')), { status: 409 });
  const results: EnsureResult[] = [];
  for (const target of targets) results.push(await ensureWorktree(ctx, target, now, fetch));
  return results;
}

// ---------------------------------------------------------------- cleanup (D14)

export interface CleanupDeps {
  /** status.yaml phase of the task, undefined when unreadable. */
  taskPhase: (task: string) => Promise<string | undefined>;
  /** A step is running on the task now. */
  running: (task: string) => boolean;
}

const CLOSED_PHASES = ['done', 'aborted'];

/** Why one registry entry the dashboard created is or is not removable now. */
export async function cleanupView(record: WorktreeRecord, deps: CleanupDeps): Promise<WorktreeCleanup> {
  let wts: GitWorktree[] = [];
  try { wts = await listWorktrees(record.repoPath); } catch { /* repository gone */ }
  const exists = wts.some((w) => !w.main && samePath(w.path, record.path));
  if (!exists) {
    return { ...record, exists, action: 'forget', removable: true, canDeleteBranch: false,
      checks: [{ ok: true, text: `The worktree is no longer at ${record.path} (removed outside the dashboard): Remove only forgets the record.` }] };
  }
  const checks: WorktreeCleanup['checks'] = [];
  const phase = await deps.taskPhase(record.task);
  checks.push(phase && CLOSED_PHASES.includes(phase)
    ? { ok: true, text: `${record.task} is ${phase}` }
    : { ok: false, text: `${record.task} is ${phase ?? 'unreadable (no status.yaml phase)'}: not done or aborted` });
  const running = deps.running(record.task);
  checks.push({ ok: !running, text: running ? 'a step is running on the task' : 'no step running on the task' });
  const merged = record.base ? await gitOk(record.repoPath, ['merge-base', '--is-ancestor', `refs/heads/${record.branch}`, record.base]) : false;
  const remote = `origin/${record.branch}`;
  const pushed = !merged && await resolves(record.repoPath, remote) && await gitOk(record.repoPath, ['merge-base', '--is-ancestor', `refs/heads/${record.branch}`, remote]);
  checks.push(merged ? { ok: true, text: `${record.branch} is merged into ${record.base}` }
    : pushed ? { ok: true, text: `${record.branch} is pushed to ${remote}` }
      : { ok: false, text: `${record.branch} is neither merged into ${record.base ?? 'its base (none recorded)'} nor pushed to ${remote} (as of the last fetch)` });
  const dirty = (await git(record.path, ['status', '--porcelain', '--untracked-files=all']).catch(() => '?? (git status failed)\n')).split('\n').filter(Boolean);
  checks.push(dirty.length ? { ok: false, text: `${dirty.length} uncommitted or untracked file${dirty.length === 1 ? '' : 's'} in the worktree` }
    : { ok: true, text: 'no uncommitted or untracked files' });
  const removable = checks.every((c) => c.ok);
  return { ...record, exists, ...(removable ? { action: 'remove' as const } : {}), removable, checks, canDeleteBranch: record.branchCreated && merged };
}

export interface RemoveResult { removed: boolean; forgot: boolean; branchDeleted: boolean; view: WorktreeCleanup }

/**
 * Removes one worktree the dashboard created, re-checked now: `git worktree remove`
 * without --force (git itself refuses a dirty worktree), and the branch only when asked,
 * created by the dashboard and merged into its base.
 */
export async function removeWorktree(registry: WorktreeRegistry, task: string, repo: string, deps: CleanupDeps, deleteBranch = false): Promise<RemoveResult> {
  const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
  const record = registry.find(task, repo);
  if (!record) throw fail(`No worktree of ${repo} for ${task} in the dashboard's registry.`, 404);
  if (record.origin !== 'created') throw fail(`${record.path} was adopted, not created by the dashboard: it is never removed from here.`);
  const view = await cleanupView(record, deps);
  if (!view.removable) throw fail(`Not removable: ${view.checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}.`);
  if (deleteBranch && !view.canDeleteBranch) throw fail(`${record.branch} cannot be deleted from here: only a branch the dashboard created and that is merged into its base.`);
  if (view.action === 'forget') {
    registry.remove(task, repo);
    return { removed: false, forgot: true, branchDeleted: false, view };
  }
  await git(record.repoPath, ['worktree', 'remove', record.path]);
  registry.remove(task, repo);
  let branchDeleted = false;
  if (deleteBranch) {
    // Re-checked against the base right before deleting. `branch -d` would judge
    // "merged" against the main checkout's HEAD, which may be another branch, so the
    // dashboard checks against the recorded base itself and then deletes.
    if (record.base && await gitOk(record.repoPath, ['merge-base', '--is-ancestor', `refs/heads/${record.branch}`, record.base])) {
      await git(record.repoPath, ['branch', '-D', record.branch]);
      branchDeleted = true;
    }
  }
  return { removed: true, forgot: false, branchDeleted, view };
}
