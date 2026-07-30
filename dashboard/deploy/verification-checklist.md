# Intake Board — Cross-Machine Security / Abuse / Failure-Recovery Verification (M3 Phase B, Task 7)

Run on the office LAN, after `dashboard/deploy/README-tls.md` (Task 6) is
deployed on the Central host (`192.168.1.140`) and the Local machine's
`.env` points `INTAKE_CENTRAL_BASE_URL` at the HTTPS hostname
(`https://intake.games-labs.lan`). This is the final gate before opening the
tester surface — every item must pass on the real two-machine setup.

Record actual results (not just pass/fail) inline as you go, so this file
becomes the evidence artifact for the M3 Definition of Done.

## 1. Auth boundary

- [ ] `GET https://intake.games-labs.lan/api/intake/changes` with no
      `Authorization` header → `401`.
- [ ] Same, with a bogus bearer token → `401`.
- [ ] Same, with a valid credential that lacks `intake:read` (provision one
      with only `intake:admin` via `intake:ops provision-admin` to test) →
      `403`.
- [ ] `POST .../intakes/:id/claim`, `.../triage`, `.../promotion`, and any
      `/api/intake/admin/*` route each independently reject a
      missing/invalid/insufficient-capability credential the same way.
- [ ] With the admin credential table empty (fresh DB, or temporarily revoke
      all), any admin route → `503 {"error":"admin auth not provisioned"}`,
      never a silent pass-through.
- [ ] No admin/local route accepts `?token=<secret>` in the query string —
      only the `Authorization` header.
- [ ] The tester surface (`/intake`, `/api/intake/session`,
      `/api/intake/intakes`) remains reachable only via the `intake_sid`
      session cookie — no bearer token grants tester access.

## 2. Enumeration resistance

- [ ] `POST /api/intake/session` with a wrong access code → a generic error
      (not "code not found" vs "code revoked" — same message either way).
- [ ] An admin route with a wrong credential → a generic `401`, not a
      message revealing whether the credential ID exists.
- [ ] Repeated wrong-code attempts (past `INTAKE_CODE_MAX_ATTEMPTS`) →
      `429` with a `Retry-After` header.
- [ ] Those throttled attempts show up in the admin throttled-session view
      (`GET /api/intake/admin/throttled`, requires an admin credential —
      see `routes/intake/adminOps.ts`) with the correct key and expiry.

## 3. CSRF / no state-changing GET

- [ ] Every mutating tester route (`POST /api/intake/intakes`, attachment
      upload, `DELETE /api/intake/session`) requires both the CSRF token
      **and** an allowed `Origin`/`Sec-Fetch-Site` — omitting either → `403`.
- [ ] Grep the tester+admin route files for any `router.get` that mutates
      state — there should be none; every state change is `POST`/`DELETE`.
- [ ] A cross-origin `POST` (fake `Origin: https://evil.example`) with a
      valid session cookie but no CSRF token → `403`.

## 4. Redaction across the wire

- [ ] Submit a real test intake as a tester (through `/intake`, with
      `severity`/`reproSteps`/`expected`/`actual`/`environment` filled in),
      claim → triage → promote it end-to-end (Local → Central).
- [ ] Inspect the created `runs/TASK-<PREFIX>-NNN/task.md` and
      `status.yaml` — confirm **no** tester id, PII, secret, or raw
      attachment content is present; only the redacted `promo.v2`
      projection fields.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-<PREFIX>-NNN` passes on the
      promoted TASK.

## 5. Idempotency under real conditions

- [ ] Double-promote the same intake (call `/promote` twice in a row) →
      exactly one `TASK-<PREFIX>-NNN` dir, the same TASK id both times, no
      orphaned second directory.
- [ ] Simulate a dropped response: start a promote, kill the Local process
      mid-request (after Central has committed but before Local's response
      arrives), then retry the promote → still exactly one TASK dir / no
      duplicate (exercises the M2 lost-response fix on real hardware, not
      just the in-memory test).

## 6. Storage + retention

- [ ] Push attachments past `INTAKE_STORAGE_HIGH_WATER_BYTES` → further
      attachment uploads return `507` while plain structured intake
      submission (no attachment) keeps succeeding.
- [ ] Seed an old-data snapshot (closed intake older than 90d, an inactive
      session older than 7d) and run `npm run intake:ops -- retention` →
      confirm the expected rows/files are deleted, structured/audit data
      (1y retention) is untouched, and every deletion has an audit entry.

## 7. Backup/restore drill

- [ ] `npm run intake:ops -- backup` on the Central host → snapshot +
      manifest written.
- [ ] `npm run intake:ops -- restore-verify <snapshot>` → reports OK.
- [ ] Full restore into a scratch data dir
      (`INTAKE_DATA_DIR=/tmp/restore-drill`), boot the service against it
      read-only, confirm intakes/audit rows are intact and no raw access
      codes or admin credential secrets are present in plaintext anywhere
      in the restored DB (only their hashed columns).

## 8. Failure recovery

- [ ] Stop the Central service (`systemctl stop` / kill the process).
- [ ] From the Local machine, hit `/refresh` and `/promote` → both return
      `502` (or a clear connection-refused mapping), not a Local process
      crash.
- [ ] Restart Central, then Local's next `/refresh` resumes from its
      durable cursor file (`INTAKE_SYNC_CURSOR_PATH`) with no missed and no
      duplicated changes — compare the cursor value before/after the outage
      and confirm the changes feed picked up exactly where it left off.

## Sign-off

- [ ] All items above pass.
- [ ] `dashboard/deploy/README-tls.md` Step 5 (a)–(d) also re-confirmed
      alongside this checklist (same LAN session).
- [ ] Date, operator, and Central/Local host details recorded below.

**Verified by:** _______________  **Date:** _______________
**Central host:** _______________  **Local host:** _______________
