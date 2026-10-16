import type { OpenHandoff, OpenTarget } from "./types";

// Start or open task › Open (docs/start-task-redesign-spec.md, D8/D15), shared by the
// server (which opens and records) and the dialog (which warns a later Run).

/** The smallest prompt limit of the three deep links (claude-cli://open); a longer prompt is refused, never cut. */
export const OPEN_PROMPT_CAP = 5000;

export const OPEN_TARGET_LABELS: Record<OpenTarget, string> = {
  "claude-desktop": "Claude desktop",
  "claude-cli": "Claude Code in the terminal",
  "codex-app": "Codex app",
  cursor: "Cursor (prompt only)",
};

/** A recorded hand-off older than this no longer warns a Run. */
export const HANDOFF_WARN_DAYS = 7;

const age = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60_000));
  return mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
};

/**
 * The Run warning (D8): an Open session takes no lease, so a Run on the same task could
 * collide with it. Warns when the newest hand-off came after the task's last step ended
 * (or there was none) and within HANDOFF_WARN_DAYS; never while a step runs (Run is
 * disabled then anyway).
 */
export function handoffWarning(
  handoff: OpenHandoff | undefined,
  lastStep: { status: string; startedAt: string; finishedAt?: string } | null,
  now = Date.now(),
): string | null {
  if (!handoff) return null;
  if (lastStep && ["running", "stopping"].includes(lastStep.status)) return null;
  const at = Date.parse(handoff.at);
  if (Number.isNaN(at) || now - at > HANDOFF_WARN_DAYS * 86_400_000) return null;
  if (lastStep && at <= Date.parse(lastStep.finishedAt ?? lastStep.startedAt)) return null;
  return `${handoff.role} was opened in ${OPEN_TARGET_LABELS[handoff.target] ?? handoff.target} ${age(now - at)} ago${lastStep ? ', after the last Run' : ''} `
    + `(${handoff.worktree}): that session may still be working here, holds no lease, and nothing it did was verified by the dashboard.`;
}
