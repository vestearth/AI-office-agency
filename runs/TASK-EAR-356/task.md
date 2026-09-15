# TASK-EAR-356 — Account status email notification boundary

## Type

architecture decision / feature intake

## Goal

Implement the supplied XPINEXT email UI for account suspension and account
deactivation after an admin changes player status, without duplicating
monitoring rows or misreporting a completed status mutation.

## Confirmed source ownership

- `Games-Labs-User` owns `users.status` and the admin `UpdateUserStatus` flow.
- `Games-Labs-Auth` owns the configured SMTP transport and password email UI.
- Admin status changes publish `admin.action`; User deliberately does not emit
  `player.activity` for that path because Logs would show a duplicate row.
- Games-Labs-User currently has no SMTP config, mailer, or GitHub Actions SMTP
  secrets. Auth has all five SMTP secrets and deployment wiring.

## Recommended boundary

Use a dedicated durable RabbitMQ account-notification event:

1. User commits `suspended` or `deactivated`;
2. User publishes a non-PII event containing event id, user id, status,
   occurrence time, and source service only;
3. Auth consumes the dedicated queue, resolves the current recipient and
   username by user id, verifies the current status still matches the event,
   and sends the matching responsive email with dedupe/retry/DLQ behavior.

This keeps status ownership in User, mail delivery and credentials in Auth,
and avoids adding SMTP credentials to another service. It requires a canonical
shared-lib event type to be published before downstream User/Auth work.

## Alternative

Add a second SMTP transport and five SMTP secrets to Games-Labs-User, then send
best-effort after status commit. This is smaller in code/repositories but
duplicates transport/configuration and expands credential exposure.

## Locked product interpretation

- `suspended` uses the Account Suspended template.
- `deactivated` uses the screenshot labelled Account Deleted (Deactivated),
  whose actual body says the account was deactivated.
- `deleted` / `pending_deletion` is excluded: it has restoration/grace-period
  semantics and must not receive deactivation wording.
- Username is used instead of first/last name, with `Customer` fallback.
- Status mutation success must not be rolled back or reported failed because
  notification delivery fails.

## Approved decision

The operator continued with the recommended shared event → Auth consumer
boundary. The canonical event contract is ready in shared-lib PR #78 at commit
`58d8a1a`, merged as `cb776ca` and published as
`v0.0.0-20260914082431-cb776ca21368`. User publisher and Auth consumer/UI are
implemented; Auth delivery remains stacked on the unmerged TASK-EAR-355 PR #14.

## Out of scope

- New SMTP credentials in User, deployment, real email send, and Android changes.
