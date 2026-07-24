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
Add nullable columns to `intake` via the existing `addColumnIfMissing` helper (never edit migrations 1–4; a raw `ALTER` would break boot-replay):
- `severity` TEXT — enum-validated in the store: `blocker | high | medium | low`
- `repro_steps` TEXT
- `expected` TEXT
- `actual` TEXT
- `environment` TEXT (build/version/OS/device)

`body` remains the primary Description (still required, 1..20000). The five new fields are optional and augment it.

### API
- `submitIntake` extended to accept, validate (severity ∈ the enum when present; per-field length caps `[PLAN-ASSUMPTION]`: repro/expected/actual ≤ 8000, environment ≤ 1000), and store the new fields. Backward-compatible: all fields optional, so existing callers/tests are unaffected.
- Promotion projection (`promotionProjection.ts`, Decision #12) extended so the promoted `task.md` includes repro_steps/expected/actual/environment/severity when present. These are content, not identity — the redaction allowlist/denylist is unchanged; `assertNoForbiddenFields` still guards.
- `GET /api/intake/products` (behind the tester session): returns the configured product list for the dropdown, read from `INTAKE_PRODUCT_LIST` on Central (JSON array of `{value, label}` `[PLAN-ASSUMPTION]`; empty default). Selecting "Other / not sure" sends an empty `product_hint` → triage stops at `needs_scope_review` (correct — a human sets scope).

## Tester flow (uses the existing M1 auth backend)

1. Open `/intake` → code-entry screen.
2. Enter access code → `POST /api/intake/session {code}` (rate-limited). Success → the server sets the `intake_sid` cookie (Secure/HttpOnly/SameSite=Strict) and returns `{csrfToken, expiresAt}`; the client keeps `csrfToken` in memory. 401 → generic "invalid code" (no enumeration). 429 → "too many attempts, retry in N".
3. Authenticated → fetch the product list, show the submission form + My Intakes.
4. Submit → `POST /api/intake/intakes` with `X-CSRF-Token` + `credentials:'include'`. The client generates an `idempotencyKey` (UUID) per submit action so a double-click/retry dedupes server-side on `(tester, idempotency_key)`.
5. Attachments → after the intake exists, `POST /api/intake/intakes/:id/attachments` (raw body, `X-Filename`, `X-CSRF-Token`); per-file progress + error handling.
6. My Intakes → `GET /api/intake/intakes` → the tester's own intakes.
7. Logout → `DELETE /api/intake/session`.

## UI

- **Screen 1 — Code entry:** one input + submit; error / rate-limit messaging.
- **Screen 2 — Authenticated (two areas):**
  - **New Intake form:** Title (required), Product (dropdown + "Other / not sure" → free text), Severity (dropdown), Description (textarea, required), a collapsible "More details" section (Steps to reproduce / Expected / Actual / Environment — optional), Attachments (file picker; PNG/JPEG/WebP/TXT/LOG ≤5 MB; client-side type/size shown as a hint), Submit.
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

**Map server-side, not just in the UI.** The mapping to the friendly label must happen on Central, so the raw internal state strings (`ai_failed`, `needs_scope_review`, etc.) never reach the tester's browser at all. The tester-facing `GET /api/intake/intakes[/:id]` returns a **tester projection** carrying only: `id`, `title`, `productHint`, the tester's own submitted content (body + the structured fields), `createdAt`, and a friendly `displayStatus` — and it OMITS the raw `state`, `revision`, `change_seq`, `tester_id`, and any triage/promotion data. (Today those endpoints return the raw intake row; v1 adds this projection so nothing internal is observable even in devtools.)

## Error & security handling

- CSRF token in memory only; sent on every unsafe method. A 403 on CSRF (e.g., session rotated) → prompt re-login.
- Session expiry (7 days) → any call 401s → bounce to the code-entry screen.
- 429 → friendly "please wait" using `Retry-After`.
- Attachment errors → 413 (too large) / 415 (bad type) / 409 (too many / aggregate) → friendly messages; the client check is a hint, the server content-sniff is authoritative.
- Never store the access code or CSRF token in localStorage or the URL (Decision #3).
- LAN deploy requires TLS in front (M3 Phase B) for the `Secure` cookie to be sent; **dev on `http://localhost` works** (browsers treat localhost as a secure context).

## Testing

- **Backend (full node:test):** migration v5 boot-replay idempotency; `submitIntake` new-field validation/storage + severity enum + backward-compat when fields absent; `GET /api/intake/products`; promotion projection includes the new fields AND `assertNoForbiddenFields` still passes (no identity leak); the tester-facing `GET /api/intake/intakes[/:id]` returns the tester projection ONLY (friendly `displayStatus`, no raw `state`/`revision`/`change_seq`/`tester_id`/triage/promotion fields) — a test must assert the raw internal state strings are absent from the response body.
- **Frontend:** the client has no React component test harness today (only pure-function `node:test`). To avoid scope creep, unit-test the pure logic with `node:test` in the existing style — the status→label mapping, the idempotency-key generation, and the `intakeApi` request shaping (correct method/path/`X-CSRF-Token`/`credentials`). Verify the rendered end-to-end flow (open `/intake`, exchange a code, submit, attach, check My Intakes, confirm no internal fields render) via the in-app browser preview tools. Do NOT add jest/vitest/testing-library to the client in v1.

## Build order (for the implementation plan)

1. Backend: migration v5 + `submitIntake` fields + `GET /api/intake/products` + projection extension + tests (backend-first, like M2).
2. Frontend: the Vite intake entry + `intakeApi` + `IntakeApp` (code entry → form → My Intakes) + pure-logic tests.
3. Browser verification of the full flow on localhost.

## Open assumptions (owner may override without reopening the design)

- `[PLAN-ASSUMPTION]` severity values `blocker|high|medium|low`; field length caps; `INTAKE_PRODUCT_LIST` as a JSON `{value,label}[]`; the `/intake` path. None affect the architecture.
