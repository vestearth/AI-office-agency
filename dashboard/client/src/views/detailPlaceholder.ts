// Text for a detail section that has nothing to render. A failed fetch must not
// read as "the file does not exist": that sent people looking for a missing
// task.md when the API was simply unreachable.
export function detailPlaceholder(load: { loading: boolean; error: string | null }, emptyText: string): string {
  if (load.loading) return 'Loading…';
  if (load.error) return `Could not load task detail (${load.error}).`;
  return emptyText;
}
