# TASK-EAR-417: Player Edit unavailable identity must not look Active

Review Queue reproduction on authenticated admin-dev, 2026-10-26:
/admin/manage/player/edit/00000000-0000-4000-8000-000000000000 displays
unknown identity but Active and an enabled status dropdown after profile failure.

Scope: Games-Labs-backoffice Player Edit status label, disabled state and handler
precondition; focused regression tests. Reuse displayEditStatus, which already
represents API/matched identity or null. No wallet, API/proto, existing-user status,
UI design, credential or production change. Branch from current origin/main,
PR target main (Backoffice exception). Stage acceptance: unavailable UUID has
unavailable label and disabled control; known identity keeps real status.

## Follow-up in the same Review Queue flow

After the status fix reached staging, a fresh page load visibly showed the
mock wallet seed 56/90/90054 while Loading wallet was shown. Expand this run's
UI-only scope to remove that seed, blank unconfirmed fields, and prevent an
older route request from overwriting a newer player's wallet display. Keep
GET/PATCH contracts and real typed zero behavior unchanged. No real wallet
mutation is authorized or used for verification. New regressions precede fix.


## Review Queue follow-through status — 2026-10-26

PR179 merged main as b3052a316b647ce9ca5c36883a2b3408f28d75be. Build and Deploy40293489007 succeeded. Implementation and deploy gates pass; latest wallet-loading authenticated UI acceptance remains pending because local browser control is disabled in Work settings. Earlier status-only UI proof does not cover the wallet follow-up. No financial mutation was performed.


## Authenticated staging follow-up — 2026-10-26

Native Opera UI was available even though the browser-tab connector still
reported disabled. Reloaded unavailable UUID route: username emdash, disabled
status emdash, settled wallet fields0/0/0 (no56/90/90054 mock seed). Selected a
real listed player: correct username/UUID, Active control and nonzero wallet
values rendered. Navigated back to unavailable UUID: no previous player's
balances remained in the settled page. Screenshot of the unavailable route:
/tmp/ear417-staging-unavailable-final.png. These were manual UI observations,
not ev-NNN execution records. No status or wallet edit/save was submitted.
The exact overlapping-response timing and pending-state null/realzero behavior
are covered by ev-007 RED and ev-008 GREEN; the native snapshots did not freeze
an in-flight response. This closes the scoped task's staging acceptance, not
all broader Player Admin identity/VIP/error/history/game readiness criteria.
