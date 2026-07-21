# TASK-EAR-138: Player edit — real Grant/Revoke VIP Level (SetUserVipLevel)

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-18

## Goal

`PlayerVipLevelPanel` (the "Grant / Revoke VIP Level" tab on
`admin/manage/player/edit/[id]`) is the last mock action panel on the edit
page: its Save button changes the level locally and shows a success toast
with **no API call**, and it displays mock VIP data. Make it real. Operator
sign-off (2026-07-18): full backend RPC + FE; display the real level,
turnover shows '-' (no admin turnover read).

## Domain facts (corrected 2026-07-18 after operator feedback)

- Levels are a **bounded catalog**: `level_configs` seeds **25 levels**
  ("level N requires N × 10,000 turnover") with a `status` column
  (active/inactive). Real players reach VIP25; VIP26 exists but is
  **inactive** (matches EAR-106 inactive-level masking). So the earlier
  "unbounded 26+" worry was wrong — the range is bounded and the
  privilege-grant loop is at most ~25 iterations.
- **`exp` IS the turnover**: `user_profiles.exp` is the cumulative value;
  `LevelStatsResponse.ExpRequiredForNext = turnover_required` of the next
  level. The panel's "Turnover" = exp. Level and exp are kept in sync by
  the turnover progression.
- The service method exists: `UserService.UpdateLevelProgress(ctx, userID,
  level, exp)` (usersvc/service.go:321) — raising the level runs
  `grantLevelPrivileges` per level (grants avatars etc.), matching "Grant".
  It has **no grpc-gateway HTTP binding** (userpb, gRPC-only) → need a new
  admin RPC to expose it.
- `GetLevel(ctx, level)` returns the `LevelConfig{TurnoverRequired, Status}`
  — use it to (a) validate the target level exists + is active, (b) read
  its `turnover_required`.
- Route `/api/v1/admin/user/{user_id}/vip-level` is a distinct 3-segment
  pattern — no conflict with GetUser `{user_id}` or `{user_id}/status`.

## Corrected set-level semantic

Set exp to the target level's threshold, **NOT 0**: a level is derived from
cumulative turnover crossing `turnover_required`, so
`UpdateLevelProgress(userID, N, turnover_required(N))` puts the player exactly
at the start of level N — level and turnover stay consistent (exp=0 would
leave them level N with 0 turnover, which the progression would recompute
away). Grant (raise) jumps exp up to the threshold + grants privileges;
revoke (lower) sets exp down to the threshold.

## Scope

In:
- shared-lib (`adminuserpb`): `SetUserVipLevel` RPC —
  `PATCH /api/v1/admin/user/{user_id}/vip-level`, body `{level}`, response
  `{status}`. Declared after UpdateUserStatus.
- Games-Labs-User: `adminuserhdl.SetUserVipLevel` handler, staff-gated
  `PERM_USER_MANAGEMENT`. Validate `level >= 1`; `GetLevel(level)` must
  return a config with `status == "active"` (reject inactive like 26 and
  nonexistent levels); then `svc.UpdateLevelProgress(userID, level,
  cfg.TurnoverRequired)`. No new service/repo method needed.
- api-gateway: shared-lib bump.
- Games-Labs-backoffice `PlayerVipLevelPanel.vue`: take `:user-id`
  (currently `:vip` mock); load the real level from GetUser (display +
  stepper initial); bound the stepper max to the highest **active** level
  from `GET /api/v1/admin/levels` (ListLevels) — not the hardcoded 5; Save
  → confirm → PATCH the new route with the stepper level; toast only on
  real result. **Turnover progress shows '-'** (no admin turnover read;
  keep the designed bar, don't fabricate). Edit page passes
  `:user-id="playerId"`. Data-source-only where the design is concerned —
  no structural redesign ([[preserve-ux-design-wire-data-only]]).

Out: admin turnover read (no API; shown as '-'), the GetLevelStats IDOR
(deferred with the Order one), revoking granted privileges on level-down
(existing service behavior — number only), the History/Game Detail slices.

## Acceptance criteria

- `PATCH /api/v1/admin/user/{uuid}/vip-level {level:N}` sets the player's
  level to N (exp 0), staff-gated; raising grants that level's privileges
  via the existing path; GetUser/list reflect the new level.
- `/admin/user/{id}` (GetUser) and `/admin/user/{id}/status` still resolve
  to their own RPCs (route-order check).
- Edit page VIP tab shows the player's real level; Save fires the PATCH and
  reflects the real outcome; turnover shows '-'; no fake-success toast.
- `go build`/`go test` green in User; backoffice `npm run build` green; PRs
  opened (User+gateway → staging, FE → main).
