import type { IntakeRow } from './intakeStore';

const STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  triaged: 'In review',
  decided: 'In review',
  needs_scope_review: 'In review',
  ai_failed: 'In review',
  promoted: 'Accepted — being worked on',
  closed: 'Closed',
};

export function displayStatusFor(state: string): string {
  return STATUS_LABELS[state] ?? 'In review'; // fail-closed: never leak a raw/unknown state
}

export interface TesterIntake {
  id: string;
  title: string;
  productHint: string | null;
  body: string;
  severity: string | null;
  reproSteps: string | null;
  expected: string | null;
  actual: string | null;
  environment: string | null;
  createdAt: number;
  displayStatus: string;
}

export function toTesterIntake(row: IntakeRow): TesterIntake {
  // Explicit allowlist — never spread `row` (would leak state/tester_id/etc).
  return {
    id: row.id,
    title: row.title,
    productHint: row.product_hint,
    body: row.body,
    severity: row.severity,
    reproSteps: row.repro_steps,
    expected: row.expected,
    actual: row.actual,
    environment: row.environment,
    createdAt: row.created_at,
    displayStatus: displayStatusFor(row.state),
  };
}
