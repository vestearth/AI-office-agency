export const TRIAGE_SCHEMA_VERSION = 'triage.v1';
const CLASSIFICATIONS = ['triaged', 'needs_scope_review', 'ai_failed'] as const;
export type TriageClassification = (typeof CLASSIFICATIONS)[number];

export interface TriageResult {
  schemaVersion: string;
  classification: TriageClassification;
  summary: string;
  contextHash: string;
  provider?: string;
  ownerRecommendation?: string;
  impact?: string;
  missingInfo?: string[];
  riskFlags?: string[];
  duplicateCandidates?: string[];
}

const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const strArr = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

export function validateTriageResult(obj: unknown): { ok: true; value: TriageResult } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const o = (obj ?? {}) as Record<string, unknown>;
  if (o.schemaVersion !== TRIAGE_SCHEMA_VERSION) e.push(`schemaVersion must be ${TRIAGE_SCHEMA_VERSION}`);
  if (!CLASSIFICATIONS.includes(o.classification as any)) e.push(`classification must be one of ${CLASSIFICATIONS.join(', ')}`);
  if (!str(o.summary)) e.push('summary required');
  if (!str(o.contextHash)) e.push('contextHash required');
  if (o.provider !== undefined && !str(o.provider)) e.push('provider must be a non-empty string when present');
  for (const f of ['ownerRecommendation', 'impact'] as const) if (o[f] !== undefined && !str(o[f])) e.push(`${f} must be a string`);
  for (const f of ['missingInfo', 'riskFlags', 'duplicateCandidates'] as const) if (!strArr(o[f])) e.push(`${f} must be a string[]`);
  if (e.length) return { ok: false, errors: e };
  // Strip to schema fields ONLY — anything extra (source snippets, secrets) is discarded (Decision #12).
  const value: TriageResult = {
    schemaVersion: TRIAGE_SCHEMA_VERSION, classification: o.classification as TriageClassification,
    summary: o.summary as string, contextHash: o.contextHash as string,
    provider: o.provider as string | undefined, ownerRecommendation: o.ownerRecommendation as string | undefined,
    impact: o.impact as string | undefined, missingInfo: o.missingInfo as string[] | undefined,
    riskFlags: o.riskFlags as string[] | undefined, duplicateCandidates: o.duplicateCandidates as string[] | undefined,
  };
  return { ok: true, value };
}
