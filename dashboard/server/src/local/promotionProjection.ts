// Decision-#12 allowlist projection: this is the ONLY shape of intake data
// permitted to cross into the team-synced `runs/` directory. Anything not
// explicitly listed on PromotedProjection must never be added here.

export const PROMOTION_PROJECTION_VERSION = 'promo.v1';

export interface PromotedProjection {
  projectionVersion: string;
  centralIntakeId: string;
  title: string;
  summary: string;
  productScope: string | null;
  reproSteps: string;
  triageSummary: string | null;
  riskFlags: string[];
  duplicateRefs: string[];
  reporterRef: string; // pseudonymous, NOT the tester real name / id
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
  intake: { id: string; title: string; body: string; product_hint: string | null; tester_id: string };
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
    reproSteps: input.intake.body,
    triageSummary: input.triage?.summary ?? null,
    riskFlags: input.triage?.riskFlags ?? [],
    duplicateRefs: input.triage?.duplicateCandidates ?? [],
    reporterRef,
  };
}

export function assertNoForbiddenFields(projection: object): void {
  const keys = new Set(Object.keys(projection));
  for (const forbidden of FORBIDDEN_KEYS) {
    if (keys.has(forbidden)) throw new Error(`promotion projection leaks forbidden field: ${forbidden}`);
  }
}
