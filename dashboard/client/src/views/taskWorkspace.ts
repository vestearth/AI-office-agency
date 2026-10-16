import type { RepoProposal, WorktreeCleanup, WorktreePlan, WorktreeTarget } from '../../../shared/types';

// Run › repositories (docs/start-task-redesign-spec.md, D3): the repositories the
// operator confirms for a Run, each with the server's plan for its worktree. The first
// one is the primary: the step's working directory.

/** Why Start is disabled, from the confirmed list and the server's plans for it; empty when it may run. */
export function runBlockers(targets: WorktreeTarget[], plans: WorktreePlan[]): string[] {
  if (!targets.length) return ['Confirm at least one target repository: Run and Open work in a task worktree.'];
  if (plans.length !== targets.length || plans.some((p, i) => p.repo !== targets[i].repo)) return ['Checking the worktrees…'];
  return plans.flatMap((p) => {
    if (p.action === 'refuse') return [`${p.repo}: ${p.reason}`];
    if (p.action === 'adopt' && p.needsOptIn) return [`${p.repo}: tick "Use the existing worktree" to run in a worktree the dashboard did not create.`];
    return [];
  });
}

/** The list with `repo` moved to the front (the primary). */
export function makePrimary(targets: WorktreeTarget[], repo: string): WorktreeTarget[] {
  const found = targets.find((t) => t.repo === repo);
  return found ? [found, ...targets.filter((t) => t !== found)] : targets;
}

export const targetsFromPlans = (plans: WorktreePlan[]): WorktreeTarget[] => plans.map((p) => ({ repo: p.repo }));

/** A few words for what a Run does with the repository. */
export function planLabel(plan: WorktreePlan): string {
  switch (plan.action) {
    case 'create': return 'new branch + worktree';
    case 'add': return 'worktree on the existing branch';
    case 'reuse': return `reuse (${plan.origin === 'adopted' ? 'adopted' : 'created by the dashboard'})`;
    case 'adopt': return 'existing worktree, not the dashboard\'s';
    default: return 'cannot run here';
  }
}

/** One line: removable, or what keeps it. */
export function cleanupSummary(view: Pick<WorktreeCleanup, 'removable' | 'action' | 'checks'>): string {
  if (view.removable) return view.action === 'forget' ? 'already gone: forget the record' : 'removable';
  return `kept: ${view.checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}`;
}

/** Repositories task.md names that are not in the confirmed list: shown unticked under "Also mentioned". */
export const alsoMentioned = (proposed: RepoProposal[], targets: WorktreeTarget[]): RepoProposal[] =>
  proposed.filter((p) => !targets.some((t) => t.repo === p.repo));

/** The server's notes from making the worktrees (a fetch that failed, or that ran), one line per repository. */
export function startNotes(body: { worktrees?: { repo: string; note?: string }[] } | null | undefined): string[] {
  return (body?.worktrees ?? []).flatMap((w) => (w.note ? [`${w.repo}: ${w.note}`] : []));
}
