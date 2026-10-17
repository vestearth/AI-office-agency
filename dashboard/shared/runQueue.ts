import type { RunQueueItem, RunTrigger } from "./types";

// The Run queue's triggers (docs/start-task-redesign-spec.md, D13), shared by the server
// (which validates and fires them) and the Start dialog (which builds and shows them).

/** A time trigger may lie at most this far in the past when it is queued (clock skew, a slow click). */
export const AT_PAST_SLACK_MS = 60_000;
/** A time trigger at most this far ahead: a queue that only advances while the dashboard runs is not a calendar. */
export const AT_MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;
/**
 * A time trigger first seen due more than this late was missed (the dashboard was not
 * running at that time): it fails instead of starting hours later, unattended.
 */
export const AT_MISSED_GRACE_MS = 60 * 60_000;

const TASK_ID = /^TASK-[A-Za-z0-9-]{1,80}$/;

/** The trigger in a request body ({trigger: {...}}; absent: now), or why it is not usable. */
export function parseTrigger(raw: unknown, now: Date): RunTrigger | { error: string } {
  if (raw === undefined || raw === null) return { kind: "now" };
  const t = raw as Record<string, unknown>;
  switch (t.kind) {
    case "now":
      return { kind: "now" };
    case "at": {
      const at = typeof t.at === "string" ? Date.parse(t.at) : NaN;
      if (Number.isNaN(at)) return { error: "A time trigger needs a valid time (ISO 8601)." };
      if (at < now.getTime() - AT_PAST_SLACK_MS) return { error: "That time has passed: pick a later one, or start now." };
      if (at > now.getTime() + AT_MAX_AHEAD_MS) return { error: "Pick a time within the next 7 days." };
      return { kind: "at", at: new Date(at).toISOString() };
    }
    case "after": {
      if (t.scope === "chain") return { error: "After a chain ends arrives with chains; pick after a task's step." };
      if (t.scope !== undefined && t.scope !== "step") return { error: "scope must be step." };
      if (typeof t.taskId !== "string" || !TASK_ID.test(t.taskId)) return { error: "An after trigger needs a task id (TASK-…)." };
      return { kind: "after", taskId: t.taskId, scope: "step" };
    }
    default:
      return { error: "trigger.kind must be now, at or after." };
  }
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** "now", "at 10-17 14:00", "after TASK-EAR-1's step ends". */
export function triggerLabel(trigger: RunTrigger): string {
  switch (trigger.kind) {
    case "now": return "now";
    case "at": return `at ${hhmm(trigger.at)}`;
    case "after": return `after ${trigger.taskId}'s step ends`;
    default: return "unknown trigger";
  }
}

/** One line for a queue item: "TASK-EAR-1 dev · claude · after TASK-EAR-2's step ends · waiting for TASK-EAR-2's step (running)". */
export function queueItemLine(item: RunQueueItem): string {
  const what = item.step ? `${item.label} · ${item.step.cli}` : item.label;
  const state = item.state === "waiting" || item.state === "starting"
    ? (item.state === "starting" ? "starting" : `waiting for ${item.waitingFor ?? "its trigger"}`)
    : item.state === "started" ? `started${item.fired ? ` (${item.fired})` : ""}`
      : `${item.state}${item.reason ? `: ${item.reason}` : ""}`;
  return `${what} · ${triggerLabel(item.trigger)} · ${state}`;
}
