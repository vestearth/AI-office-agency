# TASK-EAR-106: VIP Level inactive status not honored on front-end + Manage VIP redesign

Bugfix/general/high; `dev`. Repos: `Games-Labs-User` (backend), `Games-Labs-backoffice` (FE). No proto / api-gateway / Missions changes.

## Problem (reported)

Manage > VIP Level > Status set to Inactive in back office does not reach the app: inactive VIP levels are still displayed on the VIP page and users can still upgrade into them. Expected: inactive levels hidden and not upgradeable; a user's own level must not change just because a level's status flipped.

## Root cause (verified in code)

The **write path already works** — status persists correctly (backoffice edit sends `optional bool status`, handler maps `HasStatus`+`Status`, `UpdateLevel` saves it; covered by `level_admin_test.go`). The bug is purely **read / enforcement** in `Games-Labs-User`:

1. Public `ListVipLevels` (`service.go:500`) calls `levelCfg.List()` with **no status filter** → inactive levels shown. The public `VipLevelListItem` has no status field at all.
2. Public `GetVipLevel` (`service.go:538`) returns detail for inactive levels — no status check.
3. Auto-progression `UpdateLevelProgress` (`service.go:264`), called by Missions (`level_service.go:224`) from turnover thresholds, does **not** check status. Missions cannot see status: `LevelProgressConfig` (`clients/user/client.go:106`) carries only `{Level, TurnoverRequired}` — status is dropped at the service boundary. So User is the only place that owns status and must enforce it.
4. Fast-pass `BuyVipLevel` (`service.go:447`) already gates on status. ✅ (keep)

## Decisions (resolved with product/UX)

- **Progression policy = skip-through.** An inactive mid-ladder level is transparent to progression: a user whose turnover reaches an active level above the inactive one advances to it; a user who only reaches the inactive level's threshold stays at the highest active level below it. Privileges of a skipped inactive level are not granted.
- **A user's current level is preserved.** `GetLevelStats` resolves the current level via `GetByLevel` (no status filter), so a user sitting on a now-inactive level keeps their level; it is only hidden from the public list.
- **Inactive is DB-only.** Manual inactive-setting is removed from the back office entirely. Everything created/edited via UI is Active; inactive is set by editing the DB directly. This removes the "where is status set" design blocker.
- **"Default cannot be inactive" is DBA guidance, not code.** Since the API never sets status, no `UpdateLevel` guard is needed; the read layer treats `status` uniformly (no Default/Custom special-casing).
- Admin list keeps showing status as a **read-only badge** so DBA-set inactive is visible; only the public list filters.

## Scope

### Backend — Games-Labs-User
- `ports.ListLevelConfigsFilter`: add `ActiveOnly bool`.
- `repositories/level_config.go` `levelConfigListWhere`: when `ActiveOnly`, append `status <> 'inactive'`. Add repo method `HighestActiveLevelAtMost(ctx, level) (int, error)` → `SELECT level FROM level_configs WHERE level <= $1 AND status <> 'inactive' ORDER BY level DESC LIMIT 1`.
- `ListVipLevels`: pass `ActiveOnly: true` (public only; admin `ListLevelConfigs` unchanged → still returns all).
- `GetVipLevel`: return `LevelConfigNotFound` for inactive levels.
- `UpdateLevelProgress`: clamp the Missions-supplied target to the highest active level ≤ target; grant privileges only for active levels in `(prevLevel, clampedLevel]` (skip inactive).
- Optional hardening: `CreateLevel` force `Type = "Custom"` (like it already forces status active); `UpdateLevel` pin `existing.Type` (Type immutable). Low priority.

### Frontend — Games-Labs-backoffice
- `VipLevelWizard.vue`: remove the Status toggle (Basic Info edit), remove the Reset button, remove the "VIP list" header link (breadcrumb covers back-nav), lock Type to a read-only badge (create = Custom, edit = existing kind), Default-level edit read-only until an Edit button is pressed.
- `useVipLevelAdminList.ts`: **remove the `body.status = payload.status !== 'Inactive'` line (`:63`)** so the FE never sends `status` on save.
- `index.vue`: keep the Status column as a read-only badge.

## CRITICAL gotcha

Removing the Status toggle **without** removing the `body.status` send would make every back-office edit send `status: true`, silently **re-activating** any DB-set inactive level. The FE must send **no** `status` field → backend `req.Status == nil` → `HasStatus = false` → `UpdateLevel` leaves `existing.Status` untouched (`grpc.go:615`, `service.go:811`). Cover with a test.

## Acceptance

- Public `ListVipLevels` excludes inactive; admin `ListLevelConfigs` still returns all (incl. inactive).
- `GetVipLevel` → not-found for inactive; a user's current level still resolves via `GetLevelStats` when that level is inactive.
- Skip-through: with L(n+1) inactive, a user reaching L(n+2)'s turnover advances to L(n+2); a user reaching only L(n+1)'s threshold stays at L(n); L(n+1) privileges not granted.
- `BuyVipLevel` still blocks an inactive next level (unchanged).
- Back office sends no status on create or edit; editing a DB-set inactive level does not re-activate it. Reset + VIP list removed; Type read-only; Default edit read-only until Edit; list status badge read-only.
- Unit tests + backoffice prod-preview smoke (`:3010`) pass; staging gateway smoke for public VIP list/detail confirms inactive is hidden.

## Out of scope

No proto / gRPC / api-gateway / Missions changes. No data migration (inactive is intentional, DB-set). No unrelated wizard redesign beyond the items above. Mobile "ladder gap" rendering (list returns fewer items when a mid-level is hidden) is a note for the mobile team, not this task.
