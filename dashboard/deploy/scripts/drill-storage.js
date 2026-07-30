'use strict';
// M3 Phase B — Task 7 section 6a: storage high-water enforcement drill.
//
// Boots a TEMPORARY instance of the real Express app against a scratch COPY of
// the live intake DB, with INTAKE_STORAGE_HIGH_WATER_BYTES set just above the
// copy's current usage. Then, over real HTTP through the real tester routes:
//   1. an attachment upload below the mark succeeds        -> 201
//   2. the next upload (now past the mark) is refused      -> 507
//   3. a plain structured intake submission still succeeds -> 201
// The live DB, live attachment files, and the live service are never touched
// (separate port, separate data dir).
//
// Usage:  node dashboard/deploy/scripts/drill-storage.js
// Env:    DRILL_PORT (default 4399) if 4399 is taken.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const C = require('./_drill-common');

const PORT = Number(process.env.DRILL_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const MB = 1024 * 1024;

function pngOfSize(bytes) {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  for (let i = 8; i < bytes; i += 1) buf[i] = i % 251;
  return buf;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  C.loadEnv();
  const D = C.Database();
  const dataDir = C.liveDataDir();
  const dbPath = path.join(dataDir, 'intake.sqlite');

  console.log(`live data dir : ${dataDir}`);
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: no intake DB at ${dbPath}`);
    process.exit(2);
  }

  const scratch = C.makeScratch('storage');
  const scratchDb = path.join(scratch, 'intake.sqlite');
  const scratchAtt = path.join(scratch, 'attachments');
  fs.mkdirSync(scratchAtt, { recursive: true });
  fs.mkdirSync(path.join(scratch, 'runs'), { recursive: true });
  console.log(`scratch dir   : ${scratch}`);

  await C.copyLiveDb(dbPath, scratchDb);
  console.log('copied live DB via online db.backup() — live data untouched');

  // Mint a tester code inside the COPY using the real CLI.
  const mint = C.runOps(['issue-code', '--label', 'storage-drill'], {
    INTAKE_DATA_DIR: scratch,
    INTAKE_ATTACHMENT_DIR: scratchAtt,
  });
  const codeMatch = /([0-9a-f]{32})/.exec(mint.output);
  if (!codeMatch) {
    console.error('ERROR: could not mint a tester code in the scratch copy.');
    console.error(mint.output.trim());
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
  const code = codeMatch[1];

  // High-water just above current usage: upload #1 (2MB) is allowed, and
  // after it lands, usage is past the mark so upload #2 must be refused.
  const usedRow = new D(scratchDb, { readonly: true });
  const used = usedRow
    .prepare('SELECT COALESCE(SUM(byte_size),0) AS total FROM attachment WHERE deleted_at IS NULL')
    .get().total;
  usedRow.close();
  const highWater = used + 1 * MB;
  console.log(`attachment usage in copy: ${used} bytes -> INTAKE_STORAGE_HIGH_WATER_BYTES=${highWater}`);
  console.log('');

  const tsNodeBin = C.serverRequire.resolve('ts-node/dist/bin.js');
  const child = spawn(process.execPath, [tsNodeBin, path.join('src', 'index.ts')], {
    cwd: C.SERVER_DIR,
    env: {
      ...process.env,
      AI_OFFICE_ROOT: scratch,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_AUTH_TOKEN: '',
      DASHBOARD_ALLOWED_ORIGINS: BASE,
      DASHBOARD_CLIENT_DIST_DIR: path.join(scratch, 'no-dist'),
      INTAKE_DATA_DIR: scratch,
      INTAKE_ATTACHMENT_DIR: scratchAtt,
      INTAKE_RUNS_DIR: path.join(scratch, 'runs'),
      INTAKE_ROLE: 'central',
      INTAKE_STORAGE_HIGH_WATER_BYTES: String(highWater),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  const cleanup = () => {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  };

  try {
    const up = await waitForHealth(45000);
    C.check(`temp instance booted on ${BASE}`, up);
    if (!up) {
      console.log('--- temp server log ---');
      console.log(serverLog.trim());
      console.log('-----------------------');
      C.summary('Section 6a — storage high-water');
      cleanup();
      process.exit(1);
    }

    const H = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };

    const login = await fetch(`${BASE}/api/intake/session`, {
      method: 'POST', headers: H, body: JSON.stringify({ code }),
    });
    const loginBody = await login.json();
    const sid = /intake_sid=([^;]+)/.exec(login.headers.get('set-cookie') || '');
    C.check('tester session established in temp instance', login.status === 200 && !!sid && !!loginBody.csrfToken,
      `status=${login.status}`);
    if (!sid) throw new Error('no session cookie');
    const authH = { ...H, 'x-csrf-token': loginBody.csrfToken, cookie: `intake_sid=${sid[1]}` };

    const submit = await fetch(`${BASE}/api/intake/intakes`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ title: 'storage drill intake', body: 'high-water enforcement drill' }),
    });
    const submitBody = await submit.json();
    C.check('structured intake submitted (baseline)', submit.status === 201, `status=${submit.status}`);
    const intakeId = submitBody.id;

    const upload = async (name) => {
      const res = await fetch(`${BASE}/api/intake/intakes/${intakeId}/attachments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream', Origin: BASE, 'Sec-Fetch-Site': 'same-origin',
          'X-Filename': name, 'x-csrf-token': loginBody.csrfToken, cookie: `intake_sid=${sid[1]}`,
        },
        body: pngOfSize(2 * MB),
      });
      let body = null;
      try { body = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body };
    };

    const first = await upload('below-mark.png');
    C.check('upload below the high-water mark accepted (201)', first.status === 201,
      `status=${first.status} ${JSON.stringify(first.body)}`);

    const second = await upload('past-mark.png');
    C.check('upload past the high-water mark refused (507)', second.status === 507,
      `status=${second.status} ${JSON.stringify(second.body)}`);

    const stillWorks = await fetch(`${BASE}/api/intake/intakes`, {
      method: 'POST', headers: authH,
      body: JSON.stringify({ title: 'storage drill intake 2', body: 'structured path must still work when storage is full' }),
    });
    C.check('structured intake submission still works while storage is full (201)', stillWorks.status === 201,
      `status=${stillWorks.status}`);

    const ok = C.summary('Section 6a — storage high-water');
    if (!ok) {
      console.log('--- temp server log (tail) ---');
      console.log(serverLog.trim().split('\n').slice(-25).join('\n'));
      console.log('------------------------------');
    }
    cleanup();
    console.log(`scratch removed: ${scratch}`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('DRILL ERROR:', err && err.stack ? err.stack : err);
    console.log('--- temp server log (tail) ---');
    console.log(serverLog.trim().split('\n').slice(-25).join('\n'));
    console.log('------------------------------');
    cleanup();
    process.exit(2);
  }
})();
