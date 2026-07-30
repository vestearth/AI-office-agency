'use strict';
// M3 Phase B — Task 7 section 6b: retention sweep drill.
//
// Runs the REAL `intake:ops retention` CLI against a scratch COPY of the live
// intake DB, seeded with both sweepable and must-survive fixtures. The live
// database and live attachment files are never modified.
//
// Usage (from anywhere):  node dashboard/deploy/scripts/drill-retention.js

const path = require('path');
const fs = require('fs');
const C = require('./_drill-common');

const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

(async () => {
  C.loadEnv();
  const D = C.Database();
  const dataDir = C.liveDataDir();
  const dbPath = path.join(dataDir, 'intake.sqlite');

  console.log(`live data dir : ${dataDir}`);
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: no intake DB at ${dbPath}`);
    console.error('If INTAKE_DATA_DIR is set somewhere other than dashboard/server/.env, export it and re-run.');
    process.exit(2);
  }

  const scratch = C.makeScratch('retention');
  const scratchDb = path.join(scratch, 'intake.sqlite');
  const scratchAtt = path.join(scratch, 'attachments');
  fs.mkdirSync(scratchAtt, { recursive: true });
  console.log(`scratch dir   : ${scratch}`);

  await C.copyLiveDb(dbPath, scratchDb);
  console.log('copied live DB via online db.backup() — live data untouched');

  const now = Date.now();
  const db = new D(scratchDb);

  db.prepare('INSERT INTO tester(id,label,created_at) VALUES(?,?,?)')
    .run('TSTR-DRILL', 'retention drill', now - 200 * DAY);

  // (1) closed intake 120d old + its attachment  -> attachment must be swept
  db.prepare(
    `INSERT INTO intake(id,tester_id,title,body,product_hint,state,revision,created_at,updated_at)
     VALUES(?,?,?,?,NULL,?,1,?,?)`
  ).run('INTAKE-DRILL-OLD', 'TSTR-DRILL', 'drill: old closed', 'body', 'closed', now - 200 * DAY, now - 120 * DAY);
  fs.writeFileSync(path.join(scratchAtt, 'drill-old.png'), PNG);
  db.prepare(
    `INSERT INTO attachment(id,intake_id,stored_name,original_name,mime,byte_size,content_hash,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run('ATT-DRILL-OLD', 'INTAKE-DRILL-OLD', 'drill-old.png', 'old.png', 'image/png', PNG.length, 'hash-old', now - 120 * DAY);

  // (2) fresh open intake + attachment -> must survive untouched
  db.prepare(
    `INSERT INTO intake(id,tester_id,title,body,product_hint,state,revision,created_at,updated_at)
     VALUES(?,?,?,?,NULL,?,1,?,?)`
  ).run('INTAKE-DRILL-NEW', 'TSTR-DRILL', 'drill: fresh open', 'body', 'submitted', now - DAY, now - DAY);
  fs.writeFileSync(path.join(scratchAtt, 'drill-new.png'), PNG);
  db.prepare(
    `INSERT INTO attachment(id,intake_id,stored_name,original_name,mime,byte_size,content_hash,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run('ATT-DRILL-NEW', 'INTAKE-DRILL-NEW', 'drill-new.png', 'new.png', 'image/png', PNG.length, 'hash-new', now - DAY);

  // (3) sessions: one 30d past expiry (sweep), one still active (survive)
  db.prepare('INSERT INTO session(id,tester_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run('SES-DRILL-OLD', 'TSTR-DRILL', 'csrf', now - 40 * DAY, now - 30 * DAY);
  db.prepare('INSERT INTO session(id,tester_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run('SES-DRILL-NEW', 'TSTR-DRILL', 'csrf', now - DAY, now + DAY);

  db.close();
  console.log('seeded: 1 sweepable attachment, 1 sweepable session, 1 fresh attachment, 1 active session, 2 intakes');
  console.log('');

  const r = C.runOps(['retention'], { INTAKE_DATA_DIR: scratch, INTAKE_ATTACHMENT_DIR: scratchAtt });
  console.log('--- intake:ops retention output ---');
  console.log(r.output.trim());
  console.log('-----------------------------------');
  C.check('retention CLI exited 0', r.status === 0, `exit=${r.status}`);

  const v = new D(scratchDb, { readonly: true });
  const oldAtt = v.prepare('SELECT deleted_at FROM attachment WHERE id=?').get('ATT-DRILL-OLD');
  const newAtt = v.prepare('SELECT deleted_at FROM attachment WHERE id=?').get('ATT-DRILL-NEW');
  const oldSes = v.prepare('SELECT id FROM session WHERE id=?').get('SES-DRILL-OLD');
  const newSes = v.prepare('SELECT id FROM session WHERE id=?').get('SES-DRILL-NEW');
  const intakes = v.prepare(
    "SELECT COUNT(*) AS n FROM intake WHERE id IN ('INTAKE-DRILL-OLD','INTAKE-DRILL-NEW')"
  ).get();
  const testerRow = v.prepare("SELECT COUNT(*) AS n FROM tester WHERE id='TSTR-DRILL'").get();
  const audDel = v.prepare(
    "SELECT COUNT(*) AS n FROM audit_event WHERE kind='attachment_deleted' AND actor_id='retention'"
  ).get();
  const audSes = v.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE kind='retention_sessions_deleted'").get();
  v.close();

  C.check('closed-intake attachment soft-deleted (deleted_at set)', oldAtt && oldAtt.deleted_at != null,
    `deleted_at=${oldAtt ? oldAtt.deleted_at : 'row missing'}`);
  C.check('closed-intake attachment file removed from disk', !fs.existsSync(path.join(scratchAtt, 'drill-old.png')));
  C.check('fresh attachment row untouched', newAtt && newAtt.deleted_at == null);
  C.check('fresh attachment file still on disk', fs.existsSync(path.join(scratchAtt, 'drill-new.png')));
  C.check('expired session hard-deleted', !oldSes);
  C.check('active session retained', !!newSes);
  C.check('structured intake rows never deleted (1y policy)', intakes && intakes.n === 2, `${intakes ? intakes.n : '?'}/2 present`);
  C.check('tester row never deleted', testerRow && testerRow.n === 1);
  C.check('attachment deletion audited with actor=retention', audDel && audDel.n >= 1, `${audDel ? audDel.n : 0} audit rows`);
  C.check('session deletion audited', audSes && audSes.n >= 1, `${audSes ? audSes.n : 0} audit rows`);

  const ok = C.summary('Section 6b — retention sweep');
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`scratch removed: ${scratch}`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('DRILL ERROR:', err && err.stack ? err.stack : err);
  process.exit(2);
});
