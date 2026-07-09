# TASK-EAR-088: Missions — per-date daily-completion bonus + quest overview reward currency

## Short Name

`missions-daily-bonus-per-date-and-overview-currency`

## Type

bugfix + contract-gap

## Priority

high

## Parent / Epic

- Epic: Missions admin manage (daily plan board)
- Origin: operator report 2026-07-09 — editing "Value Bonus" on a Next-7-Days row
  also changes the Today Bonus column; mobile asked where reward currency lives
  on the overview.

## Background

Source-verified findings (Claude advisory lane, 2026-07-09):

### (a) Value Bonus is a singleton, not per-date

- The Backoffice daily editor's Value Bonus/Currency round-trip the
  daily-completion-bonus triplet stored on the `mission_config` **singleton**,
  via `POST /api/v1/admin/daily/plans/full` payload key
  `bonus{enabled, reward{amount,currency}}`
  (`Games-Labs-backoffice/app/pages/admin/manage/missions/daily/edit/[id].vue:455-465`,
  `app/composables/useAdminMissionApi.ts:210` — "Daily-completion bonus from
  mission_config (singleton)").
- The board (`GET /api/v1/admin/daily/plans`, `enrichDailyPlanBoardRow`,
  `internal/handlers/adminmission/http/daily_plans.go:158-169`) fills **every**
  day's Bonus column from that same singleton. Editing any day rewrites the
  global value → Today (and all days) change together.
- `daily_plans` (migration 034, one row per Bangkok date, `source` col from 038,
  one-active-per-date from 039) has **no bonus storage**.

### (b) Quest overview has no `currency` key

- `GET /api/v1/quest/overview` (Struct passthrough at the gateway, snake_case
  verbatim) emits every reward as `QuestOverviewReward{type, amount}`
  (`internal/services/quest_overview_service.go:97-100`). Currency is folded
  into `type` lowercased via `normalizeRewardType` (`:551-556`). Mobile cannot
  read an explicit currency.

## Scope

Two parallel workstreams on `Games-Labs-Missions` (branches cut from `staging`):

| Stream | Agent | Branch | Change |
|---|---|---|---|
| (a) per-date bonus | dev | `feature/TASK-EAR-088-missions-daily-bonus` | Migration: nullable `bonus_enabled/bonus_amount/bonus_currency` on `daily_plans` (NULL = fall back to the `mission_config` singleton, which becomes the default). `SaveDailyPlanFull` persists the payload bonus onto the plan row and stops writing the singleton. Read paths (board enrich, plan detail, quest overview `daily_completion_bonus`, and the `POST /missions/claim-daily-completion-bonus` money path) resolve per-date first, singleton fallback. Response shapes unchanged. |
| (b) overview currency | dev-2 | `feature/TASK-EAR-088-overview-currency` | Add `Currency string json:"currency"` to `QuestOverviewReward` and populate at all construction sites with the canonical stored currency (COIN/DIAMOND/POINT, as stored); `type` behavior unchanged for backward compat. |

Sync/merge of the two branches, conflict resolution in
`quest_overview_service.go`, and final verification are the orchestrator lane.

## Out of Scope

- Backoffice FE changes (TASK-EAR-089).
- Wiring or removing the dead `schedule_config.daily.days[wd].valueBonus`
  weekday template (decision pending — generator never reads it,
  `schedule_generator.go:149-191`).
- Schedule generator behavior (generated plans keep NULL bonus → fallback).

## Acceptance Criteria

1. Editing a Next-7-Days plan's bonus changes only that `plan_date` row; the
   Today board row is unaffected.
2. A plan with no per-date bonus renders/pays the singleton default (backward
   compatible; no behavior change for untouched days).
3. `ClaimDailyCompletionBonus` pays exactly the amount/currency the overview
   displays for today (per-date first, fallback singleton).
4. Quest overview rewards carry `currency` alongside `type`/`amount`;
   Struct-passthrough key casing preserved (snake_case envelope untouched).
5. `go build ./... && go vet ./... && go test ./...` green on the merged result.
6. Admin API request/response shapes unchanged (FE requires no change for (a)).
