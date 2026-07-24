import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';

export function checkPromotionGate(input: {
  intakeState: string;
  latestTriage: { schemaVersion?: string; classification?: string } | null;
  override?: { reason?: string };
}): { allowed: boolean; reason: string; gateOverridden: boolean } {
  const t = input.latestTriage;
  const triageValid = !!t && t.schemaVersion === TRIAGE_SCHEMA_VERSION && t.classification === 'triaged';
  if (triageValid) return { allowed: true, reason: 'triage_valid', gateOverridden: false };

  const reason = (input.override?.reason ?? '').trim();
  if (reason) return { allowed: true, reason: 'gate_overridden', gateOverridden: true };

  return { allowed: false, reason: 'triage_required', gateOverridden: false };
}
