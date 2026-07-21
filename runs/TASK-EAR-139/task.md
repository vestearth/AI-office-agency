# TASK-EAR-139: VIP panel — show real turnover (exp) per design

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-18

## Goal

Follow-up to TASK-EAR-138. That run shipped the Grant/Revoke VIP Level panel
with the turnover line showing '-' (chosen to avoid the public GetLevelStats
IDOR route). The operator confirmed via the Figma design that the turnover
line must show real numbers in the `current / target` format
(design: "Turnover Coin: 555,555/100,000" + a progress bar), not '-'.

`user_profiles.exp` IS the accumulated turnover and is already loaded by
`GetProfile`, but the admin `GetUser` handler (`adminUserItem`) maps only
level/lifetime and **drops exp**. Surface it — no need to touch the public
`GetLevelStats` route (still deferred with the Order IDOR).

## Scope

In:
- shared-lib (`adminuserpb`): add `int64 exp = 13;` to
  `ListUserResponse.AdminListUserItem` (additive field — GetUser + ListUser
  both return this item).
- Games-Labs-User:
  - `adminUserItem` (GetUser path): map `row.Exp = p.Exp` (GetProfile
    already loads it).
  - `ListPlayers` repo query: add `p.exp` to the LEFT JOIN SELECT;
    `AdminPlayerRow.Exp`; `adminPlayerRowItem` sets it — keeps the field
    consistent between GetUser and ListUser (list may surface it later).
- api-gateway: shared-lib bump.
- Games-Labs-backoffice `PlayerVipLevelPanel.vue`: restore the design's
  turnover display with real data —
  - current = the player's `exp` (from GetUser).
  - target = `turnover_required` of the next active level above the current
    level (from the ListLevels catalog already fetched); if the player is at
    the max active level, target = the current level's `turnover_required`.
  - label "Turnover Coin"; `turnoverDisplay = current/target` (localized);
    progress bar = the **existing design logic** the panel had before
    TASK-EAR-138 blanked it: `min(50, round(min(1, current/target) * 100))`
    (the design caps the bar at half-fill — keep it, per
    [[preserve-ux-design-wire-data-only]]).

Out: the public `GetLevelStats` IDOR route (still deferred); any change to
the SetUserVipLevel write path (138, already shipped); showing exp anywhere
else.

## Acceptance criteria

- `GET /api/v1/admin/user/{id}` returns the player's `exp`.
- VIP panel turnover line shows `exp / next-level-threshold` in the design's
  format with the design's (half-capped) progress bar — no '-'.
- Existing GetUser/ListUser consumers unaffected (additive field).
- `go build`/`go test` green in User; backoffice `npm run build` green; PRs
  opened (User+gateway → staging, FE → main).
