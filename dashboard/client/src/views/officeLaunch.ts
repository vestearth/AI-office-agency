import type { OfficeLaunch, TaskStepResult } from '../../../shared/types';
import { formatStamp } from './monitorList';

export const isActive = (launch: OfficeLaunch | null | undefined) => Boolean(launch && ['running', 'stopping'].includes(launch.status));

const minutes = (from: string, to: number) => Math.max(0, Math.round((to - Date.parse(from)) / 60_000));

/** "running · 4 min" (or "running · 4 of 30 min" with a time limit), "failed · exit 9 · 12 min", "lost · process gone without an exit code". */
export function launchSummary(launch: OfficeLaunch, now = Date.now()): string {
  switch (launch.status) {
    case 'running': case 'stopping': return `${launch.status} · ${minutes(launch.startedAt, now)}${launch.timeLimitMinutes ? ` of ${launch.timeLimitMinutes}` : ''} min`;
    case 'lost': return 'lost · the process ended without an exit code (killed or the machine restarted)';
    case 'stopped': return 'stopped';
    default: return `${launch.status} · exit ${launch.exitCode ?? '?'} · ${minutes(launch.startedAt, launch.finishedAt ? Date.parse(launch.finishedAt) : now)} min`;
  }
}

/** "started Oct 16, 09:01 · 17h ago": the card keeps the newest launch, which can be a day old. */
export function launchStarted(launch: OfficeLaunch, now = Date.now()): string {
  const mins = minutes(launch.startedAt, now);
  const ago = mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
  return `started ${formatStamp(launch.startedAt)} · ${ago}`;
}

/** A status.yaml change this recent, with nothing running from here, hints at another session on the task. */
export const RECENT_STATUS_MINUTES = 30;

export function recentStatusWarning(statusChangedAt: string | undefined, launch: OfficeLaunch | null, now = Date.now()): string | null {
  if (!statusChangedAt || isActive(launch)) return null;
  const age = minutes(statusChangedAt, now);
  if (age > RECENT_STATUS_MINUTES) return null;
  if (launch?.finishedAt && Date.parse(launch.finishedAt) >= Date.parse(statusChangedAt)) return null;
  return `status.yaml changed ${age} min ago and nothing is running from here: another session may be working on this task.`;
}

/**
 * The launch the status warning compares with: the dashboard's own verification (its sync
 * writes status.yaml) ends after the launch, so its end counts as the launch's end.
 */
export function warningLaunch(launch: OfficeLaunch | null, result: Pick<TaskStepResult, 'finishedAt'> | undefined): OfficeLaunch | null {
  if (!launch || !result?.finishedAt || (launch.finishedAt && launch.finishedAt >= result.finishedAt)) return launch;
  return { ...launch, finishedAt: result.finishedAt };
}

/** ok: passed; false: failed; null: skipped (not run, with the reason). */
export interface ResultLine { ok: boolean | null; text: string; output?: string }

/** The Launch card's end state (D7), in order: protocol, each office script, agent-commit detection, the dashboard commit; then the lease and runs/ changes. */
export function stepResultSections(result: TaskStepResult): { title: string; lines: ResultLine[] }[] {
  const changed = result.runsChanged.map((c) => `${c.path} (${c.change})`);
  return [
    { title: 'Protocol', lines: [{ ok: result.protocol.ok, text: result.protocol.text }] },
    { title: 'Office scripts', lines: result.checks.map((c) => ({
      ok: c.status === 'passed' ? true : c.status === 'failed' ? false : null,
      text: `${c.name}: ${c.detail}${c.status === 'failed' && c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`,
      ...(c.output ? { output: c.output } : {}),
    })) },
    { title: 'Agent commits', lines: [{ ok: result.agentCommits.ok, text: result.agentCommits.text }, ...result.agentCommits.found.map((f) => ({ ok: false, text: `${f.repo}: ${f.text}` }))] },
    { title: 'Dashboard commit', lines: result.commits.length
      ? result.commits.map((c) => ({ ok: c.status === 'committed' ? true : c.status === 'failed' ? false : null, text: `${c.repo}: ${c.text}` }))
      : [{ ok: null, text: 'no worktree' }] },
    { title: 'Task lease', lines: [{ ok: result.lease.ok, text: result.lease.text }] },
    { title: 'Changed in runs/ (not committed)', lines: [{ ok: null, text: changed.length ? changed.join(', ') : 'nothing' }] },
  ];
}

/** One line for the card's heading. */
export function stepVerdict(result: TaskStepResult): string {
  if (result.state === 'verifying') return 'Verifying with the office scripts…';
  if (!result.protocol.ok) return `Step ${result.protocol.text} · not verified, no commit`;
  if (!result.lease.ok && !result.verified) return 'Task lease lost · not verified, no commit';
  const failed = result.checks.find((c) => c.status === 'failed');
  if (failed) return `Not verified: ${failed.name} failed · no commit`;
  if (!result.agentCommits.ok) return 'Failed: an agent committed · no dashboard commit';
  const committed = result.commits.filter((c) => c.status === 'committed');
  if (result.commits.some((c) => c.status === 'failed')) return 'Verified · commit failed';
  return committed.length ? `Verified · committed ${committed.map((c) => (c.sha ?? '').slice(0, 10)).join(', ')}` : 'Verified · nothing to commit';
}

/**
 * What the output box shows: an adapter launch's readable progress (its raw streamed
 * JSON stays on disk and in the collapsed raw view), else the raw log as before.
 */
export function launchOutput(launch: OfficeLaunch): { label: string; text: string } {
  if (launch.progress) {
    return { label: 'Progress', text: launch.progress.join('\n') || (isActive(launch) ? 'Waiting for output…' : 'The CLI reported no progress.') };
  }
  return { label: `Output${launch.truncated ? ' (last 64 KB)' : ''}`, text: launch.log || 'Waiting for output…' };
}
