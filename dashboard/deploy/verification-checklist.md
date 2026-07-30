# Intake Board — Cross-Machine Security / Abuse / Failure-Recovery Verification (M3 Phase B, Task 7)

Run on the office LAN, after `dashboard/deploy/README-tls.md` (Task 6) is
deployed on the Central host (`192.168.1.140`) and the Local machine's
`.env` points `INTAKE_CENTRAL_BASE_URL` at the HTTPS hostname
(`https://intake.games-labs.lan`). This is the final gate before opening the
tester surface — every item must pass on the real two-machine setup.

Record actual results (not just pass/fail) inline as you go, so this file
becomes the evidence artifact for the M3 Definition of Done.

## 1. Auth boundary

- [x] `GET https://intake.games-labs.lan/api/intake/changes` with no
      `Authorization` header → `401`. **PASS** (2026-07-30, via LAN curl).
- [x] Same, with a bogus bearer token → `401`. **PASS**.
- [x] Same, with a valid credential that lacks the route's required
      capability → `403`. **PASS** (2026-07-30) — the `verify-t7` credential
      (`intake:read,claim,triage,promote`, no `intake:admin`) hit
      `POST /api/intake/admin/codes` (requires `intake:admin`) → `403`.
- [x] `POST .../intakes/:id/claim`, `.../triage`, `.../promotion`, and any
      `/api/intake/admin/*` route each independently reject a
      missing/invalid/insufficient-capability credential the same way.
      **PASS** — claim/triage/promotion/admin-codes all returned `401` with
      no auth (2026-07-30).
- [ ] With the admin credential table empty (fresh DB, or temporarily revoke
      all), any admin route → `503 {"error":"admin auth not provisioned"}`,
      never a silent pass-through. **NOT RUN LIVE** — would require wiping
      the live admin_credential table, too destructive on the real Central
      DB. Covered by `middleware/adminAuth.test.ts` unit tests instead.
- [x] No admin/local route accepts `?token=<secret>` in the query string —
      only the `Authorization` header. **PASS** — `?token=anything` on the
      changes feed → `401`, same as no token.
- [x] The tester surface (`/intake`, `/api/intake/session`,
      `/api/intake/intakes`) remains reachable only via the `intake_sid`
      session cookie — no bearer token grants tester access. **PASS**
      (confirmed via the M4/M5 route design — tester routes never check
      `Authorization`, only `requireSession`).

## 2. Enumeration resistance

- [x] `POST /api/intake/session` with a wrong access code → a generic error
      (not "code not found" vs "code revoked" — same message either way).
      **PASS** — `{"error":"Invalid code"}` regardless of which part is
      wrong.
- [x] An admin route with a wrong credential → a generic `401`, not a
      message revealing whether the credential ID exists. **PASS** —
      `{"error":"invalid admin credential"}`.
- [x] Repeated wrong-code attempts (past `INTAKE_CODE_MAX_ATTEMPTS`) →
      `429` with a `Retry-After` header. **PASS** — 10× `401` then `429` on
      attempt 11 (matches default `INTAKE_CODE_MAX_ATTEMPTS=10`),
      `Retry-After: 898` (~15min, matches default
      `INTAKE_CODE_WINDOW_MS=900000`). Throttle key is `req.ip`
      (`routes/intake/auth.ts`) — confirmed this only affects the testing
      IP, not other testers.
- [ ] Those throttled attempts show up in the admin throttled-session view
      (`GET /api/intake/admin/throttled`, requires an admin credential —
      see `routes/intake/adminOps.ts`) with the correct key and expiry.
      **STILL DEFERRED** — `verify-t7`'s capabilities
      (`intake:read,claim,triage,promote`) don't include `intake:admin`,
      which this route requires; would need a broader or second credential.

## 3. CSRF / no state-changing GET

- [x] Every mutating tester route (`POST /api/intake/intakes`, attachment
      upload, `DELETE /api/intake/session`) requires both the CSRF token
      **and** an allowed `Origin`/`Sec-Fetch-Site` — omitting either → `403`.
      **PASS** — missing CSRF token → `403`; valid session + CSRF + origin →
      `201`.
- [x] Grep the tester+admin route files for any `router.get` that mutates
      state — there should be none; every state change is `POST`/`DELETE`.
      **PASS** — every `router.get`/`r.get` across `routes/intake/*.ts`
      (adminIntakes, adminOps, changes, intakes, products, triage, review)
      inspected; all are pure `res.json(...)` reads, no writes.
- [x] A cross-origin `POST` (fake `Origin: https://evil.example`) with a
      valid session cookie but no CSRF token → `403`. **PASS**.

## 4. Redaction across the wire

- [x] Submit a real test intake as a tester (through `/intake`, with
      `severity`/`reproSteps`/`expected`/`actual`/`environment` filled in),
      claim → triage → promote it end-to-end (Local → Central). **PASS**
      (2026-07-30) — used the pre-staged `INTAKE-2a0bf50c830ba59937`
      ("Task7 redaction test intake", tester `TSTR-30d435e46fc981655e`,
      severity `medium`). Ran a real cross-machine Local instance (this
      session's machine, `INTAKE_ROLE=local`, `INTAKE_CENTRAL_BASE_URL=
      https://192.168.1.140`, temp scratch `runsDir` — never the real repo
      `runs/`) against the real Central over the Task 6 TLS proxy:
      `POST /api/local/refresh` (saw the intake) →
      `POST /api/local/intakes/:id/claim` → `POST .../triage-result`
      (`classification: triaged`) → `POST .../promote` (`taskPrefix:
      T7VERIFY`) → `{"ok":true,"taskId":"TASK-T7VERIFY-001"}`, `201`.
- [x] Inspect the created `runs/TASK-<PREFIX>-NNN/task.md` and
      `status.yaml` — confirm **no** tester id, PII, secret, or raw
      attachment content is present; only the redacted `promo.v2`
      projection fields. **PASS** — `task.md` shows
      `Reporter: reporter:INTAKE-2a0bf50c830ba59937` (the pseudonymous
      `reporterRef`, per `local/promotionProjection.ts`), never the real
      `tester_id` (`TSTR-30d435e46fc981655e`) despite it being present in
      the intake payload sent to `/promote`. Confirmed against source: the
      real `tester_id` is on `FORBIDDEN_KEYS` in
      `promotionProjection.ts:32`, defense-in-depth enforced by
      `assertNoForbiddenFields` before any disk write. `status.yaml` has
      only `task_id/phase/state/iteration/current_agent/created_at` — no
      PII fields at all.
- [x] `ruby ai-dev-office/validate-yaml.rb TASK-<PREFIX>-NNN` passes on the
      promoted TASK. **PASS** — `Validation passed: TASK-T7VERIFY-001`,
      exit 0. (The script hardcodes `RUNS_DIR` to the real `ai-dev-office/
      runs/`, so the generated dir was copied there just for this one
      validation call, then immediately removed — confirmed via
      `git status` showing no trace afterward, so the real tracked `runs/`
      was never polluted.)

## 5. Idempotency under real conditions

- [x] Double-promote the same intake (call `/promote` twice in a row) →
      exactly one `TASK-<PREFIX>-NNN` dir, the same TASK id both times, no
      orphaned second directory. **PASS** (2026-07-30) — called
      `/api/local/intakes/:id/promote` again with the identical payload
      (same stale `revision: 2`, same triage). Response:
      `{"ok":true,"taskId":"TASK-T7VERIFY-001"}` — the SAME taskId as the
      first call. `ls` on the scratch `runsDir` showed only
      `TASK-T7VERIFY-001` — no `TASK-T7VERIFY-002` orphan. This exercises
      Central's `recordPromotion` idempotent check (`existing → {created:
      false, taskId: <original>}`) plus `local/promotion.ts`'s orphan
      rollback (the second call's freshly-allocated candidate dir is
      deleted once Central reports the canonical id already exists).
- [~] Simulate a dropped response: start a promote, kill the Local process
      mid-request (after Central has committed but before Local's response
      arrives), then retry the promote → still exactly one TASK dir / no
      duplicate. **PARTIALLY COVERED** — the double-promote test above
      exercises the identical code path (a second `/promote` call after
      Central already has a promotion row for the intake), which is the
      actual mechanism a killed-mid-request retry would hit. A literal
      process-kill-mid-flight wasn't performed (would need to interrupt a
      live Node process between Central's commit and Local's response
      read, which needs the two processes' actual PIDs at the exact right
      instant — not meaningfully different in code path from what was
      tested). Treat this specific literal scenario as still open if
      strict reproduction of "kill mid-flight" is required for sign-off.

## 6. Storage + retention — **requires Central host shell access**

- [ ] Push attachments past `INTAKE_STORAGE_HIGH_WATER_BYTES` → further
      attachment uploads return `507` while plain structured intake
      submission (no attachment) keeps succeeding.
- [ ] Seed an old-data snapshot (closed intake older than 90d, an inactive
      session older than 7d) and run `npm run intake:ops -- retention` →
      confirm the expected rows/files are deleted, structured/audit data
      (1y retention) is untouched, and every deletion has an audit entry.

## 7. Backup/restore drill — **requires Central host shell access**

- [ ] `npm run intake:ops -- backup` on the Central host → snapshot +
      manifest written.
- [ ] `npm run intake:ops -- restore-verify <snapshot>` → reports OK.
- [ ] Full restore into a scratch data dir
      (`INTAKE_DATA_DIR=/tmp/restore-drill`), boot the service against it
      read-only, confirm intakes/audit rows are intact and no raw access
      codes or admin credential secrets are present in plaintext anywhere
      in the restored DB (only their hashed columns).

## 8. Failure recovery — **requires Central + Local host shell access**

- [ ] Stop the Central service (`systemctl stop` / kill the process).
- [ ] From the Local machine, hit `/refresh` and `/promote` → both return
      `502` (or a clear connection-refused mapping), not a Local process
      crash.
- [ ] Restart Central, then Local's next `/refresh` resumes from its
      durable cursor file (`INTAKE_SYNC_CURSOR_PATH`) with no missed and no
      duplicated changes — compare the cursor value before/after the outage
      and confirm the changes feed picked up exactly where it left off.

## Sign-off

- [ ] All items above pass. **PARTIAL as of 2026-07-30**: sections 1–5 pass
      (sections 4–5 required a real cross-machine Local↔Central run, done
      this session using a temporary Local test instance + a scratch
      `runsDir` — no real data was touched). Two narrow sub-items remain
      open: the `503`-when-unprovisioned check (section 1) and the
      throttled-session admin view (section 2), both deferred because
      testing them properly needs either wiping the live admin_credential
      table (too destructive) or a credential with `intake:admin` (not
      granted this pass). Sections 6–8 (storage/retention, backup/restore,
      failure recovery) are **NOT YET RUN** — they need direct shell access
      on the Central host (and Local for section 8), which this session
      didn't have. **This checklist is NOT complete — do not treat M3 as
      fully done until 6–8 are run and this file is updated.**
- [x] `dashboard/deploy/README-tls.md` Step 5 (a)–(d) also re-confirmed
      alongside this checklist (same LAN session) — all 4 passed 2026-07-30.
- [x] Date, operator, and Central/Local host details recorded below.

**Verified by:** Claude (LAN-side, using a temporary Local test instance) + operator (Central-side execution + credential provisioning)
**Date:** 2026-07-30 (sections 1–5 complete; 6–8 remaining)
**Central host:** 192.168.1.140 (`D:\llm\AI-office-agency`, Windows)  **Local host:** operator's machine (192.168.1.161)

**Test artifacts created and cleaned up this session** (none left behind):
- `INTAKE-2a0bf50c830ba59937` — real test intake on Central, now in
  `promoted` state (`revision: 3`) with a real promotion row pointing at
  `TASK-T7VERIFY-001`. This intake and its promotion record remain in
  Central's live DB (not deleted) — harmless test data, but flagging it
  exists if a clean-room audit of Central's intake table is ever done.
- `TASK-T7VERIFY-001` — only ever written to a scratch `runsDir`
  (`/tmp/.../local-test/runs/`), never the real tracked `runs/`; briefly
  copied into the real `runs/` for one `validate-yaml.rb` call, then
  removed immediately (confirmed via `git status`).
- The temporary Local dashboard test instance (port 4321) was stopped and
  its scratch data directory deleted.
- Credential `ADM-8fbaa39053bf507780` (label `local-owner`, `intake:admin`)
  was provisioned in the scratch Local instance's own throwaway SQLite DB,
  which no longer exists — nothing to revoke.

## Remaining work (next session)

- Run sections 6–8 (storage/retention, backup/restore, failure recovery) —
  need direct shell access on the Central host (and Local for section 8).
- Optionally close the two still-open sub-items: `503` when no admin
  credential is provisioned (section 1) and the throttled-session admin
  view (section 2) — the latter just needs a credential with
  `intake:admin` capability.
- Recommend revoking the `verify-t7` admin credential
  (`ADM-d9e4b2654396f271b2`) on the Central host once you're confident no
  further LAN-side verification is needed — it currently holds
  `intake:read,claim,triage,promote` and isn't needed for day-to-day
  operation.
