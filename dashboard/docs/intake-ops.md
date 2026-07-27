# Intake Board — Operations Guide

Operator reference for the Intake Board: testers submit structured bug/work
reports via an access code, AI pre-triages, and the owner promotes approved
intakes into tracked `TASK-` runs. Lives inside this dashboard —
`server/` (Express + TypeScript + better-sqlite3 WAL) and `client/`
(React + Vite, tester page at `/intake`).

Milestones **M1** (schema + admin API), **M2** (Local promotion workflow),
**M3 Phase A** (LAN hardening + ops CLI), and **M4** (tester submission UI) are
on `main`. **M3 Phase B** (TLS reverse proxy + cross-machine Local↔Central) is
not yet done — it needs the office LAN (Central = `192.168.1.140`).

## Ops CLI

Run from `dashboard/server/`. **The `--` separator is required** — without it
npm does not forward the flags to the script.

```bash
npm run intake:ops -- <command> [flags]
```

| Command | Purpose | Flags |
|---|---|---|
| `provision-admin` | Create a hashed admin credential (secret shown once) | `--label <l> --caps <c1,c2>` |
| `issue-code` | Mint a tester access code (code shown once) | `--label <l>` |
| `list-codes` | List testers + their access-code status | — |
| `revoke-code` | Revoke a tester and all its codes | `--tester <testerId>` |
| `retention` | Delete expired attachments/sessions | — |
| `backup` | Online, WAL-consistent SQLite snapshot + manifest | — |
| `restore-verify` | Check a snapshot restores/integrity-checks | `<snapshotPath>` |

### Tester access codes

Access codes are **system-generated random 32-hex tokens**, never chosen by
hand, and are stored only as a salted hash — the raw code cannot be recovered
after issuance. `list-codes` therefore reports *how many* working codes a tester
has, not the code itself. If a code is lost, revoke the tester and issue a new
one.

```bash
# Mint a code for a tester
npm run intake:ops -- issue-code --label "QA A"
#   Issued access code for tester TSTR-4a07cf21e0d52a7133 (label: QA A)
#   Code (shown once, give it to the tester): 8f160dd70be45929f2c25a1ce1c3f8c4

# See who has a working code
npm run intake:ops -- list-codes
#   testerId                 label   activeCodes  status   created
#   TSTR-31107e5b76ccf00e01  QA B    1            active   2026-07-24T20:40:07.948Z
#   TSTR-4a07cf21e0d52a7133  QA A    0            revoked  2026-07-24T20:40:07.480Z

# Revoke a tester (revokes all its codes too)
npm run intake:ops -- revoke-code --tester TSTR-4a07cf21e0d52a7133
```

`status` is `active` (has ≥1 valid code), `revoked` (tester revoked), or
`no-code` (tester exists but every code is revoked).

The CLI writes to the same SQLite database the running server reads
(`INTAKE_DATA_DIR`, default `./intake-data`), so a code issued while the server
is up is usable immediately — no restart needed.

## Quick start: get a tester into `/intake` locally

```bash
# 1. start the API (from dashboard/server)
npm start                         # :4310

# 2. start the client (from dashboard/client)
npm run dev                       # :3000, proxies /api → :4310

# 3. mint a code
npm run intake:ops -- issue-code --label "QA A"

# 4. open http://localhost:3000/intake and paste the code
```

To verify a code end-to-end without the browser (mimics the UI's code exchange):

```bash
curl -i -X POST http://localhost:4310/api/intake/session \
  -H "Content-Type: application/json" -H "Sec-Fetch-Site: same-origin" \
  -d '{"code":"<the 32-hex code>"}'
# → 200 OK, Set-Cookie: intake_sid=… (Secure/HttpOnly/SameSite=Strict), {"csrfToken":"…","expiresAt":…}
```

The product dropdown is populated from `INTAKE_PRODUCT_LIST` (see below). With it
unset, the form offers only "Other/not sure", which submits an empty
`productHint` — the form still works.

## Admin credentials and capabilities

Admin routes (`/api/intake/admin/*`, changes feed, claim, triage, promotion) are
guarded by a **hashed admin credential** sent as `Authorization: Bearer <secret>`
— not the dashboard's shared bearer token. Each route requires exactly one
capability:

| Capability | Grants |
|---|---|
| `intake:read` | `GET /api/intake/changes` (Local pulls the change feed) |
| `intake:claim` | claim / renew / release an intake |
| `intake:triage` | submit a triage result |
| `intake:promote` | promote an intake into a `TASK-` run |
| `intake:admin` | `/api/intake/admin/*` (issue/revoke codes) + the Local `/api/local/*` surface |

Provision two credentials for a real deployment:

```bash
# Local machine's Central credential — needs the FULL working set, NOT just intake:admin
npm run intake:ops -- provision-admin --label local-central \
  --caps intake:read,intake:claim,intake:triage,intake:promote

# Owner's Local admin-surface credential
npm run intake:ops -- provision-admin --label owner-admin --caps intake:admin
```

> **Footgun:** provisioning the Local machine's Central credential as only
> `intake:admin` makes refresh/claim/triage/promote **silently 403**. It needs
> `intake:read,intake:claim,intake:triage,intake:promote`.

With `INTAKE_ADMIN_AUTH_MODE=required` (the default) admin routes hard-fail
`503 admin auth not provisioned` until at least one credential exists — they
never fall open. `disabled` skips admin auth entirely and is for local dev/tests
**only**; never set it on a LAN deployment.

Codes can also be minted over HTTP (equivalent to `issue-code`), which is how the
Local side would do it remotely:

```bash
curl -X POST http://localhost:4310/api/intake/admin/codes \
  -H "Authorization: Bearer <intake:admin secret>" \
  -H "Content-Type: application/json" \
  -d '{"label":"QA A"}'
# → {"testerId":"TSTR-…","code":"f420…"}   (raw code shown once)
```

## HTTP surface

**Tester** (access-code session cookie + `X-CSRF-Token` on unsafe methods):

| Method + path | Purpose |
|---|---|
| `POST /api/intake/session` | Exchange access code → session cookie + CSRF token |
| `DELETE /api/intake/session` | Log out (CSRF-guarded) |
| `GET /api/intake/products` | Product options for the form |
| `POST /api/intake/intakes` | Submit an intake |
| `GET /api/intake/intakes` | List the caller's own intakes |
| `GET /api/intake/intakes/:id` | Detail of one of the caller's intakes |
| `POST /api/intake/intakes/:id/attachments` | Attach a file |

Every tester response is built through the `toTesterIntake` allowlist projection
(never a raw row), and `displayStatus` is derived server-side and fail-closed —
testers never see internal state values.

**Admin / Local** (`Authorization: Bearer <secret>`, capability-gated):

| Method + path | Capability |
|---|---|
| `POST /api/intake/admin/codes` | `intake:admin` |
| `DELETE /api/intake/admin/codes/:testerId` | `intake:admin` |
| `GET /api/intake/admin/intakes/:id` | `intake:read` |
| `GET /api/intake/changes` | `intake:read` |
| `POST /api/intake/intakes/:id/claim` (+ renew/release) | `intake:claim` |
| `POST /api/intake/intakes/:id/triage` | `intake:triage` |
| `POST /api/intake/intakes/:id/promotion` | `intake:promote` |

## Environment

Defaults live in `server/.env.example`. The ones that matter most for ops:

| Var | Default | Notes |
|---|---|---|
| `INTAKE_DATA_DIR` | `./intake-data` | SQLite DB + attachments. CLI and server must agree on this to share data. |
| `INTAKE_ADMIN_AUTH_MODE` | `required` | `disabled` = local dev/tests only, never on LAN. |
| `INTAKE_PRODUCT_LIST` | `[]` | JSON `[{value,label}]` product options. "Other" always sends an empty `productHint`. |
| `INTAKE_ROLE` | `both` | `local`/`both` mounts the `/api/local/*` promotion surface. |
| `DASHBOARD_CLIENT_DIST_DIR` | unset | Built client dir; when set the server serves `/intake` same-origin (production). Leave unset in dev (Vite serves it). |
| `INTAKE_BACKUP_TARGET` | `<data>/backups` | Point outside the repo and the live data dir for real backups. |

Backups snapshot the SQLite DB only — attachment BLOBs are not copied by
`intake:ops backup`; replicate the attachment dir separately.

## Housekeeping

```bash
npm run intake:ops -- backup                       # snapshot before risky changes
npm run intake:ops -- restore-verify <snapshot>    # confirm a snapshot is restorable
npm run intake:ops -- retention                    # drop expired sessions/attachments
```
