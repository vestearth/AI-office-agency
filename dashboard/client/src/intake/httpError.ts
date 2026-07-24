// Reads the status / Retry-After metadata that intakeApi's IntakeApiError
// attaches to thrown errors (see intakeApi.ts). Kept as free functions
// (rather than `instanceof IntakeApiError` everywhere) so components can
// stay agnostic of the exact error class and this stays trivially testable
// in isolation if that's ever wanted.
export function apiErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function apiErrorRetryAfterSeconds(err: unknown): number | undefined {
  const retryAfterSeconds = (err as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof retryAfterSeconds === 'number' ? retryAfterSeconds : undefined;
}
