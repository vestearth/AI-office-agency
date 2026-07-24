import type { DB } from './db';

// Authoritative + cheap: sum byte_size over non-deleted attachment rows.
// Never walk the filesystem to compute this.
export function usedStorageBytes(db: DB): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(byte_size),0) AS total FROM attachment WHERE deleted_at IS NULL')
    .get() as any;
  return row.total as number;
}

export function overHighWater(db: DB, highWaterBytes: number): boolean {
  return usedStorageBytes(db) >= highWaterBytes;
}
