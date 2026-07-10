# TASK-EAR-094: Weekly Value Bonus — board display + admin round-trip + public exposure

## Short Name

`weekly-bonus-wiring`

## Type

bugfix/feature (FE Games-Labs-backoffice + BE Games-Labs-Missions)

## Priority

medium

## Parent / Epic

- Epic: Missions admin manage — Weekly
- Related: TASK-EAR-093 (weekly roster), migrations 021/030/044 (completion
  bonus singletons + daily per-plan override)
- Origin: operator follow-up review 2026-07-10 after merging PR #29 —
  (a) /admin/manage/missions?type=weekly table shows no Bonus value;
  (b) Value Bonus is not exposed on the API the mobile frontend will
  consume.

## Root cause (evidence from 2 Explore subagents, 2026-07-10)

- (a) FE-only: the weekly board API (GET /api/v1/admin/weekly/plans,
  enrichWeeklyPlanBoardRow weekly_plans.go:90-96) ALREADY returns a per-row
  `bonus` from mission_config.weekly_completion_bonus_*, but the backoffice
  `WeeklyPlan` type declares no bonus field and `weeklyPlanToBoardWeek`
  hardcodes `bonus: 0` (weeklyPlanBoardMap.ts:31). Daily reads
  `plan.bonus.reward.amount` (dailyPlanBoardMap.ts:171).
- (b) Backend: SaveWeeklyPlanFull persists bonus into the
  mission_config singleton (mission_repo.go:3281-3291), but
  1. admin GetWeeklyPlan detail + SaveWeeklyPlanFull response omit bonus
     (daily's assembleDailyPlanDetail includes it) — weekly edit page can
     only show mock bonus;
  2. public GET /api/v1/missions/weekly (models.WeeklyMissionsResponse)
     and GET /api/v1/quest/overview (QuestOverview) carry NO weekly bonus
     field (daily has QuestOverview.DailyCompletionBonus). These RPCs are
     google.protobuf.Struct passthrough (shared-lib missions.proto:41-43,
     68-70) so adding the JSON field in Missions reaches mobile with zero
     proto/gateway change.

## Scope

1. Games-Labs-Missions (Go, branch off staging):
   - GetWeeklyPlan detail + SaveWeeklyPlanFull response: add `bonus`
     assembled from cfg.WeeklyCompletionBonus* (mirror board enrichment).
   - Public exposure (display-only v1): add `weekly_completion_bonus`
     ({enabled, reward:{amount,currency}}) to WeeklyMissionsResponse
     (ListWeeklyMissions) and QuestOverview (mirroring
     daily_completion_bonus shape minus claim fields).
   - Unit tests for both.
2. Games-Labs-backoffice (FE, branch off main):
   - `WeeklyPlan`/`WeeklyPlanDetail` types gain `bonus?`; board map reads
     `plan.bonus.reward.amount` (drop the hardcoded 0 / speculative casts);
     weekly edit `applyDetail` reads `detail.bonus` when present (daily
     parity, mock fallback otherwise).
   - Tests for the board map.

## Scope addition (operator decision 2026-07-10)

Per-week bonus override IS in scope: operator confirmed the global
singleton shared by all weeks is incorrect. Commit 3bb3259 mirrors the
daily per-date model (TASK-EAR-088): migration 045 adds nullable
bonus_enabled/bonus_amount/bonus_currency to weekly_plans;
SaveWeeklyPlanFull writes the plan row (singleton = fallback only); new
resolveWeeklyCompletionBonus + ResolveWeeklyPlanCompletionBonus +
ResolveWeeklyCompletionBonusForWeek; admin board/detail/full-save and
public weekly/overview all return the RESOLVED per-week bonus.

## Non-goals (flagged follow-ups, operator decision needed)

- Weekly bonus CLAIM flow (ClaimWeeklyCompletionBonus + wallet credit) —
  weekly_completion_bonus_claims table exists but is dead code; daily has
  full claim parity. Display-only for v1.
- schedule_config ValueBonus is parsed but never wired into generated
  plans (affects daily too) — separate gap.

## Acceptance

- Backoffice weekly table shows the real Bonus from the board API.
- Weekly edit page loads the real bonus (not mock) once the backend detail
  carries it; save continues to persist via SaveWeeklyPlanFull.
- GET /api/v1/missions/weekly and /api/v1/quest/overview include
  weekly_completion_bonus so the mobile team can wire it.
- go build + go test green (Missions); node --test + nuxt build green
  (backoffice); browser check of the board table.

## Notes

- Claude (Fable 5) advisory lane leading; Explore subagents provided the
  evidence; reviewer subagent gates each commit. Enum fields stay within
  the validator enum; provenance in reasons.
- Deploy topology: Missions PR targets staging (real-DB QA); backoffice PR
  targets main.
