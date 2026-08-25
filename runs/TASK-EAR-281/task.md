# TASK-EAR-281 — Admin player password-reset link and global logout

## Type

security / feature

## Priority

high

## Reference

Follow-on to `TASK-EAR-131`.

`TASK-EAR-131` remains the reference for the existing admin reset endpoint and
for the future SMS delivery channel. SMS remains disabled in this task; do not
enable it or change its behavior.

## Goal

When a Backoffice admin resets a player's password via the **Email** channel,
send a usable, short-lived password-reset link and revoke every active player
session. The player must be able to set a new password from the link without
an OTP-only dead end.

## In Scope

- `Games-Labs-Auth`
  - Preserve `AdminSendPasswordReset` and its staff authorization.
  - Issue a hashed, 15-minute, single-use reset token for the admin Email flow.
  - Revoke all access and refresh sessions for the target player.
  - Send an HTML password-reset email containing the reset link.
  - Revoke sessions before SMTP delivery; make SMTP failure behavior explicit
    and retain no usable reset record if delivery fails.
- `api-gateway`
  - Serve a public reset-password page which accepts the token from a URL
    fragment and submits the new password to the existing
    `POST /api/v1/auth/reset-password` contract.
  - Ensure the token is not sent in the HTTP URL query, retained in browser
    history, or leaked through referrers.
- `Games-Labs-backoffice`
  - Change only the Email reset copy/feedback to explain reset-link delivery
    and logout on every device.
- `shared-lib`
  - Update the canonical admin-auth proto/generated Swagger documentation so it
    no longer describes the admin Email path as an OTP flow.

## Out of Scope

- Enabling SMS reset delivery, changing the disabled SMS control, or adding an
  SMS provider.
- Changing the Mobile self-service OTP reset flow.
- Changing the existing request/response shape of
  `POST /api/v1/admin/auth/password-reset` or
  `POST /api/v1/auth/reset-password`.
- Deployment, staging mutations, or production rollout without separate
  authorization. Commit and draft-PR authorization was granted on 2026-08-20.

## Acceptance Criteria

1. An authorized admin Email reset creates a reset link that works with the
   existing reset-password API; the token expires after 15 minutes and cannot
   be reused after a successful reset.
2. The reset operation revokes all target-user sessions, invalidating both
   access-token and refresh-token use across devices.
3. The token is stored only as a hash and is sent in an email-link fragment,
   never an HTTP query string, referrer, log, API response, or audit event.
4. The public Gateway reset page has no-store/referrer-protection headers,
   validates matching passwords, and removes the fragment from the address bar
   after reading it.
5. Backoffice Email-channel confirmation and success copy says reset link and
   logout on every device. The SMS option remains disabled.
6. Focused regression tests cover link construction, session revocation,
   untrusted host rejection, and the Gateway reset page. `GOWORK=off go test
   ./...` and `go build -mod=readonly ./...` pass for Auth and Gateway;
   Backoffice targeted test and production build pass.
7. Shared-lib proto/generated adminauth documentation states the new Email-link
   behavior and keeps SMS marked unavailable.

## Risks / Dependencies

- A reset-link host must be an approved Games Labs domain; do not trust a
  caller-provided forwarded host outside that allowlist.
- Email delivery and authenticated staging acceptance require a later
  environment check; source tests do not prove SMTP or deployment behavior.
- `api-gateway` must be moved off its unrelated payment-status branch before a
  PR is prepared.

## Draft PRs

- Games-Labs-Auth: https://github.com/SparqLab/Games-Labs-Auth/pull/8
  (`staging`, commit `099fc53`)
- api-gateway: https://github.com/SparqLab/api-gateway/pull/51
  (`staging`, commit `d5ad1f6`)
- Games-Labs-backoffice: https://github.com/SparqLab/Games-Labs-backoffice/pull/102
  (`main`, commit `4bd5fd2`)
- shared-lib: https://github.com/SparqLab/shared-lib/pull/52
  (`main`, commit `cd395f8`)

All four PRs are merged. Source verification passed; deployment, live SMTP
delivery, and authenticated staging acceptance remain unverified.
