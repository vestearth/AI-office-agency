// Decision-#12 allowlist projection: this is the ONLY shape of intake data
// permitted to cross into the team-synced `runs/` directory. Anything not
// explicitly listed on PromotedProjection must never be added here.

export const PROMOTION_PROJECTION_VERSION = 'promo.v2';

export interface PromotedProjection {
  projectionVersion: string;
  centralIntakeId: string;
  title: string;
  summary: string;
  productScope: string | null;
  triageSummary: string | null;
  riskFlags: string[];
  duplicateRefs: string[];
  reporterRef: string; // pseudonymous, NOT the tester real name / id
  // promo.v2: optional structured fields carried straight from the intake.
  // NOTE: reproSteps is sourced from the structured intake.repro_steps field
  // (added in M4 Task 1), superseding the promo.v1 behavior of dumping the
  // full intake body under this key — that was only ever a proxy for a real
  // repro-steps field, which now exists.
  severity?: string;
  reproSteps?: string;
  expected?: string;
  actual?: string;
  environment?: string;
}

// Defense-in-depth denylist: if any of these keys ever appear on a projection
// object (e.g. from a future field added without updating the allowlist),
// assertNoForbiddenFields throws rather than letting it reach disk.
const FORBIDDEN_KEYS = [
  'accessCode', 'access_code', 'session', 'token', 'ip', 'userAgent', 'user_agent',
  'email', 'testerRealName', 'tester_id', 'attachments', 'rawLog', 'prompt', 'contextManifest',
  'sourceSnippet', 'secret', 'credential',
];

export function projectIntakeForPromotion(input: {
  intake: {
    id: string; title: string; body: string; product_hint: string | null; tester_id: string;
    severity?: string | null; repro_steps?: string | null; expected?: string | null;
    actual?: string | null; environment?: string | null;
  };
  triage: { summary?: string; riskFlags?: string[]; duplicateCandidates?: string[] } | null;
}): PromotedProjection {
  // Pseudonymous, stable-per-intake reporter reference (no real identity).
  const reporterRef = `reporter:${input.intake.id}`;
  return {
    projectionVersion: PROMOTION_PROJECTION_VERSION,
    centralIntakeId: input.intake.id,
    title: input.intake.title,
    summary: input.intake.body.slice(0, 2000),
    productScope: input.intake.product_hint,
    triageSummary: input.triage?.summary ?? null,
    riskFlags: input.triage?.riskFlags ?? [],
    duplicateRefs: input.triage?.duplicateCandidates ?? [],
    reporterRef,
    severity: input.intake.severity ?? undefined,
    // Fall back to the full, untruncated body when no structured repro_steps
    // was provided — otherwise a long body (> 2000 chars, truncated in
    // `summary` above) would silently lose its tail with no fallback home.
    reproSteps: input.intake.repro_steps ?? input.intake.body,
    expected: input.intake.expected ?? undefined,
    actual: input.intake.actual ?? undefined,
    environment: input.intake.environment ?? undefined,
  };
}

export function assertNoForbiddenFields(projection: object): void {
  const keys = new Set(Object.keys(projection));
  for (const forbidden of FORBIDDEN_KEYS) {
    if (keys.has(forbidden)) throw new Error(`promotion projection leaks forbidden field: ${forbidden}`);
  }
}
