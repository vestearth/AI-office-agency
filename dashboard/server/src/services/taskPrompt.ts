import path from 'path';

// Monitor › run detail › Start: the prompt for one role step, built from the
// task's files rather than typed. It names what to read (workspace policy, role
// contract, task artifacts) and the agent's half of the runtime adapter contract
// (docs/runtime-adapter-contract.md, operation 4): write <role>-output.yaml and
// nothing else in the task artifacts. Operation 5 (validate, enforce, sync) is the
// dashboard's, after the step (stepGovernance.ts), as are the commit and the evidence
// for it: the agent records the checks it ran as claims in its output. A Run names
// the task's worktrees (the primary one is the step's working directory) and the
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
  /** run (default): the dashboard verifies and commits after the step. open: a session the operator drives (D15), which the dashboard does not verify. */
  mode?: 'run' | 'open';
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

export function taskPrompt(input: TaskPromptInput): string {
  const { taskId, role, workspaceRoot } = input;
  const office = input.officeRoot ?? path.join(workspaceRoot, 'ai-dev-office');
  const runDir = path.join(office, 'runs', taskId);
  const output = `runs/${taskId}/${role}-output.yaml`;
  const [primary, ...others] = input.worktrees ?? [];
  const reference = input.referenceOnly ?? [];
  const open = input.mode === 'open';
  return [
    `You are the \`${role}\` lane of AI Dev Office task ${taskId}: ${input.title}. ${open ? 'The operator opened this step from the dashboard in a session they drive.' : 'The operator started this step from the dashboard.'}`,
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
    `- Run the checks your role needs (tests, builds, static checks)${primary ? ' from the worktree they check' : ''}, and list each in your output's claims (claim, command, result).`,
    open
      ? '- Do not edit status.yaml or any other file in the task artifacts by hand: only the office scripts write status.yaml.'
      : '- Do not run the office scripts (record-evidence.sh, validate-yaml.rb, enforce-output-contract.rb, sync-status-from-output.rb) and do not edit status.yaml or any other file in the task artifacts: the dashboard runs those scripts after the step, and only they write status.yaml.',
    '- Never write a real secret into a tracked file. Games-Lab-Android is read-only. Do not scale *-prod ECS above 0 or start RDS without the operator\'s approval.',
    'When you finish, or stop because you are blocked:',
    `3. Write ${office}/${output}, the only file you write in the task artifacts, to ${office}/schemas/${role}-output.schema.yaml (base: schemas/agent-output.schema.yaml): summary (its first line becomes the commit subject), artifacts, next_action.agent and next_action.reason, blockers, and claims for the checks you ran. Role fields take role names only: pm dev dev-2 reviewer debugger devops free-roam done. Cite evidence_refs only for ids already in runs/${taskId}/evidence.yaml: this step's checks have no evidence ids.`
      + (primary ? ' The file is outside your working directory: use your file-edit tool, and only if that tool refuses the path, write it with your shell (cat > the file <<\'EOF\' … EOF) and read it back.' : ''),
    open
      ? `4. Then run ruby validate-yaml.rb ${taskId} from ${office} and fix what it reports. The dashboard does not verify or commit a session it opened: tell the operator, who runs scripts/enforce-output-contract.rb ${taskId} ${role} and scripts/sync-status-from-output.rb ${taskId} ${role} (status.yaml moves only through it) and decides on the commit.`
      : `4. Then stop. The dashboard verifies your output with ruby validate-yaml.rb ${taskId}, then ruby scripts/enforce-output-contract.rb ${taskId} ${role}, then ruby scripts/sync-status-from-output.rb ${taskId} ${role} (status.yaml moves only through it); only when all pass, the dashboard commits each worktree's diff on its task branch and records that commit as evidence.`,
    open
      ? '5. Do not commit, push, merge or deploy unless the operator asks you to in this session: leave your changes uncommitted.'
      : '5. Never commit, push, merge or deploy, in a worktree or anywhere else: leave your changes uncommitted; a commit of yours fails the step.',
    '   Do not commit or push anything under ai-dev-office/runs/ either: the operator publishes the run. Finish with a short report: what changed, the checks you ran, next_action, and anything that needs the operator.',
    input.note?.trim() ? `Operator note: ${input.note.trim()}` : '',
  ].filter(Boolean).join('\n');
}

export interface NewTaskPmPromptInput {
  taskId: string;
  title: string;
  workspaceRoot: string;
  officeRoot: string;
  /** The operator's request from New task. */
  request: string;
  /** How the task's completion gates were decided when it was opened. */
  gates: string;
  /** Redo: what the operator wants changed in task.md. */
  note?: string;
}

/**
 * New task (D11): the pm step of a task the dashboard just opened with open-task.rb. It
 * runs in runs/<TASK> only (no worktree: it changes no code) and writes task.md in the
 * shape the Run's repository proposal reads (worktrees.proposeRepos: `Repo: <name>` lines
 * are preselected), plus pm-output.yaml; the dashboard verifies it like any step and then
 * stops for the operator to read task.md before any chain.
 */
export function newTaskPmPrompt(input: NewTaskPmPromptInput): string {
  const { taskId, workspaceRoot } = input;
  const office = input.officeRoot;
  const runDir = path.join(office, 'runs', taskId);
  return [
    `You are the \`pm\` lane of AI Dev Office task ${taskId}: ${input.title}. The operator opened this task from the dashboard's New task with the request at the end of this prompt; your step plans the task, it changes no code.`,
    `Workspace root: ${workspaceRoot}. Your working directory is the task artifacts directory ${runDir}/: the only place you write.`,
    `The task was opened with scripts/open-task.rb: status.yaml exists (phase pending, pm assigned) and its completion gates were decided then: ${input.gates}.`,
    'Before you start:',
    `1. Read ${workspaceRoot}/AGENTS.md (workspace policy and hard guardrails), your role contract ${office}/agents/pm.md, and in the task artifacts: task.md (a placeholder holding the request) and status.yaml.`,
    `2. Find what the request touches: read the repositories under ${workspaceRoot} (read only: never change, build in, check out or create anything outside ${runDir}/). Verify scope against the files on disk.`,
    'While you work:',
    '- Do not run the office scripts (record-evidence.sh, validate-yaml.rb, enforce-output-contract.rb, sync-status-from-output.rb) and do not edit status.yaml, meta.yaml or any task artifact other than task.md and pm-output.yaml: the dashboard runs those scripts after the step, and only they write status.yaml.',
    '- Never write a real secret into a file. Games-Lab-Android is read-only: never a write target. Do not scale *-prod ECS above 0 or start RDS.',
    'When you finish, or stop because the request is too vague to plan:',
    `3. Rewrite ${runDir}/task.md: the first line \`# ${taskId}: <title>\` (keep or sharpen the title), then these sections:`,
    '   ## Problem: what is wrong or missing, and why it matters.',
    '   ## Scope: what is in, and what is explicitly out.',
    '   ## Acceptance criteria: a list of specific, testable criteria.',
    '   ## Target repositories: one line per repository the work changes, exactly `Repo: <name>` with the directory name under the workspace root (add `Base branch: <branch>` on that line only when the work must start from a branch other than the repository\'s default). List repositories read only for reference on a separate line starting `Reference only:`, never on a Repo: line. No repository (office-only work): say so.',
    '   ## Plan, then ## Risks and open questions.',
    `4. Write ${runDir}/pm-output.yaml to ${office}/schemas/pm-output.schema.yaml (agents/pm.md, Output Contract): task (id ${taskId}), scope.target_services naming the same repositories, description, acceptance_criteria, plan, assignment, summary (its first line is the step's headline), artifacts (task.md), next_action (dev or dev-2 when it is ready to implement; free-roam with the questions in blockers when it is too vague), blockers, context_sources, and claims for anything you checked. Role fields take role names only: pm dev dev-2 reviewer debugger devops free-roam done. Leave completion_gates out unless the request clearly needs a gate the task lacks.`,
    `5. Then stop. The dashboard verifies your output with ruby validate-yaml.rb ${taskId}, ruby scripts/enforce-output-contract.rb ${taskId} pm and ruby scripts/sync-status-from-output.rb ${taskId} pm; then the operator reads task.md and confirms before any further step. Never commit, push, merge or deploy, and do not commit anything under ai-dev-office/runs/. Finish with a short report: the task as planned, the target repositories, and any question for the operator.`,
    'Operator request:',
    input.request.trim(),
    input.note?.trim() ? `Operator note on the earlier task.md (redo): ${input.note.trim()}` : '',
  ].filter(Boolean).join('\n');
}
