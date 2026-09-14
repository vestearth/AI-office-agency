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
2. User publishes a non-secret event containing user id, username, recipient,
   status, and event id;
3. Auth consumes the dedicated queue and sends the matching responsive email
   best-effort with retry/DLQ behavior defined in the implementation task.

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

## Decision needed

Approve either the recommended shared event → Auth consumer boundary or the
smaller direct SMTP-in-User alternative before implementation begins.

## Out of scope until decision

- Source changes, secrets, deployment, real email send, and Android changes.
