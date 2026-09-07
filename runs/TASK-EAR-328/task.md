# TASK-EAR-328 — Wire the Detail fields that have both a source and a designed row

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-09-07

## Parent / Epic

- Parent: none
- Epic: Player Detail backend wiring (TASK-EAR-144 / 177 / 179 / 193 / 255 / 326 / 327)
- Sequence: P2 of the 2026-09-07 audit, after 326 (P0) and 327 (P1), both of
  which are merged and deployed.

## Goal

Fill three places on Player Detail where a designed element renders a constant
or a dash while its real value is already in a response the page can reach.
Frontend only — no API, proto, or gateway change.

## Scope correction to the audit

The audit listed six P2 wiring items. Verified against source on 2026-09-07,
**three of them are not wiring tasks at all**: the data exists, but the Detail
page has **no designed row to put it in**. Adding one is a Figma decision, not
a mapper change, and the preserve-UX-design rule forbids inventing rows.

| Audit item | Source exists? | Designed row on Detail? | Verdict |
| --- | --- | --- | --- |
| VIP thumbnail | ✅ `ListLevels` → `ui_setting.thumbnail.thumbnail_url` | ✅ `<img src="/vip1.png">` hardcoded, `[id].vue:1039` | **wire** |
| Frequently played Max Coin Win / Total Wins | ✅ same RPC that already backs Top Performance | ✅ both columns exist in that table's `<thead>` | **wire** |
| Game thumbnail | ✅ `/api/v1/admin/games` → `imageUrl`, already mapped by `useAdminGamesCatalog` | ✅ every game row renders `row.thumb` | **wire** |
| Register Date | ✅ `GetUserResponse.user.register_date` (field 11) | ❌ no such row anywhere on the page | **design first** |
| Last Login | ✅ `…user.last_login` (field 12) | ❌ | **design first** |
| Lifetime GGR | ✅ `…user.lifetime_ggr` (field 10) | ❌ | **design first** |
| Device Type / Device Last Login | ✅ in the device response, dropped by `parseAdminPlayerDevice` | ❌ Device Info has exactly two rows, IP Address and Serial Device | **design first** |

`GetUserResponse.user` is `ListUserResponse.AdminListUserItem`, which carries
`lifetime_topup=9`, `lifetime_ggr=10`, `register_date=11`, `last_login=12`,
`exp=13`. The page already reads `lifetimeTopup`, `level` and `exp` from that
same object, so the three unread fields are one line each **the moment a row
exists to hold them**. The player *list* page already renders all three
(`player/index.vue:163-165`), so this is a Detail-page design gap, not a
backend gap.

## Evidence that drove the scope

1. `[id].vue:1039` — `<img src="/vip1.png" …>` is a literal. Every player,
   at every VIP level, gets the level-1 artwork. `fetchActiveLevels` already
   calls `ListLevels` and already resolves `currentCfg` for this player's
   level; it just drops `ui_setting`.
2. `useAdminPlayerGameActivity.ts:104-105` — `toGameRow` hardcodes
   `maxCoinWin: '-'` and `totalWins: '-'`, and only `fetchTopPerformanceRows`
   spreads `normalizeWinStats(item)` over the result. The *Frequently played*
   table's `<thead>` has both columns (Rank, Game Name/ID, Category, Max Coin
   Win, Total Wins, Round played), so two designed columns are permanently
   dashed for a player whose wins were captured.
3. `toGameRow` sets `thumb: DEFAULT_GAME_THUMB` because the activity endpoint
   carries no image. `useAdminGamesCatalog.toCatalogItem` already maps
   `imageUrl → thumbnailUrl` with the same `/collect-event.webp` fallback, so
   a join by `gameId` needs no new endpoint.

## Locked decisions (operator 2026-09-07)

- The four "design first" items are **not** implemented here. They need a row
  in the Figma before any mapper change; opening one is a separate ask.
- Game thumbnails join on the client. The alternative — adding `image_url` to
  the game-activity response — is a better long-term shape but costs a
  shared-lib publish plus Game and gateway bumps for a picture; the catalog
  composable already exists and the mission/store pickers already fetch the
  full catalog, so the precedent is there.
- The catalog join **fails soft**: a failed or slow catalog leaves every row
  on the existing placeholder. A thumbnail is never worth failing a table
  that has real rows in it.
- `normalizeWinStats` display rules are reused as-is (TASK-EAR-193 /
  win-definition spec v1.3 §5-§6): `capturedRounds` absent or `0` renders `-`
  for BOTH win columns, because a `0` there would fabricate a statistic.

## Acceptance criteria

1. The VIP card's image comes from the matched level's
   `uiSetting.thumbnail.thumbnailUrl`; `/vip1.png` remains the fallback when
   the catalog has no thumbnail or the lookup fails.
2. *Frequently played* renders Max Coin Win and Total Wins through
   `normalizeWinStats`, identically to Top Performance — including the
   `capturedRounds = 0 → '-'` rule.
3. Game rows show the catalog thumbnail when one exists, and the existing
   placeholder otherwise; a failed catalog fetch changes nothing else on the
   page.
4. *Last played* keeps its three designed columns — it has no win columns and
   must not gain any.
5. Regression tests fail on the pre-change source and pass after.
6. No designed component replaced, no layout change, no new row invented.

## Non-goals

- Register Date, Last Login, Lifetime GGR, Device Type, Device Last Login —
  blocked on a design decision, not on code. Note for whoever picks them up:
  `lifetime_ggr` is an **int64, so grpc-gateway serialises it as a JSON
  string**, and EAR-320 defines it as GGR over captured rounds only, not a
  lifetime figure.
- Server-side pagination and the row caps (audit P3).
- The Wallet coin-aggregate contract (audit P4) and the Diamond redemption
  flow (TASK-EAR-329).
- A Device-panel error state (deferred by TASK-EAR-327).
