import type { RunStatus } from './types';

// The one display vocabulary for run status, shared by every view. RunStatus
// stays the wire enum (projected from status.yaml `phase`); this only names it
// for people. "running" reads "In progress", except that a run still in the
// `assigned` phase reads "Assigned": nobody has started it (2026-10-15, an
// opened-only release train looked busy).
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

/** People-facing names for status.yaml phases (Flow "Where it waits"); unknown phases are humanized. */
const PHASE_LABEL: Record<string, string> = {
  pending: 'Queued', assigned: 'Assigned', assigned_parallel: 'Assigned (parallel)', review: 'In review', in_review: 'In review',
  debugging: 'Debugging', debugging_complete: 'Debugging done', devops_needed: 'DevOps needed', devops_complete: 'DevOps done',
  escalated: 'Escalated', free_roam_complete: 'Escalation done', blocked: 'Blocked', validation_failed: 'Validation failed',
  done: 'Done', aborted: 'Aborted',
};

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return 'Unknown';
  return PHASE_LABEL[phase] ?? phase.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const ASSIGNED_PHASES: ReadonlySet<string> = new Set(['assigned', 'assigned_parallel']);

/** True when the run is "running" only because it was assigned and not started. */
export function isAssignedOnly(status: RunStatus | string | undefined, phase: string | null | undefined): boolean {
  return status === 'running' && !!phase && ASSIGNED_PHASES.has(phase);
}

/** The label people read for a run: statusLabel, with "Assigned" for an unstarted assignment. */
export function runStatusLabel(status: RunStatus | string | undefined, phase?: string | null): string {
  return isAssignedOnly(status, phase) ? 'Assigned' : statusLabel(status);
}

/** Badge classes: `status-<status>`, plus `status-assigned` for an unstarted assignment. */
export function runStatusClass(status: RunStatus | string | undefined, phase?: string | null): string {
  return `status-${status ?? 'unknown'}${isAssignedOnly(status, phase) ? ' status-assigned' : ''}`;
}
