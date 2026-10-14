import type { RunStatus } from './types';

// The one display vocabulary for run status, shared by every view. RunStatus
// stays the wire enum (projected from status.yaml `phase`); this only names it
// for people. "running" reads "In progress": an assigned task is not
// necessarily executing anything (an idle assigned task looked busy).
export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'In progress',
  waiting_review: 'In review',
  blocked: 'Blocked',
  failed: 'Validation failed',
  completed: 'Done',
  cancelled: 'Aborted',
  unknown: 'Unreadable',
};

export function statusLabel(status: RunStatus | string | undefined): string {
  return (status && (STATUS_LABEL as Record<string, string>)[status]) || 'Unreadable';
}
