# TASK-EAR-360 — Apply latest XPINEXT assets to Auth email templates

## Type

email-template follow-up

## Parent

- Parent: TASK-EAR-355 and TASK-EAR-356
- Related asset source: TASK-EAR-359 (latest supplied banner)

## Goal

Use the latest supplied XPINEXT banner and Google Play badge as CID inline
assets in the responsive Auth password and account-status emails, and migrate
the separate admin reset-link email to that template without changing its
reset-link semantics.

## Scope

- `Games-Labs-Auth/infrastructures/mail_smtp.go` and its focused tests.
- Embedded banner and badge assets under the existing Auth infrastructure
  ownership boundary.
- Self-service reset OTP, password-changed, suspended, deactivated, and admin
  reset-link messages.

## Acceptance criteria

- Each scoped responsive Auth email uses the latest banner CID and, when a
  configured Play Store URL is safe, the Google Play badge CID.
- The admin reset-link message uses the shared responsive template, retains a
  working safe HTTP(S) reset link, and retains its 15-minute/logout warning.
- The MIME message nests `multipart/alternative` in `multipart/related` and
  includes the referenced inline PNGs.
- Focused Go tests, full Go tests, readonly build, gofmt, and diff checks pass.

## Out of scope

- Registration OTP (currently intentionally text-only), mail delivery,
  mailbox acceptance, configuration changes, deployment, production, and
  `Games-Lab-Android`.
