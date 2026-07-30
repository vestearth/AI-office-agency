# M3 Phase B — Async Handoff (Claude ⇄ Central host)

**Purpose:** finish the Task 7 verification checklist across two machines
without live chat round-trips. Claude writes instructions here; the operator
runs them on the Central host and pastes raw output into
[`phase-b-results.md`](./phase-b-results.md).

## Protocol (read once)

| File | Written by | Never edited by |
|---|---|---|
| `phase-b-handoff.md` (this file) | Claude, on the Mac | the Central operator |
| `phase-b-results.md` | the Central operator | Claude |

Two separate files on purpose — each side only ever touches its own file, so
`git pull` never conflicts.

**The loop:**

1. Claude writes the next round here, commits.
2. Operator pushes from the Mac → `git pull` on the Central host.
3. Operator runs the commands, **appends** raw output to `phase-b-results.md`
   under the round's heading, commits + pushes **from the Central host**.
4. Claude pulls on the Mac, reads results, updates
   `verification-checklist.md`, and writes the next round here.

## Safety guarantees of every drill in this file

- **The live intake DB is never modified.** Drills that need to write operate
  on a scratch copy made with better-sqlite3's online `db.backup()` (the same
  WAL-consistent mechanism the real backup uses) — never a raw file copy.
- **The live service is never restarted or reconfigured.** The one drill that
  needs a running server boots a *second, temporary* instance on port 4399
  against the scratch copy, then kills it.
- Scratch dirs live in the OS temp dir and are deleted at the end of each run.
- `drill-backup.js` does write to the configured backup target — that is the
  point of the drill, and it only *reads* the live DB.
- Every drill prints `PASS`/`FAIL` per check and exits non-zero if any check
  fails, so the pasted output is the evidence.

## Status so far

| Checklist section | State |
|---|---|
| 1. Auth boundary | ✅ PASS (LAN, 2026-07-30) — 2 sub-items deferred, need an `intake:admin`-only credential |
| 2. Enumeration resistance | ✅ PASS (LAN) — throttled-admin-view sub-item still deferred |
| 3. CSRF / no state-changing GET | ✅ PASS (LAN + static review of every GET route) |
| 4. Redaction across the wire | ✅ PASS (real Local→Central promote, `validate-yaml.rb` clean) |
| 5. Idempotency | ✅ PASS (double-promote + lost-response recovery, both branches) |
| 6. Storage + retention | 🟡 OPTIONAL — scripted, dry-run green on the Mac; run on Central only if you want the extra assurance |
| 7. Backup/restore | 🟡 OPTIONAL — same |
| 8. Failure recovery | 🟡 OPTIONAL — needs a ~2-minute chat handshake |

## ⚠️ Read this before doing anything below

**The tester surface is already live and nothing here blocks it.**
`https://192.168.1.140/intake` serves the tester page + all assets over the
Task 6 TLS proxy (verified 2026-07-30: HTML 200, every JS/CSS asset 200), and
the real session → submit → attachment flow works against Central. Testers can
start now; hand them the URL and their access codes.

The only tester-facing friction is the certificate interstitial (Caddy's
internal CA isn't trusted on tester machines): either have them click
"Advanced → Proceed", or install the root CA once per machine
(README-tls.md Step 4). Plain HTTP won't work — the session cookie is
`Secure: true`.

Sections 6–7 below exercise host-agnostic logic that already has 12 unit tests
in the passing suite plus green drill runs on the Mac. Treat Round 1 as
**nice-to-have**, whenever it's convenient — not a prerequisite.

---

## ROUND 1 (optional) — run these three commands on the Central host

`git pull` first, then from the **repository root** (the folder containing
`dashboard/`):

```bash
node dashboard/deploy/scripts/drill-storage.js
```

```bash
node dashboard/deploy/scripts/drill-retention.js
```

```bash
node dashboard/deploy/scripts/drill-backup.js
```

All three were developed and verified end-to-end on the Mac first
(6/6, 11/11, 16/16 checks) so they should run clean on the first try.

**What each one proves**

- `drill-storage.js` (section 6a) — boots a temp instance against a scratch
  copy with `INTAKE_STORAGE_HIGH_WATER_BYTES` just above current usage, then
  over real HTTP: upload below the mark → `201`, next upload past the mark →
  `507`, plain structured intake submission still → `201`.
- `drill-retention.js` (section 6b) — seeds a scratch copy with a 120-day-old
  closed intake + attachment, a 30-day-expired session, plus a fresh
  attachment and an active session, runs the real `intake:ops retention`, then
  asserts: old attachment soft-deleted **and** its file removed, expired
  session hard-deleted, fresh attachment + active session untouched,
  structured intake/tester rows never deleted, and both deletions audited.
- `drill-backup.js` (section 7) — runs the real `intake:ops backup` +
  `restore-verify`, restores the snapshot into a scratch dir and checks
  integrity, core tables, row-count fidelity vs live, that all access codes
  and admin credentials are stored as 128-hex scrypt hashes (never raw
  32-hex secrets), manifest shape, and that rotation keeps ≤ 11 snapshots.

**Optional but recommended for `drill-backup.js`** — prove a *known* raw
secret never appears in the snapshot bytes. Pass one of the raw access codes
you minted (on the command line only — do not commit it):

```bash
DRILL_KNOWN_SECRET=<a-raw-access-code> node dashboard/deploy/scripts/drill-backup.js
```

On Windows PowerShell:

```powershell
$env:DRILL_KNOWN_SECRET="<a-raw-access-code>"; node dashboard/deploy/scripts/drill-backup.js; Remove-Item Env:\DRILL_KNOWN_SECRET
```

### What to paste back

Copy the **entire console output** of each command into
`phase-b-results.md` under `## Round 1 results`, then commit + push from the
Central host. Include the failing output too if something fails — that is
more useful than a summary.

If a drill exits with code 2 it hit an environment problem (e.g. it could not
find the DB). The most likely cause is `INTAKE_DATA_DIR` living somewhere the
drill did not guess; the drill prints the path it used on the first line, so
paste that and Claude will adjust.

---

## Section 8 (failure recovery) — needs a 2-minute chat handshake

This one genuinely cannot be async: it requires the Central service to be
**down** while a Local-role instance on the Mac calls `/refresh` and
`/promote`, and Claude has to be running the Local instance during that
window.

When you have two spare minutes, say in chat: **"stopping Central now"**.
Claude will spin up the Local instance, and you then:

1. Stop the Central dashboard app (leave Caddy running).
2. Wait for Claude to confirm it captured the `502`s.
3. Start the Central app again.

Claude then verifies the durable cursor resumed with no missed/duplicated
changes. Nothing to prepare in advance.
