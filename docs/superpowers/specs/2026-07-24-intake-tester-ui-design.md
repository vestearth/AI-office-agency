# AI Dev Office Intake Board — Tester Submission UI (M4) Design

- Date: 2026-07-24
- Status: Approved design (pre-implementation)
- Builds on: merged M1 (Central foundation), M2 (Local workflow), M3 Phase A (LAN hardening)
- Depends on (for LAN deploy, not for dev): M3 Phase B (TLS reverse proxy)

## Problem

Everything built in M1–M3 is backend API. There is no page for a tester to actually submit an intake — the tester-facing surface (`POST /api/intake/session`, `POST /api/intake/intakes`, attachments) has no human entry point. Without a submission UI, the intake system is unusable by the people it was built for. This design adds the tester submission page (M4) plus the small backend extensions it needs.

## Scope (v1)

**In:** a Central-served tester page — login with an access code, submit a structured intake (with attachments), and see "My Intakes" with friendly status. Backend extensions to capture structured fields. The configured product list.

**Out (deferred):** the owner/admin Local UI for review/claim/triage/promote (owner drives via API/CLI for now); tester notifications/email; editing a submitted intake.

## Architecture (Approach A — separate Vite entry page)

- New Vite entry: `dashboard/client/intake.html` → `src/intake/main.tsx` → `<IntakeApp/>`, rendering the tester flow ONLY (no admin tabs). Added as a second `rollupOptions.input` in `vite.config.ts` (multi-page build). Central serves it at `/intake`.
- Fully isolated from the admin `App.tsx`: no shared routing, no admin bearer token.
- New API client `src/intake/intakeApi.ts`: `fetch` with `credentials:'include'` (the `intake_sid` session cookie is HttpOnly, set by the server) and, on unsafe methods, an `X-CSRF-Token` header whose value comes from the session-exchange response and is held in memory only. It never reads/writes `dashboard_token` or any localStorage, and never puts the access code or CSRF token in localStorage or the URL (Decision #3).
- Reuses `../../shared/types`, `styles/globals.css`, and the existing `Toast` component.

## Backend extensions

### Data model — migration v5 (append-only, idempotent)
Add nullable columns to `intake` via the existing `addColumnIfMissing` helper. `runMigrations` applies only versions not yet recorded in `schema_version` (it does not literally re-run every migration each boot); never edit migrations 1–4, and `addColumnIfMissing` (PRAGMA-guarded) keeps the column-add safe even if a version's body is ever re-executed:
- `severity` TEXT — enum-validated in the store: `blocker | high | medium | low`
- `repro_steps` TEXT
- `expected` TEXT
- `actual` TEXT
- `environment` TEXT (build/version/OS/device)

`body` remains the primary Description (still required, 1..20000). The five new fields are optional and augment it.

### API

**The single tester projection `toTesterIntake` (Central-owned).** Define ONE projection function on Central and use it for EVERY tester-facing response — list GET, detail GET, **and the submit POST 201/200 body**. Today `submitIntake`/`getIntake` return the raw `SELECT *` row (`intakeStore.ts`), and the routes return it verbatim (`routes/intake/intakes.ts`), which leaks `tester_id`, raw `state`, `revision`, `change_seq`, and `idempotency_key`. The projection returns ONLY: `id`, `title`, `productHint`, the tester's own submitted content (`body` + `severity`/`repro`/`expected`/`actual`/`environment`), `createdAt`, and a fail-closed friendly `displayStatus` (derived from the raw `state` server-side — see Redaction). It OMITS `tester_id`, raw `state`, `revision`, `change_seq`, `idempotency_key`, and any triage/promotion data. All three tester responses (`POST /api/intake/intakes`, `GET /api/intake/intakes`, `GET /api/intake/intakes/:id`) pass through `toTesterIntake`, so nothing internal is observable even in devtools. (This is the highest-priority fix — it closes the POST leak Codex found and prevents server/client status-mapping drift.)

- `submitIntake` extended to accept, validate (severity ∈ the enum when present; per-field length caps `[PLAN-ASSUMPTION]`: repro/expected/actual ≤ 8000, environment ≤ 1000), and store the new fields. Backward-compatible at the store layer: all fields optional. The tester ROUTES now return `toTesterIntake(...)` rather than the raw row — a behavior change on the tester surface (no in-repo consumer depends on the raw tester-route body: the admin dashboard client makes no intake calls, and M2 Local reads via the admin changes feed / central client, not the tester GET).
- **Promotion projection is a versioned contract — bump it.** `PromotedProjection` (`promotionProjection.ts`) IS the Decision-#12 allowlist and is versioned `promo.v1`. Adding the five structured fields CHANGES that contract, so: extend the `PromotedProjection` interface + `projectIntakeForPromotion` + `renderTaskMd` + tests, and bump `PROMOTION_PROJECTION_VERSION` to `promo.v2`. The new fields are content, not identity — `assertNoForbiddenFields` and the denylist are unchanged and still guard.
- **New admin detail endpoint for Local (closes an existing M2 gap).** M2's `routes/local/index.ts` expects an intake snapshot "from a prior refresh/detail," but the admin changes feed carries only `intakeId`/state/revision/seq/timestamp and `centralClient` has NO detail method — so structured fields (and title/body) can't reach Local for triage-package building. Add `GET /api/intake/admin/intakes/:id` guarded by capability `intake:read`, returning the FULL intake row (admin sees everything — this is NOT the tester projection), plus a `centralClient.getIntakeDetail(id)` method. Do NOT reuse the raw tester GET for this.
- `GET /api/intake/products` (behind the tester session): returns the configured product list for the dropdown, read from `INTAKE_PRODUCT_LIST` on Central and parsed with validation (`INTAKE_PRODUCT_LIST` does not yet exist in `config.ts` — add it as a validated `{value,label}[]` parse that fails closed to `[]` on malformed JSON, mirroring `parseRepoAllowlist`). `[PLAN-ASSUMPTION]` empty default. Selecting "Other / not sure" sends an empty `product_hint` → triage stops at `needs_scope_review` (correct — a human sets scope).

## Tester flow (uses the existing M1 auth backend)

1. Open `/intake` → code-entry screen.
2. On load, try `GET /api/intake/session`. A valid cookie returns `{csrfToken, expiresAt, testerLabel}` and resumes the form without another code prompt. Otherwise, enter the reusable-until-revoked access code → `POST /api/intake/session {code}` (rate-limited). Success → the server sets the `intake_sid` cookie (Secure/HttpOnly/SameSite=Strict) and returns the same session projection; the client keeps `csrfToken` in memory. 401 → generic "invalid code" (no enumeration). 429 → "too many attempts, retry in N".
3. Authenticated → fetch the product list, show the submission form + My Intakes.
4. Submit → `POST /api/intake/intakes` with `X-CSRF-Token` + `credentials:'include'`. The client generates an `idempotencyKey` (UUID) per submit action so a double-click/retry dedupes server-side on `(tester, idempotency_key)`.
5. Attachments → after the intake exists, `POST /api/intake/intakes/:id/attachments` (raw body, `X-Filename`, `X-CSRF-Token`); per-file progress + error handling.
6. My Intakes → `GET /api/intake/intakes` → the tester's own intakes (via `toTesterIntake`).
7. Logout → `DELETE /api/intake/session` — this is a state-changing method, so it MUST carry `X-CSRF-Token` + pass the Origin/Fetch-Metadata CSRF checks (M1's logout route is currently session-guarded but not CSRF-guarded; add CSRF to it). Only session CREATION (`POST /session`, pre-token) is the deliberate CSRF exception.

## UI

- **Screen 1 — Code entry:** one input + submit; error / rate-limit messaging.
- **Screen 2 — Authenticated (two areas):**
  - **New Intake form:** Title (required), Product (dropdown from the configured list + an "Other / not sure" option that sends an EMPTY `product_hint` — v1 has NO free-text product entry, so the UI matches the API and triage fail-closes to `needs_scope_review`), Severity (dropdown), Description (textarea, required), a collapsible "More details" section (Steps to reproduce / Expected / Actual / Environment — optional), Attachments (file picker; PNG/JPEG/WebP/TXT/LOG ≤5 MB; client-side type/size shown as a hint), Submit.
  - **My Intakes list:** the tester's intakes — title, product, submitted date, friendly status. Selecting one shows the tester's own submitted content + status.
- Reuse the dark theme, but a cleaner, form-focused layout (not the dense admin dashboard). `Toast` for feedback.

## Redaction on the tester surface (mirrors Decision #12)

The tester sees ONLY their own submission and a friendly status. Internal state → label mapping:

| internal state | tester sees |
|---|---|
| submitted | Submitted |
| triaged, decided | In review |
| needs_scope_review, ai_failed | In review |
| promoted | Accepted — being worked on |
| closed | Closed |

The tester **never** sees: triage details/summary, risk flags, duplicate candidates, the assigned owner, AI success/failure, or the internal `TASK-<PREFIX>-NNN` id.

**Map server-side, not in the UI.** The state→`displayStatus` mapping lives ONLY on Central (inside `toTesterIntake` — see API) and is fail-closed (any unknown/unmapped state → "In review", never a raw string or "unknown"). The raw internal state strings (`ai_failed`, `needs_scope_review`, etc.) never reach the tester's browser at all — the client consumes `displayStatus` and does NOT contain a status-mapping table. This closes the drift risk (one mapping, server-owned) and is exercised by the exhaustive server-side mapping test.

## Error & security handling

- CSRF token in memory only; sent on every unsafe method. A 403 on CSRF (e.g., session rotated) → prompt re-login.
- Session expiry (7 days) → any call 401s → bounce to the code-entry screen.
- 429 → friendly "please wait" using `Retry-After`.
- Attachment errors → 413 (too large) / 415 (bad type) / 409 (too many / aggregate) → friendly messages; the client check is a hint, the server content-sniff is authoritative.
- Never store the access code or CSRF token in localStorage or the URL (Decision #3).
- **Same-origin serving.** The tester page and the API must be same-origin so the CSRF Origin check (which compares literally against `DASHBOARD_ALLOWED_ORIGINS`) passes and the session cookie is sent. Central currently has no static-file / `/intake` serving code (`server/src/index.ts`) — add serving of the built `intake.html` + its assets, and the tester surface's public origin MUST be in `DASHBOARD_ALLOWED_ORIGINS` (dev: `http://localhost:3000` via the Vite proxy; prod: the internal HTTPS hostname). In dev the Vite proxy already forwards `/api` to :4310, keeping the browser same-origin.
- LAN deploy requires TLS in front (M3 Phase B) for the `Secure` cookie to be sent; **dev on `http://localhost` works** (browsers treat localhost as a secure context). (Not verified by a browser test yet — confirm during browser verification.)

## Testing

- **Backend (full node:test):**
  - migration v5 re-run idempotency (calling `runMigrations` repeatedly on one handle does not throw; the new columns exist);
  - `submitIntake` new-field validation/storage + severity enum + backward-compat when fields absent;
  - **`toTesterIntake` across all three responses** — assert `POST /api/intake/intakes`, `GET /api/intake/intakes`, and `GET /api/intake/intakes/:id` each return ONLY the allowed keys and that `tester_id`, raw `state`, `revision`, `change_seq`, `idempotency_key`, and every raw internal state string are ABSENT from each response body (the POST assertion is the one that catches the leak Codex found);
  - the server-side status→`displayStatus` mapping is exhaustive and fail-closed (every intake state maps; an unknown state → "In review");
  - `GET /api/intake/products` (returns the parsed list; malformed `INTAKE_PRODUCT_LIST` → `[]`, no throw);
  - the new admin detail endpoint `GET /api/intake/admin/intakes/:id` requires `intake:read` and returns the full row (admin sees everything);
  - promotion projection includes the five new fields, bumps to `promo.v2`, AND `assertNoForbiddenFields` still passes (no identity leak);
  - logout `DELETE /session` now requires CSRF (rejected without the token/Origin).
- **Frontend:** the client has no React component test harness today (only pure-function `node:test`). To avoid scope creep, unit-test the pure logic with `node:test` in the existing style — the idempotency-key generation and the `intakeApi` request shaping (correct method/path/`X-CSRF-Token`/`credentials:'include'`, and that unsafe methods carry the CSRF header). The client has NO status-mapping table to test — it consumes the server's `displayStatus`. Verify the rendered end-to-end flow (open `/intake`, exchange a code, submit, attach, check My Intakes, confirm no internal fields in the network responses or devtools) via the in-app browser preview tools. Do NOT add jest/vitest/testing-library to the client in v1.

## Build order (for the implementation plan)

Backend-first (like M2), so the frontend builds against a settled contract:
1. Migration v5 + `submitIntake` new fields + validation.
2. The single `toTesterIntake` projection + server-side fail-closed `displayStatus` mapping; wire it into the POST + both GETs; add CSRF to logout.
3. `GET /api/intake/products` (+ validated `INTAKE_PRODUCT_LIST` config) and the admin detail endpoint `GET /api/intake/admin/intakes/:id` (+ `centralClient.getIntakeDetail`).
4. Promotion projection → `promo.v2` (interface + projector + `renderTaskMd` + tests).
5. Central static serving of the built `/intake` page + `DASHBOARD_ALLOWED_ORIGINS` for the tester origin.
6. Frontend: the Vite intake entry + `intakeApi` (cookie + CSRF) + `IntakeApp` (code entry → form → My Intakes) + pure-logic tests.
7. Browser verification of the full flow on localhost (code exchange → submit + attach → My Intakes; confirm no internal fields in any response).

## Open assumptions (owner may override without reopening the design)

- `[PLAN-ASSUMPTION]` severity values `blocker|high|medium|low`; field length caps; `INTAKE_PRODUCT_LIST` as a JSON `{value,label}[]`; the `/intake` path. None affect the architecture.
