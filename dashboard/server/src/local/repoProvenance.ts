import { execFileSync } from 'child_process';

// Decision #5: repo scope is a closed, operator-configured set. Nothing in
// this module (or callers) may extend it at runtime from tester-supplied
// text — see classifyScope below.
export interface RepoRef {
  name: string;
  path: string;
}

export interface Provenance {
  repo: string;
  branch: string;
  sha: string;
  dirty: boolean;
  capturedAt: number;
  machine: string;
}

export type RunGit = (args: string[]) => string;

const defaultRunGit = (repoPath: string): RunGit => (args) =>
  execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });

// Decision #9: read-only provenance capture. Only `rev-parse` and
// `status --porcelain` are ever invoked — never `pull`/`fetch`/`reset`/
// `checkout`, so this can never mutate the repo it inspects.
export function captureProvenance(
  repoPath: string,
  runGit?: RunGit,
  now: () => number = () => Date.now(),
  machine = ''
): Provenance {
  const git = runGit ?? defaultRunGit(repoPath);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const sha = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim().length > 0;
  return { repo: repoPath, branch, sha, dirty, capturedAt: now(), machine };
}

// Decision #5: returns ONLY the configured allowlist. This is a closed set —
// nothing in the codebase may extend it at runtime from tester-supplied text.
export function resolveAllowedRepos(allowlist: RepoRef[]): RepoRef[] {
  return allowlist;
}

// Maps an intake's product_hint to allowlisted repos. Empty hint, zero
// matches, or more than one match (ambiguous) all stop at
// needs_scope_review with an EMPTY repo set — never a partial/best-guess
// list. Only an unambiguous single match returns a non-empty repos array.
// This "stop and ask a human" behavior is the whole security point of
// Decision #5: scope is never broadened automatically.
export function classifyScope(
  intake: { product_hint: string | null },
  allowlist: RepoRef[]
): { repos: string[]; needsScopeReview: boolean } {
  const hint = (intake.product_hint ?? '').trim().toLowerCase();
  if (!hint) return { repos: [], needsScopeReview: true };
  const matches = allowlist.filter((r) => r.name.toLowerCase().includes(hint));
  if (matches.length === 1) return { repos: [matches[0].name], needsScopeReview: false };
  return { repos: [], needsScopeReview: true };
}
