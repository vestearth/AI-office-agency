import type { DB } from './db';
import { getIntake } from './intakeStore';
import { getActiveClaim } from './claimStore';
import { getLatestTriage } from './triageStore';

export interface ReviewClaim { owner: string; expiresAt: number; }
export interface ReviewIntakeSummary {
  id: string; title: string; severity: string | null; productHint: string | null;
  state: string; revision: number; createdAt: number; updatedAt: number;
  claim?: ReviewClaim; hasTriage: boolean;
}
export interface ReviewIntakeDetail extends ReviewIntakeSummary {
  body: string; reproSteps: string | null; expected: string | null;
  actual: string | null; environment: string | null;
  attachments: { id: string; name: string; bytes: number }[];
  latestTriage: object | null; activeClaim: ReviewClaim | null;
}

const HIDDEN_BY_DEFAULT = new Set(['closed']);

export function toReviewIntake(
  row: import('./intakeStore').IntakeRow,
  extra: {
    hasTriage: boolean;
    attachments: { id: string; name: string; bytes: number }[];
    latestTriage: object | null; activeClaim: ReviewClaim | null;
  }
): ReviewIntakeDetail {
  return {
    id: row.id, title: row.title, severity: row.severity, productHint: row.product_hint,
    state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    hasTriage: extra.hasTriage,
    body: row.body, reproSteps: row.repro_steps, expected: row.expected,
    actual: row.actual, environment: row.environment,
    attachments: extra.attachments, latestTriage: extra.latestTriage, activeClaim: extra.activeClaim,
  };
}

export function listReviewIntakes(
  db: DB, opts: { state?: string; includeClosed?: boolean }, now: number
): { intakes: ReviewIntakeSummary[]; counts: Record<string, number> } {
  const rows = db.prepare(
    `SELECT i.id, i.title, i.severity, i.product_hint AS productHint, i.state,
            i.revision, i.created_at AS createdAt, i.updated_at AS updatedAt,
            EXISTS(SELECT 1 FROM triage_result tr WHERE tr.intake_id = i.id) AS hasTriage
       FROM intake i ORDER BY i.created_at DESC`
  ).all() as (Omit<ReviewIntakeSummary, 'claim' | 'hasTriage'> & { hasTriage: number })[];

  const counts: Record<string, number> = {};
  const intakes: ReviewIntakeSummary[] = [];
  for (const r of rows) {
    counts[r.state] = (counts[r.state] ?? 0) + 1;
    if (!opts.includeClosed && HIDDEN_BY_DEFAULT.has(r.state)) continue;
    if (opts.state && r.state !== opts.state) continue;
    const claim = getActiveClaim(db, r.id, now);
    intakes.push({
      ...r, hasTriage: !!r.hasTriage,
      claim: claim ? { owner: claim.owner, expiresAt: claim.expires_at } : undefined,
    });
  }
  return { intakes, counts };
}

export function getReviewDetail(db: DB, id: string, now: number): ReviewIntakeDetail | null {
  const row = getIntake(db, id);
  if (!row) return null;
  const claim = getActiveClaim(db, id, now);
  const activeClaim = claim ? { owner: claim.owner, expiresAt: claim.expires_at } : null;
  const attachments = db.prepare(
    'SELECT id, original_name AS name, byte_size AS bytes FROM attachment WHERE intake_id = ? AND deleted_at IS NULL'
  ).all(id) as { id: string; name: string; bytes: number }[];
  const latestTriage = getLatestTriage(db, id);
  return toReviewIntake(row, {
    hasTriage: !!latestTriage,
    attachments,
    latestTriage,
    activeClaim,
  });
}
