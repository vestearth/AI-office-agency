import type { RunStatus } from './types';

// The one definition of run counts, shared by the server (Insights) and the
// client (Command) so the same word never means two numbers on two screens.

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'waiting_review', 'blocked', 'queued', 'failed']);

export interface RunCounts {
  total: number;
  /** Open work: running + waiting_review + blocked + queued + failed. */
  active: number;
  running: number;
  waitingReview: number;
  blocked: number;
  queued: number;
  failed: number;
  completed: number;
  cancelled: number;
  /** status.yaml could not be read (status 'unknown'): neither open nor done. */
  unreadable: number;
  /** completed / (completed + failed + cancelled); 0 when nothing has finished. */
  successRate: number;
}

export function isActiveStatus(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function countRuns(runs: ReadonlyArray<{ status: RunStatus }>): RunCounts {
  const by = (status: RunStatus) => runs.filter((run) => run.status === status).length;
  const completed = by('completed');
  const failed = by('failed');
  const cancelled = by('cancelled');
  const finished = completed + failed + cancelled;
  return {
    total: runs.length,
    active: runs.filter((run) => isActiveStatus(run.status)).length,
    running: by('running'),
    waitingReview: by('waiting_review'),
    blocked: by('blocked'),
    queued: by('queued'),
    failed,
    completed,
    cancelled,
    unreadable: by('unknown'),
    successRate: finished ? completed / finished : 0,
  };
}
