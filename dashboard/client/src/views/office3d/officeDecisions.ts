/**
 * True when a human decision was recorded no later than the history row it caused. The decision keeps
 * milliseconds (`new Date().toISOString()` in `routes/decisions.ts`), but `reconcile-decision.rb` writes
 * the row to the second (`%FT%TZ`), so a decision the driver applies within the same second must still
 * count: both are compared as whole seconds. A missing or unparseable time never matches.
 */
export function decidedNoLaterThan(decidedAt: string | null | undefined, at: string | null | undefined): boolean {
  const decided = decidedAt ? Date.parse(decidedAt) : NaN;
  const moved = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(decided) || !Number.isFinite(moved)) return false;
  return Math.floor(decided / 1000) <= Math.floor(moved / 1000);
}
