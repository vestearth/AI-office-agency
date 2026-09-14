# TASK-EAR-355 — Auth password email UI templates

## Type

feature / visual follow-up

## Goal

Implement the operator-supplied XPINEXT responsive email UI for the two
password-flow notifications owned by Games-Labs-Auth:

1. self-service password-reset OTP; and
2. password-changed confirmation after a successful reset.

## Locked decisions

- Address the player as `username`; use `Customer` only when username is empty.
- Preserve OTP TTL, cooldown, hashing, reset-session, session revocation,
  password mutation, admin reset-link security, and public API contracts.
- The new password-changed notification is best-effort after the password and
  reset record are committed. SMTP failure must not report that the completed
  password change failed or restore a consumed reset token.
- Reuse one Auth-owned responsive renderer and the existing SMTP mailer; add no
  dependency or general email framework.
- Use table/inline CSS and safe optional brand/footer URLs. Never invent
  production contact values or redraw the XPINEXT logo/social icons.
- Preview with sample data only. Do not send real email, mutate staging,
  deploy, or edit Games-Lab-Android.

## Source evidence

- `Games-Labs-Auth/infrastructures/mail_smtp.go` owns registration OTP,
  password-reset OTP, and admin reset-link SMTP bodies.
- `SendPasswordResetOTP` is currently text-only and receives no username.
- `authsvc.ResetPassword` changes the password, revokes sessions, consumes the
  reset record, and currently sends no password-changed notification.
- `Games-Labs-User` has no SMTP/email port; account status mutation belongs to
  User and is excluded from this Auth task pending a separate ownership plan.

## Acceptance criteria

- Password-reset OTP and password-changed confirmation render the supplied
  XPINEXT visual hierarchy at desktop and 375-390px mobile widths.
- Reset OTP contains the six-digit code and expiry copy; no password, reset
  token, access token, or other secret is logged.
- Successful reset sends a username-addressed confirmation on a best-effort
  basis only after password persistence and reset-record consumption.
- Admin reset-link behavior remains usable and unchanged.
- Focused renderer/service tests, full Go tests, readonly build, diff check,
  and source-rendered desktop/mobile previews pass.

## Out of scope

- Registration OTP UI.
- Account suspended/deactivated/deleted notifications.
- API/protobuf/gateway/backoffice changes.
- Real SMTP/mailbox acceptance and deployment.
