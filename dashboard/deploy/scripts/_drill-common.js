'use strict';
// Shared helpers for the M3 Phase B verification drills (Task 7 sections 6-7).
//
// Design rules for every drill:
//  - NEVER mutate live intake data. Drills that need to write work on a
//    scratch COPY made with better-sqlite3's online `db.backup()` (the same
//    WAL-consistent mechanism the real backup uses), never a raw file copy.
//  - Exercise the REAL code paths (the `intake:ops` CLI, the real Express
//    app) rather than reimplementing policy in the drill.
//  - Print PASS/FAIL per check and exit non-zero if any check fails, so the
//    operator can paste the output straight into phase-b-results.md.
//  - Windows-safe: path.join everywhere, npm spawned with shell:true.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const SERVER_DIR = path.resolve(__dirname, '..', '..', 'server');
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));

function loadEnv() {
  try {
    serverRequire('dotenv').config({ path: path.join(SERVER_DIR, '.env') });
  } catch {
    // dotenv is optional here — if it's missing we just use the shell env.
  }
}

function Database() {
  return serverRequire('better-sqlite3');
}

// Mirrors intake/config.ts resolution, with relative paths resolved against
// dashboard/server (the cwd the app runs from), not the drill's cwd.
function resolveFromServer(raw, fallback) {
  const v = (raw || '').trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.resolve(SERVER_DIR, v);
}

function liveDataDir() {
  return resolveFromServer(process.env.INTAKE_DATA_DIR, path.join(SERVER_DIR, 'intake-data'));
}

function liveAttachmentDir(dataDir) {
  return resolveFromServer(process.env.INTAKE_ATTACHMENT_DIR, path.join(dataDir, 'attachments'));
}

function backupTarget(dataDir) {
  return resolveFromServer(process.env.INTAKE_BACKUP_TARGET, path.join(dataDir, 'backups'));
}

function makeScratch(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `intake-drill-${tag}-`));
}

// Online, WAL-consistent snapshot of the live DB into the scratch dir.
async function copyLiveDb(dbPath, destPath) {
  const D = Database();
  const db = new D(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

// Runs the real ops CLI (`npm run intake:ops -- <args>`) from dashboard/server.
// Built as a single shell string (rather than argv + shell:true, which Node
// deprecates) so it works with npm.cmd on Windows and npm on macOS/Linux.
function runOps(args, env) {
  const quoted = args.map((a) => (/^[\w.:@/\\-]+$/.test(a) ? a : `"${a}"`)).join(' ');
  const res = spawnSync(`npm run --silent intake:ops -- ${quoted}`, {
    cwd: SERVER_DIR,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    shell: true,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    output: `${res.stdout || ''}${res.stderr || ''}`,
  };
}

const results = [];

function check(name, pass, detail) {
  const d = detail === undefined || detail === null ? '' : String(detail);
  results.push({ name, pass: !!pass, detail: d });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${d ? `  — ${d}` : ''}`);
}

function summary(title) {
  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`==== ${title}: ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  return failed.length === 0;
}

module.exports = {
  SERVER_DIR,
  serverRequire,
  loadEnv,
  Database,
  liveDataDir,
  liveAttachmentDir,
  backupTarget,
  makeScratch,
  copyLiveDb,
  runOps,
  check,
  summary,
};
