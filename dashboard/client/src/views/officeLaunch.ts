import type { OfficeLaunch, TaskLaunchContract } from '../../../shared/types';
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

/** One line per contract check, failures first. */
export function contractLines(contract: TaskLaunchContract): { ok: boolean; text: string }[] {
  return [
    { ok: contract.outputWritten, text: contract.outputWritten ? `${contract.outputFile} written` : `${contract.outputFile} not written during the run` },
    { ok: contract.statusSynced, text: contract.statusSynced ? 'status.yaml synced' : 'status.yaml not synced (sync-status-from-output.rb did not run)' },
    { ok: contract.validation.ok, text: contract.validation.ok ? 'validate-yaml.rb passes' : 'validate-yaml.rb fails' },
  ].sort((a, b) => Number(a.ok) - Number(b.ok));
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
