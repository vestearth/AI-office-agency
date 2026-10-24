const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A status.yaml date or timestamp as epoch ms. A date-only value is local midnight, as the server
 * reads it in the office time zone (the viewer's own); a value with a time keeps its instant.
 */
export function statusTimeMs(value: string): number {
  const dateOnly = DATE_ONLY.exec(value);
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    : new Date(value).getTime();
}

// Compact elapsed-time label ("45m", "24h", "4d") shared by Review and Command.
export function formatAge(value?: string | null, now = Date.now()): string {
  if (!value) return 'Unknown';
  const timestamp = statusTimeMs(value);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}
