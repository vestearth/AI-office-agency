import path from 'path';
import type { KnowledgeRecheckBrief } from '../../../shared/types';

// Knowledge › Run re-check now: the Weekly Re-check Run (workflows/knowledge-librarian.md)
// started from the dashboard. The steps match the `knowledge-weekly-recheck` scheduled
// task; only step 1 differs: the dashboard has already built the scope, so the brief is
// inlined instead of fetched. Keep the two in step when the contract changes.

/** Null when there is nothing to re-check: the weekly run stops in that case too. */
export function knowledgeRecheckPrompt(brief: KnowledgeRecheckBrief, workspaceRoot: string): string | null {
  if (brief.notes.length === 0 && brief.answers.length === 0) return null;
  const office = path.join(workspaceRoot, 'ai-dev-office');
  return [
    `You are running the AI Dev Office "Weekly Re-check Run" for knowledge findings, started on demand from the dashboard. Workspace root: ${workspaceRoot}. Contract: ${office}/workflows/knowledge-librarian.md, section "Weekly Re-check Run". Decision record: ${office}/docs/knowledge-finding-closure-spec.md.`,
    'Steps:',
    `1. Scope: the brief below, built by the dashboard server at ${brief.generatedAt} with the task audience (${brief.notes.length} notes, ${brief.answers.length} operator answers). Never pick a scope yourself.`,
    `2. Dispatch the \`knowledge-librarian\` subagent with the brief as its scope and these instructions: run under the shared contract in workflows/knowledge-librarian.md; write mode \`approved_scope_auto_write\` under the Games Labs policy (${workspaceRoot}/knowledge-base/knowledge-librarian-policy.yaml, authorization cited in the audit); re-check every listed fingerprint against repository source, tests, CI, logs, config and runtime evidence (the vault is memory, not evidence); apply a finding's existing \`proposed_patch\` only when its evidence is still \`confirmed\` and the note matches a policy write target, recording the change as \`applied\` and the finding as \`resolved\` with answer, closure evidence and \`closed_at\`; for partial, missing or conflicted evidence record \`recurring\` and say why; product or architecture questions stay open unless the brief's "Operator answers to record" section answers them; for every listed operator answer, re-check that fingerprint and follow its per-answer instruction, citing "operator answer <id> by <actor> on <date>" as closure evidence (an answer never authorizes writes outside the policy or actions outside the vault); keep the same fingerprints; limit: the brief's notes only, at most 20 minutes; write the audit to ${office}/knowledge-reviews/<UTC timestamp like 20261020T090000Z>-weekly-recheck.yaml matching schemas/knowledge-librarian-output.schema.json; never commit or push anything.`,
    `3. Validate: run \`ruby ${office}/scripts/validate-knowledge-librarian.rb <audit-path>\` and fix the audit until it passes.`,
    '4. Report in a few lines: notes re-checked, operator answers recorded, findings applied / resolved / recurring / suppressed, the audit file name, anything that needs a human (including every finding left recurring and why). Do not run git commit or git push.',
    '--- Brief ---',
    brief.text,
  ].join('\n\n');
}
