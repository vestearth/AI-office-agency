# TASK-EAR-282 — Player Audit Log "By Admin" shows raw actorId, not admin name

## Type

bug — investigation complete, ready for implementation (Path A)

## Priority

medium

## Origin

Operator screenshot (2026-08-20), `admin/manage/player/edit/:id` → any tab's
Audit Log modal (confirmed on **Grant Pass**, structurally identical for
Wallet, Security, VIP Level, Missions, Voucher — all six scopes share one
code path). The "By Admin" column renders `f737e6f3-466b-4db5-b86e-
70ac4772b660` instead of the admin's name.

## Goal

Every Audit Log tab's "By Admin" column shows the acting admin's username
(or email), never a raw id — matching how the player's own identity in that
same modal already resolves via TASK-EAR-218.

## Confirmed Root Cause (source-verified, not inferred)

- `Games-Labs-backoffice/app/composables/useAdminPlayerAuditEvents.ts:46`
  documents this as a known, deliberate gap: `byAdmin: item.actorId || '-'`
  for all six live scopes, with the comment *"no actor name/email snapshot
  exists anywhere yet. Never fabricate a display name."*
- The audit event itself never carries more than the id. Example:
  `Games-Labs-Auth/internal/core/handlers/adminauthhdl/audit.go:56` builds
  `events.AdminActionEvent{ActorID: td.UserId, ActorRole: td.Role, ...}` —
  no name/email field exists on the event to set.
- `td` (`shared-lib/pkg/auth/auth.go:24` `TokenData`) — the struct every
  service derives its actor from — carries only
  `UserId, Role, Access, Permissions`. No username/email travels through
  gateway metadata to any publisher.
- Per `knowledge-base/10 Projects/Games Labs Auth/Field Lineage — Accounts
  Staff Permissions Tokens.md` §1: **there is no separate staff table** —
  an admin is a row in Auth's own `users` table with
  `user_roles IN ('admin','superadmin')`. So the admin's username/email is
  not missing data, it is unpropagated data — Auth already has it.

## Decision: Path A — Confirmed Live, 2026-08-20

**Verified against `api-test-gateway.gameslabs.app`** (devtest superadmin
login, per the operator's standing authorization for authenticated smoke —
memory `backoffice-authenticated-smoke`):

- `GET /api/v1/admin/user/f737e6f3-466b-4db5-b86e-70ac4772b660` — the exact
  actorId from the operator's screenshot — returned **HTTP 200**:
  `{"username":"devtest@gmail.com","displayName":"SuperAdmin",
  "email":"devtest@gmail.com",...}`. The same endpoint the page already
  calls for player identity resolves this admin id cleanly. **No backend
  change needed.**
- `GET /api/v1/admin/user/00000000-0000-0000-0000-000000000000` (a
  genuinely nonexistent id) returned **HTTP 200** with
  `{"status":{"code":1000,"description":"user not found"},"user":null}` —
  the miss is an app-level envelope code, not an HTTP 404. **Any resolver
  must check `status.code === 200`, not the transport status.**
- A real audit-events page for a second player (target
  `b137cfb1-3210-408e-b62e-c0464fb753db`, 4 rows spanning
  `user.vip_level.set` / `mission.pass.grant` / `mission.force_complete`)
  was pulled to find a second, different actorId to cross-check. Staging
  currently has only the one active admin account, so all 4 rows carried
  the same already-tested id — the resolver's behavior for a second
  admin/role shape is **not directly evidenced**, only argued from the
  User-service schema (admins are `users` rows, not a separate table, per
  the Field Lineage note below). Re-check this once a second admin account
  exists on staging.

Path B (shared-lib `TokenData` + gateway + every `AdminActionEvent`
publisher) is **ruled out** — it would have been the multi-repo, multi-week
option, and Path A already works.

## Acceptance Criteria — all done, 2026-08-20

1. ~~Path A's viability is checked against a real admin id on a real
   environment before any code is written~~ — **done**, see Decision above.
2. ~~"By Admin" across all six scopes shows a readable admin identity~~ —
   **done**. All six scopes route through the single `fetchAuditPage`, which
   now resolves `byAdmin` via `username || displayName || email` before
   returning rows.
3. ~~A resolver miss renders the existing `'-'` fallback, never a fabricated
   name~~ — **done**, `resolveActorIdentity` treats `status.code !== 200`,
   a null `user`, and a caught network error identically as a miss.
4. ~~Resolution is batched per distinct `actorId` ... cached~~ — **done**,
   `resolveByAdminNames` dedupes via `Set` and `actorIdentityCache` is
   module-scope (shared across scopes, pages, and modal re-opens — not
   re-created per fetch).

**Shipped:** `Games-Labs-backoffice` commit `57fb678`
(`app/composables/useAdminPlayerAuditEvents.ts`), image `sha-57fb678`
pinned in `3d7a64c` for ArgoCD. Verified end-to-end against the running app
(not just source): devtest superadmin login, opened the VIP Level Audit Log
for a player with a real `user.vip_level.set` row, "By Admin" rendered
`devtest@gmail.com`, zero console errors, raw actorId absent from the page.

**Role-agnostic, confirmed at the SQL level (2026-08-20) — the residual gap
above is closed.** Live data only ever showed one superadmin actor, but the
resolved endpoint's own query settles it independent of test data:
`Games-Labs-User/internal/core/repositories/user.go:51-57`
(`GetByID`, which `GetUser`'s handler calls directly) is

```sql
SELECT u.id::text, u.username, u.email, ...
FROM users u
LEFT JOIN auth_devices d ON d.user_id = u.id
WHERE u.id = $1::uuid
  AND u.soft_deleted_at IS NULL
```

No `role`/`user_roles` predicate anywhere in the query — it resolves any row
in `users` regardless of role, which is also exactly why it already resolves
ordinary players (`role='user'`) everywhere else on this page. `admin` and
`superadmin` are equally in scope. Operator asked "does this cover every
tab, not just superadmin" (2026-08-20) — answer: yes, by construction, no
code change needed.

## Out of Scope

- Building a real Security Staff API (`useSecurityStaff.ts` mock backing) —
  tracked separately if it turns out to be a prerequisite for path A.
- Any UI change to the audit table beyond the "By Admin" cell's value.

## Related

- TASK-EAR-218 (this modal's player-identity fix — the pattern this task
  extends to the admin side of the same table)
- `knowledge-base/10 Projects/Games Labs Auth/Field Lineage — Accounts
  Staff Permissions Tokens.md`
