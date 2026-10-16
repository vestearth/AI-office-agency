import path from 'path';

// Monitor › run detail › Start: the prompt for one role step, built from the
// task's files rather than typed. It names what to read (workspace policy, role
// contract, task artifacts) and ends with the runtime adapter contract
// (docs/runtime-adapter-contract.md, operations 4 and 5), so a step run from any
// CLI leaves the same artifacts as one dispatched by run-agent.sh.

export interface TaskPromptInput {
  taskId: string;
  title: string;
  role: string;
  workspaceRoot: string;
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
  const office = path.join(workspaceRoot, 'ai-dev-office');
  const runDir = path.join(office, 'runs', taskId);
  const output = `runs/${taskId}/${role}-output.yaml`;
  return [
    `You are the \`${role}\` lane of AI Dev Office task ${taskId}: ${input.title}. The operator started this step from the dashboard.`,
    `Workspace root: ${workspaceRoot}. Task artifacts: ${runDir}/.`,
    input.nextAction?.reason ? `Recorded next action${input.nextAction.agent ? ` (${input.nextAction.agent})` : ''}: ${input.nextAction.reason}` : '',
    'Before you start:',
    `1. Read ${workspaceRoot}/AGENTS.md (workspace policy and hard guardrails), your role contract ${office}/agents/${role}.md, and in the task artifacts: task.md, status.yaml (phase, gates, waits_on, history), every earlier *-output.yaml and verification-evidence.md.`,
    '2. Find the target repository from task.md. Check its branch and working tree before you edit anything, and stay inside the task scope and its completion gates.',
    'While you work:',
    `- Run each verification command through \`${office}/scripts/record-evidence.sh ${taskId} --type test|build|command|static_check -- <command...>\` so it is recorded.`,
    '- Never write a real secret into a tracked file. Games-Lab-Android is read-only. Do not scale *-prod ECS above 0 or start RDS without the operator\'s approval.',
    'When you finish, or stop because you are blocked:',
    `3. Write ${office}/${output} to ${office}/schemas/${role}-output.schema.yaml (base: schemas/agent-output.schema.yaml): summary, artifacts, next_action.agent and next_action.reason, blockers. Role fields take role names only: pm dev dev-2 reviewer debugger devops free-roam done.`,
    `4. From ${office}, run in order and fix the output until each passes:`,
    `   ruby validate-yaml.rb ${taskId}`,
    `   ruby scripts/enforce-output-contract.rb ${taskId} ${role}`,
    `   ruby scripts/sync-status-from-output.rb ${taskId} ${role} runs/${taskId}/status.yaml ${output} "$(date +%F)" ${REVIEWER_QUEUE_PHASE}`,
    `5. Do not commit or push anything under ai-dev-office/runs/: the operator publishes the run. Finish with a short report: what changed, the evidence ids, next_action, and anything that needs the operator.`,
    input.note?.trim() ? `Operator note: ${input.note.trim()}` : '',
  ].filter(Boolean).join('\n');
}
