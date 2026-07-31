# TASK-EAR-193 — Win capture T4: bind Top Performance tab to real data (backoffice FE)

## Type

feature

## Priority

high

## Context

T1a/T1b/T2 are live on staging (TASK-EAR-184/187/192): the admin
player-activity endpoint now serves `maxCoinWin` / `totalWins` /
`capturedRounds` with a working `top_performance` sort, and **real data
exists** — the devtest player (`f737e6f3-466b-4db5-b86e-70ac4772b660`) has
Egypt Cat with `maxCoinWin: 100`, `totalWins: "1"`, `capturedRounds: "1"`,
live-proven end to end. This run binds the last mock sub-tab.

Operator scope note (2026-07-31): T3 proceeds later with **GGSoft + IDG
only — Sigma is deferred** by operator decision. Irrelevant to this run but
recorded for the epic trail.

**READ FIRST**: `runs/TASK-EAR-183/win-definition-spec.md` v1.3 §6
("Games-Labs-backoffice" paragraph — display rules), and the FEEDBACK
memory rule: **preserve UX design, wire data only** — the Game tab
(Top Performance / Frequently played / Last played) layout, columns, and
components are design-approved; change the data source only.

## Current FE state (Games-Labs-backoffice)

- `app/pages/admin/manage/player/Detail/[id].vue` (~:493-513, :855-982):
  Frequently played + Last played already ride
  `useAdminPlayerGameActivity.ts` (real API, EAR-164). **Top Performance is
  still mock** (`getPlayerGameRows()` from `app/data/mock.ts:537-549` —
  columns: Category, Game Name/ID, Max Coin Win, Total Wins).
- `app/composables/useAdminPlayerGameActivity.ts` (:80-91): fetches
  `GET /api/v1/admin/game/{userId}/player-activity` with `sort` + `limit`,
  returns rows shaped to the mock column contract.

## Scope

1. Extend `useAdminPlayerGameActivity` (or a thin sibling reusing it) to
   request `sort=top_performance` and surface the three new fields.
   **Response semantics — normalize at the composable boundary**
   (gateway emits camelCase; values as observed live):
   - `maxCoinWin`: JSON **number**, ABSENT when no captured win;
   - `totalWins` / `capturedRounds`: int64 → **"0"-style strings**.
2. Bind the Top Performance sub-tab to the real rows. Display rules
   (spec §6 + proto comments, live-verified):
   - `capturedRounds == 0` → render **"-"** for BOTH win columns, never "0";
   - `capturedRounds > 0` and `totalWins == "0"` → render "0" (played,
     captured, never won);
   - `maxCoinWin` absent → "-"; present → formatted number (match the
     tab's existing number formatting, e.g. thousands separators).
3. Keep the designed columns/order/components exactly as-is; delete only
   the Top-Performance mock wiring that this replaces (Frequently/Last
   played untouched).
4. Tests: follow the repo's existing test style (`tests/*.test.mjs`,
   e.g. playerDetailHistoryFallback) — cover the normalizer (absent →
   "-", zero-string handling, captured-vs-never-captured distinction) and
   the loader failure fallback (API error → the tab's existing
   empty/fallback state, consistent with the sibling tabs).

## Verification

- `npm run build` (or the repo's build/lint scripts) green.
- Authenticated smoke against STAGING data (the pattern from memory
  `backoffice-authenticated-smoke`: playwright-core + system Chrome
  headless + devtest login), with the API base pointed at the staging
  gateway (`https://api-test-gateway.gameslabs.app`) — open the devtest
  player's Detail → Game → Top Performance and assert Egypt Cat shows Max
  Coin Win 100 / Total Wins 1 at rank 1, and a never-captured game (e.g.
  Abyssal Rite) shows "-" not "0". Screenshot as evidence. If the smoke
  harness can't run in this environment, say so explicitly and deliver the
  normalizer unit tests + a manual-verification checklist instead — do not
  fake the screenshot.

## Delivery

- PR to Games-Labs-backoffice. ⚠️ **This repo is the deploy exception:
  merging to main = REAL k3s/ArgoCD deploy** (memory: deploy topology).
  State this in the PR body; do not merge.

## Out of scope

- Any backend/gateway/proto change (all live already).
- T3 adapters (GGSoft + IDG; Sigma deferred by operator).
- Export button, other Detail tabs, any redesign.
