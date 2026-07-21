# TASK-EAR-134: Player Detail page — wire the API-backed sections, honest empty states for the rest

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-18

## Goal

`admin/manage/player/Detail/[id].vue` is 100% mock (`mockPlayerDetail`,
`getPlayerHistoryTable`, `getPlayerGameRows`) — it shows fabricated
transaction rows, game stats, and coin totals an admin might believe.
Per the operator's phase-2 sign-off (2026-07-18, "slice"): wire the
sections that have deployed admin APIs, and replace the rest with honest
"no data" states instead of fake mock. **FE-only** — no new backend.

## What has an admin API (wire it)

- **Basic Info** header + cards:
  - Identity (username, User ID, referral code, status) →
    `GET /api/v1/admin/user/{id}` (GetUser, deployed EAR-130).
  - Wallet (Point / Diamond / Coin) →
    `GET /api/v1/admin/wallet/balance/{id}` (deployed; already used by the
    edit page's Wallet tab).
  - VIP: level number from GetUser (`level`). The VIP **turnover
    progress** has no admin endpoint (GetLevelStats is user-scoped) — show
    the level/tier only, no fabricated progress bar.
  - Contact: Phone + Email from GetUser; **Facebook / Line / Address = '-'**
    (no backend columns — operator decision).
  - Device Info (IP / Serial) = '-' (no backend source).
- **Summary sidebar**:
  - Lifetime Top-up → GetUser `lifetimeTopup`.
  - Golden Pass → `GET /api/v1/admin/missions/user-overview` active_passes
    (deployed EAR-132); show active + remaining if a golden pass is present.

## What has NO admin API (KEEP the designed UI, wire later)

Operator correction (2026-07-18): the Detail UI is UX/UI-design-approved —
do NOT replace designed components. Keep the existing layout for the
not-yet-API sections; they stay on their current design placeholder until
their API exists ("ต่ออันที่มีก่อน ส่วนที่ยังไม่ได้ค่อยทำเพิ่ม").

- **History Transaction** (Purchase / Earned / Redeem / Send coin): no admin
  transaction-ledger RPC. **Keep the designed table + tabs + pagination** as
  placeholder — do not rip it out.
- **Game** (Top Performance / Frequently played / Last played): no per-player
  analytics RPC. **Keep the designed tables** as placeholder.
- **Summary** Total Coins Received / Wager / Total Redeem, and the **VIP
  turnover** progress card: no aggregate/turnover admin RPC. **Keep the
  designed cards** as placeholder.

## Scope

In: `Detail/[id].vue` — change only the DATA SOURCE. `player` starts from
the design placeholder (mockPlayerDetail) and loaders override ONLY the
fields with a deployed admin API: identity (GetUser), VIP level number,
wallet balance (GetWalletBalance), lifetime top-up, contact phone/email,
golden pass (user-overview). **No template/design changes.** Reuse the edit
page's fetch/parse patterns.

Out: any backend RPC (transaction ledgers, game analytics, wallet
aggregates, VIP turnover-for-admin) — each is a separate backend-first
epic the operator has NOT funded. Purchase-history via the public orders
endpoint (cross-surface auth risk).

## Acceptance criteria

- Basic Info shows real identity/status/wallet/VIP-level/lifetime-topup for
  a real player id; Contact extras + Device show '-'.
- Golden Pass reflects the player's real active pass state.
- History Transaction + Game tabs show a clear "no data available" state —
  no fabricated rows.
- No mock transaction/game/summary numbers remain on the page.
- `npm run build` green; Browser-pane capture shows the admin GET calls
  firing with the route id; PR opened → main.
