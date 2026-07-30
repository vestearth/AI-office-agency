'use strict';
// M3 Phase B — Task 7 section 7: backup / restore drill.
//
// 1. Runs the real `intake:ops backup` against the LIVE data dir. This only
//    READS the live DB (online db.backup()) and writes into the backup target,
//    so the live database is not modified.
// 2. Runs the real `intake:ops restore-verify` on the fresh snapshot.
// 3. Restores the snapshot into a scratch dir and inspects it: integrity,
//    core tables, row counts vs live, and that credentials are stored as
//    scrypt hashes (128 hex) rather than raw 32-hex secrets.
// 4. Checks rotation left a sane number of snapshots (<= 7 daily + 4 weekly).
//
// Optional: set DRILL_KNOWN_SECRET to a real raw access code or admin secret
// to additionally byte-scan the snapshot proving that raw value never appears.
//   DRILL_KNOWN_SECRET=<raw-code> node dashboard/deploy/scripts/drill-backup.js
// (Pass it on the command line only — never commit a real secret.)
//
// Usage:  node dashboard/deploy/scripts/drill-backup.js

const path = require('path');
const fs = require('fs');
const C = require('./_drill-common');

const CORE_TABLES = ['tester', 'access_code', 'session', 'intake', 'attachment', 'audit_event', 'admin_credential'];

(async () => {
  C.loadEnv();
  const D = C.Database();
  const dataDir = C.liveDataDir();
  const dbPath = path.join(dataDir, 'intake.sqlite');
  const target = C.backupTarget(dataDir);

  console.log(`live data dir : ${dataDir}`);
  console.log(`backup target : ${target}`);
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: no intake DB at ${dbPath}`);
    process.exit(2);
  }

  // --- 1. real backup CLI against live data (read-only wrt the live DB) ---
  const bk = C.runOps(['backup'], {});
  console.log('--- intake:ops backup output ---');
  console.log(bk.output.trim());
  console.log('--------------------------------');
  C.check('backup CLI exited 0', bk.status === 0, `exit=${bk.status}`);

  const snapMatch = /snapshot=(.+?)(?:\s+manifest=|\s*$)/m.exec(bk.output);
  const manifestMatch = /manifest=(.+?)\s*$/m.exec(bk.output);
  C.check('backup reported a snapshot path', !!snapMatch);
  if (!snapMatch) {
    C.summary('Section 7 — backup/restore');
    process.exit(1);
  }
  const snapshotPath = snapMatch[1].trim();
  const manifestPath = manifestMatch ? manifestMatch[1].trim() : `${snapshotPath}.manifest.json`;

  C.check('snapshot file exists on disk', fs.existsSync(snapshotPath), snapshotPath);
  C.check('attachment manifest exists on disk', fs.existsSync(manifestPath), manifestPath);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    // reported by the check below
  }
  C.check('manifest is valid JSON (array of attachment metadata)', Array.isArray(manifest),
    Array.isArray(manifest) ? `${manifest.length} entries` : 'parse failed');
  if (Array.isArray(manifest) && manifest.length > 0) {
    const e = manifest[0];
    C.check('manifest entries carry metadata only (no blob/secret fields)',
      ['stored_name', 'original_name', 'byte_size', 'content_hash'].every((k) => k in e) &&
      !('data' in e) && !('buffer' in e) && !('code' in e),
      Object.keys(e).join(','));
  }

  // --- 2. real restore-verify CLI ---
  const rv = C.runOps(['restore-verify', snapshotPath], {});
  console.log('--- intake:ops restore-verify output ---');
  console.log(rv.output.trim());
  console.log('---------------------------------------');
  C.check('restore-verify CLI exited 0', rv.status === 0, `exit=${rv.status}`);
  C.check('restore-verify reports ok=true', /ok=true/.test(rv.output));
  C.check('restore-verify reports integrity=ok', /integrity=ok/.test(rv.output));

  // --- 3. restore into a scratch dir and inspect the restored DB ---
  const scratch = C.makeScratch('backup');
  const restored = path.join(scratch, 'intake.sqlite');
  fs.copyFileSync(snapshotPath, restored);
  console.log(`restored copy  : ${restored}`);

  const live = new D(dbPath, { readonly: true });
  const liveCounts = {
    intake: live.prepare('SELECT COUNT(*) AS n FROM intake').get().n,
    audit: live.prepare('SELECT COUNT(*) AS n FROM audit_event').get().n,
    tester: live.prepare('SELECT COUNT(*) AS n FROM tester').get().n,
  };
  live.close();

  const rdb = new D(restored, { readonly: true, fileMustExist: true });
  const integrity = rdb.prepare('PRAGMA integrity_check').get().integrity_check;
  const tables = rdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const restoredCounts = {
    intake: rdb.prepare('SELECT COUNT(*) AS n FROM intake').get().n,
    audit: rdb.prepare('SELECT COUNT(*) AS n FROM audit_event').get().n,
    tester: rdb.prepare('SELECT COUNT(*) AS n FROM tester').get().n,
  };
  const codeHashes = rdb.prepare('SELECT code_hash, salt FROM access_code').all();
  const credHashes = rdb.prepare('SELECT cred_hash, salt FROM admin_credential').all();
  rdb.close();

  C.check('restored DB integrity_check = ok', integrity === 'ok', integrity);
  C.check('restored DB has all core tables', CORE_TABLES.every((t) => tables.includes(t)),
    CORE_TABLES.filter((t) => !tables.includes(t)).join(',') || 'all present');
  // Fidelity, not a minimum row count: the snapshot must contain no phantom
  // rows, and must have captured the data that existed when it was taken.
  // (live counts can legitimately grow between the snapshot and this check.)
  const noPhantoms = ['intake', 'audit', 'tester'].every((k) => restoredCounts[k] <= liveCounts[k]);
  C.check('restored row counts consistent with live (no phantom rows)', noPhantoms,
    `intake ${restoredCounts.intake}/${liveCounts.intake}, audit ${restoredCounts.audit}/${liveCounts.audit}, tester ${restoredCounts.tester}/${liveCounts.tester}`);
  C.check('snapshot captured the live intakes that existed',
    liveCounts.intake === 0 ? true : restoredCounts.intake > 0,
    liveCounts.intake === 0 ? 'live DB currently has no intakes — nothing to capture' : `restored=${restoredCounts.intake}`);
  C.check('snapshot captured the live audit trail',
    liveCounts.audit === 0 ? true : restoredCounts.audit > 0,
    liveCounts.audit === 0 ? 'live DB currently has no audit rows' : `restored=${restoredCounts.audit}`);

  // Secrets: scrypt(keylen 64) -> 128 hex chars; a RAW access code is 32 hex.
  const badCode = codeHashes.filter((r) => !/^[0-9a-f]{128}$/.test(r.code_hash) || !/^[0-9a-f]{32}$/.test(r.salt));
  const badCred = credHashes.filter((r) => !/^[0-9a-f]{128}$/.test(r.cred_hash) || !/^[0-9a-f]{32}$/.test(r.salt));
  C.check('all access codes stored as 128-hex scrypt hashes (never raw)', badCode.length === 0,
    `${codeHashes.length} codes, ${badCode.length} malformed`);
  C.check('all admin credentials stored as 128-hex scrypt hashes (never raw)', badCred.length === 0,
    `${credHashes.length} creds, ${badCred.length} malformed`);

  const known = (process.env.DRILL_KNOWN_SECRET || '').trim();
  if (known) {
    const bytes = fs.readFileSync(snapshotPath);
    const present = bytes.includes(Buffer.from(known, 'utf8'));
    C.check('known raw secret does NOT appear anywhere in the snapshot', !present,
      present ? 'LEAK: raw value found in snapshot bytes' : 'not found (expected)');
  } else {
    console.log('note: DRILL_KNOWN_SECRET not set — skipped the raw-secret byte scan (structural hash check above still ran)');
  }

  // --- 4. rotation sanity ---
  const snapshots = fs.readdirSync(target).filter((n) => /^intake-\d{8}-\d{6}\.sqlite$/.test(n));
  C.check('rotation keeps a bounded number of snapshots (<= 11)', snapshots.length <= 11,
    `${snapshots.length} snapshots in target`);

  const ok = C.summary('Section 7 — backup/restore drill');
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`scratch removed: ${scratch}`);
  console.log(`snapshot kept for the record: ${snapshotPath}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('DRILL ERROR:', err && err.stack ? err.stack : err);
  process.exit(2);
});
