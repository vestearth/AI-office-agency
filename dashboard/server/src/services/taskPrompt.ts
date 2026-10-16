import path from 'path';

// Monitor › run detail › Start: the prompt for one role step, built from the
// task's files rather than typed. It names what to read (workspace policy, role
// contract, task artifacts) and ends with the runtime adapter contract
// (docs/runtime-adapter-contract.md, operations 4 and 5), so a step run from any
// CLI leaves the same artifacts as one dispatched by run-agent.sh. A Run names the
// task's worktrees (the primary one is the step's working directory) and the
// absolute runs dir in the office checkout the dashboard runs in.

export interface PromptWorktree { repo: string; path: string; branch: string }

export interface TaskPromptInput {
  taskId: string;
  title: string;
  role: string;
  workspaceRoot: string;
  /** The office checkout the dashboard runs in (its runs/<TASK> is the step's); default <workspaceRoot>/ai-dev-office. */
  officeRoot?: string;
  /** The task's worktrees, the primary (the step's working directory) first. */
  worktrees?: PromptWorktree[];
  /** Repositories task.md names that are read-only (reference only). */
  referenceOnly?: string[];
  /** status.yaml next_action, when recorded. */
  nextAction?: { agent?: string; reason?: string };
  note?: string;
}

/** status.yaml next_action, which lanes record as {agent, reason} or as plain text. */
export function recordedNextAction(status: unknown): TaskPromptInput['nextAction'] {
  const next = (status as { next_action?: unknown } | null)?.next_action;
  if (typeof next === 'string' && next.trim()) return { reason: next.trim() };
  if (next && typeof next === 'object') {
    const { agent, reason } = next as { agent?: unknown; reason?: unknown };
    if (typeof reason === 'string' && reason.trim()) return { agent: typeof agent === 'string' ? agent : undefined, reason: reason.trim() };
  }
  return undefined;
}

/** state_model.reviewer_queue_phase in office.config.yaml. */
export const REVIEWER_QUEUE_PHASE = 'in_review';

export function taskPrompt(input: TaskPromptInput): string {
  const { taskId, role, workspaceRoot } = input;
  const office = input.officeRoot ?? path.join(workspaceRoot, 'ai-dev-office');
  const runDir = path.join(office, 'runs', taskId);
  const output = `runs/${taskId}/${role}-output.yaml`;
  const [primary, ...others] = input.worktrees ?? [];
  const reference = input.referenceOnly ?? [];
  return [
    `You are the \`${role}\` lane of AI Dev Office task ${taskId}: ${input.title}. The operator started this step from the dashboard.`,
    `Workspace root: ${workspaceRoot}. Task artifacts: ${runDir}/ (writable${primary ? '; outside your working directory' : ''}).`,
    primary ? `Your working directory is the task worktree of ${primary.repo}, the primary repository: ${primary.path} (branch ${primary.branch}).` : '',
    others.length ? `Other task worktrees, also writable: ${others.map((w) => `${w.repo}: ${w.path} (branch ${w.branch})`).join('; ')}.` : '',
    primary ? 'Change code only in these worktrees: the main checkouts under the workspace root are not yours to change.' : '',
    reference.length ? `${reference.join(', ')} ${reference.length === 1 ? 'is' : 'are'} reference only: read, never change.` : '',
    input.nextAction?.reason ? `Recorded next action${input.nextAction.agent ? ` (${input.nextAction.agent})` : ''}: ${input.nextAction.reason}` : '',
    'Before you start:',
    `1. Read ${workspaceRoot}/AGENTS.md (workspace policy and hard guardrails), your role contract ${office}/agents/${role}.md, and in the task artifacts: task.md, status.yaml (phase, gates, waits_on, history), every earlier *-output.yaml and verification-evidence.md.`,
    primary
      ? '2. Check each worktree\'s branch and working tree before you edit anything, and stay inside the task scope and its completion gates.'
      : '2. Find the target repository from task.md. Check its branch and working tree before you edit anything, and stay inside the task scope and its completion gates.',
    'While you work:',
    `- Run each verification command through \`${office}/scripts/record-evidence.sh ${taskId} --type test|build|command|static_check -- <command...>\` so it is recorded`
      // It records the repository it runs in; and from a directory the sandbox cannot
      // write (the office root), its here-document failed under codex (2026-10-17).
      + (primary ? ', from the worktree the command checks (the evidence records the repository it runs in).' : '.'),
    '- Never write a real secret into a tracked file. Games-Lab-Android is read-only. Do not scale *-prod ECS above 0 or start RDS without the operator\'s approval.',
    'When you finish, or stop because you are blocked:',
    `3. Write ${office}/${output} to ${office}/schemas/${role}-output.schema.yaml (base: schemas/agent-output.schema.yaml): summary, artifacts, next_action.agent and next_action.reason, blockers. Role fields take role names only: pm dev dev-2 reviewer debugger devops free-roam done.`
      + (primary ? ' The file is outside your working directory: use your file-edit tool, and only if that tool refuses the path, write it with your shell (cat > the file <<\'EOF\' … EOF) and read it back.' : ''),
    `4. From ${office}, run in order and fix the output until each passes:`,
    `   ruby validate-yaml.rb ${taskId}`,
    `   ruby scripts/enforce-output-contract.rb ${taskId} ${role}`,
    `   ruby scripts/sync-status-from-output.rb ${taskId} ${role} runs/${taskId}/status.yaml ${output} "$(date +%F)" ${REVIEWER_QUEUE_PHASE}`,
    '5. Never commit, push, merge or deploy, in a worktree or anywhere else: leave your changes uncommitted; the dashboard commits the worktree diff on the task branch after verification.',
    '   Do not commit or push anything under ai-dev-office/runs/ either: the operator publishes the run. Finish with a short report: what changed, the evidence ids, next_action, and anything that needs the operator.',
    input.note?.trim() ? `Operator note: ${input.note.trim()}` : '',
  ].filter(Boolean).join('\n');
}
