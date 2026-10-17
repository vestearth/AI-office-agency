import { handoffWarning, OPEN_TARGET_LABELS } from '../../../shared/openHandoff';
import type { OfficeLaunchTools, OpenHandoff, OpenTarget, TaskLaunchResponse, TaskOpenResponse } from '../../../shared/types';
import { ROLE_NAMES } from './agentDisplay';
import { formatStamp } from './monitorList';
import { isActive, recentStatusWarning, warningLaunch } from './officeLaunch';

// Start or open task (docs/start-task-redesign-spec.md, D1/D8/D15): Run hands the step
// to a sandboxed CLI the dashboard verifies; Open hands it to an app the operator drives.

export type StartAction = 'run' | 'open';

export const OPEN_TARGETS: OpenTarget[] = ['claude-desktop', 'claude-cli', 'codex-app', 'cursor'];

export const OPEN_TARGET_HELP: Record<OpenTarget, string> = {
  'claude-desktop': 'Opens a new session in Claude\'s Code tab on the worktree with the prompt filled in. Claude asks you to confirm the folder; nothing is sent until you press Send.',
  'claude-cli': 'Opens Claude Code in your last-used terminal, in the worktree, with the prompt filled in; nothing is sent until you press Enter. The first time, macOS asks to let "claude" control Terminal.app (Automation): allow it, or nothing opens.',
  'codex-app': 'Opens a new thread in the Codex app on the worktree with the prompt filled in; nothing is sent until you send it. The first time, the Codex app asks its own permission; the app may not come to the front, so look for it.',
  cursor: 'Cursor\'s link cannot set a folder: Prepare makes or reuses the worktree, then open that folder in Cursor yourself and paste the prompt (Copy prompt).',
};

/** The role a step defaults to: the recorded next action or current agent, else dev; a done task offers reviewer. */
export function defaultRole(targetRole: string | undefined, currentAgent?: string): string {
  const role = targetRole ?? currentAgent;
  if (role === 'done') return 'reviewer';
  return role && (ROLE_NAMES as readonly string[]).includes(role) ? role : 'dev';
}

/**
 * Warnings shown above both actions: status.yaml changed recently with nothing running
 * from here, and an Open hand-off recorded after the last Run (D8: neither kind of
 * interactive session holds a lease).
 */
export function taskWarnings(data: TaskLaunchResponse | null, now = Date.now()): string[] {
  const launch = data?.launch ?? null;
  const result = !isActive(launch) ? data?.result : undefined;
  const last = warningLaunch(launch, result);
  return [recentStatusWarning(data?.statusChangedAt, last, now), handoffWarning(data?.lastHandoff, last, now)].filter((w): w is string => Boolean(w));
}

/** Why Open is disabled for this target and prompt, beyond the repositories; empty when it may open. */
export function openBlockers(target: OpenTarget, open: OfficeLaunchTools['open'] | undefined, prompt: string): string[] {
  if (target === 'cursor') return [];
  if (open && !open.available) return [`${open.reason ?? 'Open is not available here'}.`];
  const cap = open?.promptCap;
  if (cap && prompt.length > cap) {
    return [`The prompt is ${prompt.length.toLocaleString('en-US')} characters, over the ${cap.toLocaleString('en-US')} an app link takes: shorten the additional instructions, or use Copy prompt and paste it yourself.`];
  }
  return [];
}

/** "3,643 of 5,000 characters" under the prompt for a deep-link target. */
export const promptLengthLine = (prompt: string, cap: number) => `${prompt.length.toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} characters`;

/** The Launch card's line for the newest hand-off. */
export const handoffLine = (h: OpenHandoff) => `Last opened: ${h.role} in ${OPEN_TARGET_LABELS[h.target] ?? h.target} · ${formatStamp(h.at)} · ${h.worktree} (no lease, not verified by the dashboard)`;

/** What the operator does next once the server opened (or, for cursor, prepared) the worktree. */
export function openDoneMessage(res: Pick<TaskOpenResponse, 'handoff' | 'url'>): string {
  const { target, worktree } = res.handoff;
  if (target === 'cursor') return `Worktree ready: ${worktree}. Open that folder in Cursor, then paste the prompt (Copy prompt). Recorded on the task.`;
  return `Open request sent to ${OPEN_TARGET_LABELS[target]} for ${worktree}, with the prompt filled in and not sent. Recorded on the task; `
    + 'the dashboard does not verify or commit this session. If the app did not open, use Copy prompt.';
}
