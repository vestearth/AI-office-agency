# TASK-EAR-143: Detail page — wire Level VIP turnover to real exp

## Type

feature

## Workstream

frontend

## Priority

low

## Created

2026-07-18

## Goal

Follow-on to TASK-EAR-139. That run surfaced `user_profiles.exp` on the admin
`GetUser` response and wired the **edit** page's VIP panel to show real
turnover (`Turnover Coin: current/target` + a true-fill progress bar). The
**Detail** page (`admin/manage/player/Detail/[id]`) has the same "Level VIP"
card, but its turnover (`turnoverCurrent`/`turnoverTarget`/`progress`) still
renders from the mock placeholder — the page's own header comment lists "VIP
turnover" as un-wired. The backend now exists (EAR-139 merged), so wire it.

## Scope

In (Games-Labs-backoffice, FE only):
- `app/pages/admin/manage/player/Detail/[id].vue`, `loadDetailIdentity`:
  - read `exp` from the GetUser response (already fetched there).
  - reuse `useAdminVipLevel().fetchActiveLevels()` for the active level
    catalog (one extra GET /admin/levels), fetched in parallel with GetUser.
  - current = `exp`; target = next active level's `turnover_required` above
    the player's level (current level's own at max active level);
    progress = `min(1, exp / target)` (true 0-1 fill, matching the
    operator's EAR-139 decision to drop the half-cap).
  - also set `tier` from the matched active level.
  - gate the turnover override on a valid target (`levels.length && target>0`)
    so a levels-fetch failure keeps the designed placeholder rather than
    showing `exp/0`.
- update the page header comment: remove "VIP turnover" from the not-yet-wired
  list.

Out:
- Any backend/proto/gateway change (EAR-139 already shipped `exp`).
- The other still-mock Detail sections (contact extras, device, coin
  aggregates, History Transaction, Game) — unchanged, per
  [[preserve-ux-design-wire-data-only]].
- Redesigning the Level VIP card — data source only.

## Verification

- `nuxt build` green.
- Browser-pane smoke on the real Detail page with a stubbed gateway (sandbox
  has no external network): stub GetUser (`{user:{level,exp}}`) + `/admin/levels`
  → the Level VIP card shows real `current/target` and a true-percentage bar.

## Depends on

TASK-EAR-139 (merged) — `exp` on `AdminListUserItem` / GetUser.
