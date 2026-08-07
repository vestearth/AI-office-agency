# TASK-EAR-233 — 🔴 Auth OTP: no attempt counter, no resend cooldown

## Type

security

## Priority

high

## Context

Found while scoping the rate-limiting gap that surfaced during TASK-EAR-231. The
operator's starting concern was the *admin* password-reset endpoint, but the
survey found that is **not** the top risk — it requires a valid staff token, so
abusing it means an already-compromised staff account.

The real exposure is the **unauthenticated** auth surface.
`api-gateway/gateway/http.go:108` skips auth for `"/api/v1/auth/"` as a
**prefix**, so the whole player auth surface is open by design.

## What is actually wrong

All verified in source on `origin/staging`.

### 1. OTP brute force is not bounded

`/auth/verify-reset` and `/auth/verify-registration-otp` take a **6-digit** OTP
(`utils/otp.go:11-14`, 10-minute TTL). There is **no attempt counter, no lockout,
and a wrong guess does not invalidate the row** (`authsvc/service.go:709-745`,
`:588-613`). Neither `migrations/007_password_resets.sql` nor
`008_registration_verifications.sql` has an attempts column — confirmed by
reading both.

10⁶ space with unlimited guesses against a live 10-minute window.

### 2. Unlimited sends, each one a real email

`/auth/forgot-password` (`service.go:652-685`) and
`/auth/send-registration-otp` (`service.go:544-584`) send a real email **per
call**, via raw SMTP (`infrastructures/mail_smtp.go`), with no per-email
cooldown. Two consequences:

- Mail-bomb any address whose owner has an account.
- `send-registration-otp` mails **unregistered** addresses, i.e. it can be used
  to send mail to third parties who have no relationship with the platform.

`password_resets` has a UNIQUE index on `email`, so a fresh request also
**overwrites the victim's in-flight reset row** — a nuisance vector on top of the
mail volume.

### 3. Why Cloudflare does not close this

The operator confirmed Cloudflare rate limiting is enabled. That bounds
**volume per IP** and is why the gateway-side limiter rewrite is **dropped from
scope**. It does not fix either problem above:

- The OTP gap is a **logic** defect, not a volume one. An attacker spread across
  many IPs makes few requests each and stays under any per-IP limit while still
  walking the keyspace, because nothing invalidates the OTP on failure.
- A per-email cooldown cannot be expressed as a per-IP rule at all. 100 IPs
  sending one request each at one victim is 100 emails, and every IP looks idle.

## Scope — Games-Labs-Auth only

### Migration

New migration adding to **both** `password_resets` and
`registration_verifications`:

- `attempts INT NOT NULL DEFAULT 0`
- whatever else the chosen design needs

⚠️ **`migrations/run.go` uses `//go:embed *.sql` + `ReadDir` + `Exec` with no
version table** — every file replays on **every boot, forever**. `IF NOT EXISTS`
on the column adds is mandatory, not stylistic. Prove idempotency by running the
real `migrations.Run` more than once, not by eyeballing the SQL.

### Verify path

On a wrong OTP: increment `attempts`; once it reaches the threshold, **invalidate
the OTP** (clear `otp_hash` / the equivalent) so the row can no longer be
guessed. The user must then request a new code, which is itself cooldown-limited
— that composition is why a separate lockout table is not needed.

### Send path

Per-email cooldown on `forgot-password` and `send-registration-otp`: refuse to
send again within the cooldown window for the same address.

### 🔴 The trap that makes this easy to get wrong

`ForgotPassword` deliberately returns `nil` for an unknown email
(`service.go:676`) so an attacker cannot enumerate which addresses have accounts.

**A cooldown must not become that oracle.** If a cooled-down request returns a
different status, message, or even a noticeably different latency from an
unknown-email request, the endpoint starts leaking exactly what the existing code
takes care to hide. The refusal must be **indistinguishable from the normal
response** to the caller. Say explicitly in the PR how you preserved this.

### Suggested defaults — argue if you disagree

- **5** wrong OTP attempts, then invalidate.
- **60s** resend cooldown per email.

Both are proposals, not requirements. What matters is that a legitimate user who
mistypes a few times is not locked out of their account, only slowed — state your
reasoning for whatever you pick.

## Non-negotiables

- **Do not weaken the enumeration protection** (see the trap above).
- Never log or return the OTP, its hash, the reset token, or a password hash.
- Do not touch `.github/workflows/*` — pushes there are rejected for lack of
  `workflow` OAuth scope (has blocked recent work five times).
- Counters live in **Postgres**, which Auth already has. Do **not** introduce
  Redis or any in-process state: Auth runs multiple ECS tasks and in-process
  counters would enforce N× the intended limit and reset on every deploy.

## Acceptance criteria

- Wrong OTP N times invalidates the code; the next guess fails even if correct.
  Test it.
- A correct OTP still works on the first try and after a few failed attempts
  below the threshold — the regression an over-eager counter would cause.
- A second send inside the cooldown does not send mail, **and is
  indistinguishable from both a normal send and an unknown-email request** to the
  caller.
- Migration proven idempotent by running the real `migrations.Run` at least twice
  against a live Postgres. Note Docker has been paused on this machine recently;
  a scratch `brew postgresql@16` on a spare port works, and the scratchpad path
  can exceed Postgres's 103-byte socket limit so put the socket dir elsewhere.
- `GOWORK=off go build -mod=readonly ./... && go vet ./... && go test ./...` green.
- PR base `staging`, do not merge.

## Out of scope — deliberately

- **The gateway rate limiter rewrite.** Cloudflare covers per-IP volume; the
  middleware stays unwired. Its defects are recorded in TASK-EAR-234 for whenever
  someone does wire it.
- **The admin reset endpoint** — staff-gated, and now audited (TASK-EAR-231).
- **`c.ClientIP()` proxy trust** — a real correctness bug, tracked separately in
  TASK-EAR-234; it only matters once something makes an IP-keyed decision.
- Bcrypt CPU-exhaustion and the auth-surface DoS shape generally.
