// The release ladder's rung order and labels. Runtime module (like runCounts):
// the server imports it relatively and the client through the same path.
export const RELEASE_LADDER = [
  'implementation_verification',
  'deploy_staging',
  'staging_acceptance',
  'deploy_production',
  'production_acceptance',
] as const;

export type ReleaseRung = (typeof RELEASE_LADDER)[number];

export const RUNG_LABEL: Record<ReleaseRung, string> = {
  implementation_verification: 'Verified',
  deploy_staging: 'Staging deployed',
  staging_acceptance: 'Staging accepted',
  deploy_production: 'Prod deployed',
  production_acceptance: 'Prod accepted',
};

/**
 * Gate names that mean a ladder rung (operator decision 2026-10-15): the docs' own
 * example gate `authenticated_staging` was used by 7 tasks as their staging proof. It
 * stands in only when the task has no gate of the ladder name itself.
 */
export const RUNG_ALIASES: Partial<Record<ReleaseRung, string[]>> = {
  staging_acceptance: ['authenticated_staging'],
};
