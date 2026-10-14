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
