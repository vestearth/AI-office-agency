import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { DB } from './db';
import { recordAudit } from './audit';

// Decision #13/#7: an intake-board backup is a two-part artifact:
//  1. `intake-<timestamp>.sqlite` — an ONLINE, WAL-consistent snapshot taken
//     via better-sqlite3's `db.backup()` (SQLite's own backup API). This is
//     NOT a raw filesystem copy of the live .sqlite/-wal/-shm files, which
//     could be torn mid-write; `db.backup()` safely reads a consistent view
//     even while the live DB is being written to.
//  2. `<snapshot>.manifest.json` — a listing of the attachment files on disk
//     that belong to this snapshot (stored_name/original_name/byte_size/
//     content_hash from the `attachment` table, non-deleted only). The
//     attachment blobs themselves are NOT copied here (Decision #13 scope);
//     the manifest lets an operator reconcile/copy them separately or
//     detect drift.
//
// Secrets note: the sqlite snapshot contains the SAME columns as the live
// DB, including access_code and admin_credential hashes — these are salted
// hashes (see crypto.ts), never raw secrets. The manifest contains only
// attachment file metadata and content hashes, no secrets at all.

const CORE_TABLES = ['tester', 'access_code', 'session', 'intake', 'attachment', 'audit_event', 'admin_credential'];

export interface AttachmentManifestEntry {
  stored_name: string;
  original_name: string;
  byte_size: number;
  content_hash: string;
}

export interface RunBackupOptions {
  backupTarget: string;
  attachmentDir: string;
  now: number;
  keepDaily?: number;
  keepWeekly?: number;
}

export type RunBackupResult =
  | { ok: true; snapshotPath: string; manifestPath: string }
  | { ok: false; error: string };

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

// Deterministic filename timestamp derived from the injected `now`, never
// from Date.now()/`new Date()` with no args — callers control the clock so
// rotation tests stay reproducible.
function formatTimestamp(now: number): string {
  const d = new Date(now);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

const SNAPSHOT_RE = /^intake-(\d{8}-\d{6})\.sqlite$/;

function snapshotPathFor(backupTarget: string, now: number): { snapshotPath: string; manifestPath: string } {
  const ts = formatTimestamp(now);
  const snapshotPath = path.join(backupTarget, `intake-${ts}.sqlite`);
  const manifestPath = path.join(backupTarget, `intake-${ts}.sqlite.manifest.json`);
  return { snapshotPath, manifestPath };
}

function readManifest(db: DB): AttachmentManifestEntry[] {
  const rows = db
    .prepare(
      `SELECT stored_name, original_name, byte_size, content_hash
       FROM attachment WHERE deleted_at IS NULL
       ORDER BY stored_name ASC`
    )
    .all() as AttachmentManifestEntry[];
  return rows;
}

// Rotation: sort retained snapshots by the timestamp encoded in their
// filename (newest first) and keep the newest `keepDaily` as "daily" slots
// plus the newest `keepWeekly` snapshots that land roughly a week apart as
// "weekly" slots. Kept simple/deterministic per the brief: rather than
// modeling calendar weeks, we keep the newest `keepDaily` snapshots outright
// (the common case exercised by ops), and separately keep up to
// `keepWeekly` older snapshots spaced at >= 7-day intervals from each other,
// deleting everything else.
function rotateSnapshots(backupTarget: string, keepDaily: number, keepWeekly: number): void {
  const entries = fs
    .readdirSync(backupTarget)
    .map((name) => ({ name, match: SNAPSHOT_RE.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .map((e) => ({ name: e.name, ts: e.match[1] }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first

  const keepNames = new Set<string>();
  const daily = entries.slice(0, keepDaily);
  for (const e of daily) keepNames.add(e.name);

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  let lastKeptMs = daily.length > 0 ? parseTimestampMs(daily[daily.length - 1].ts) : Infinity;
  let weeklyKept = 0;
  for (const e of entries.slice(keepDaily)) {
    if (weeklyKept >= keepWeekly) break;
    const ms = parseTimestampMs(e.ts);
    if (lastKeptMs - ms >= WEEK_MS) {
      keepNames.add(e.name);
      lastKeptMs = ms;
      weeklyKept += 1;
    }
  }

  for (const e of entries) {
    if (keepNames.has(e.name)) continue;
    const snapshotPath = path.join(backupTarget, e.name);
    const manifestPath = `${snapshotPath}.manifest.json`;
    try {
      fs.rmSync(snapshotPath, { force: true });
      fs.rmSync(manifestPath, { force: true });
    } catch {
      // best-effort rotation cleanup; a stray leftover file never blocks a backup
    }
  }
}

function parseTimestampMs(ts: string): number {
  // ts is YYYYMMDD-HHMMSS (UTC, as written by formatTimestamp)
  const y = Number(ts.slice(0, 4));
  const mo = Number(ts.slice(4, 6));
  const d = Number(ts.slice(6, 8));
  const h = Number(ts.slice(9, 11));
  const mi = Number(ts.slice(11, 13));
  const s = Number(ts.slice(13, 15));
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

export async function runBackup(db: DB, options: RunBackupOptions): Promise<RunBackupResult> {
  const { backupTarget, now, keepDaily = 7, keepWeekly = 4 } = options;
  try {
    fs.mkdirSync(backupTarget, { recursive: true });
    const { snapshotPath, manifestPath } = snapshotPathFor(backupTarget, now);

    // Online, WAL-consistent snapshot — NOT a raw file copy.
    await db.backup(snapshotPath);

    const manifest = readManifest(db);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    rotateSnapshots(backupTarget, keepDaily, keepWeekly);

    recordAudit(db, {
      kind: 'backup_completed',
      actorKind: 'system',
      detail: { snapshotPath, manifestPath, attachmentCount: manifest.length },
    });

    return { ok: true, snapshotPath, manifestPath };
  } catch (err) {
    const error = (err as Error).message ?? String(err);
    try {
      recordAudit(db, { kind: 'backup_failed', actorKind: 'system', detail: { error } });
    } catch {
      // audit itself failing must never mask the original backup error
    }
    return { ok: false, error };
  }
}

export interface VerifyRestoreResult {
  ok: boolean;
  tables: string[];
  integrity: string;
}

// Opens the snapshot read-only and confirms it is a restorable, consistent
// SQLite database with all core tables present. This IS the "tested
// restore" requirement — a backup that can't be verified this way is not
// considered a valid restore point.
export function verifyRestore(snapshotPath: string): VerifyRestoreResult {
  let db: Database.Database | undefined;
  try {
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    const integrity = integrityRow?.integrity_check ?? 'unknown';
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    const hasCoreTables = CORE_TABLES.every((t) => tables.includes(t));
    return { ok: integrity === 'ok' && hasCoreTables, tables, integrity };
  } catch (err) {
    return { ok: false, tables: [], integrity: `error: ${(err as Error).message}` };
  } finally {
    db?.close();
  }
}
