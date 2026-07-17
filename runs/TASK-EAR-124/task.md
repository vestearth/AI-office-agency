# TASK-EAR-124: Hide Watch Ad + Daily Streak placeholders from the Quest API (staging)

## Short name

`hide-placeholder-quest-items`

## Type

chore

## Workstream

backend

## Priority

medium

## Created

2026-07-17

## Goal

Stop serving three placeholder mission items that mobile renders as if they were
real: the `watch-ad` and `streak` items on the Quest daily tab, and the
`weekly_watch_ad_10` fallback weekly mission. None is backed by real backend
data — mobile currently shows migration defaults and Go literals as live player
progress. Remove them at the display level until a future task wires real data.
Staging only.

## Approved design

Brainstormed and approved by the operator 2026-07-17 (Claude advisory lane).
No separate spec file — Games-Labs-Missions backend tasks in this repo carry
their design directly in `task.md` (unlike frontend tasks, which reference a
`docs/superpowers/specs/` file).

**Why these three are placeholders (verified, not assumed):**

- **`streak` item** (`quest_overview_service.go`) — `Reward.Amount: 500` and
  `Progress.Target: 7` are Go literals, and `Active: true` is hardcoded. Nothing
  reads them from config. Only `Progress.Current` (`CheckInMaxStreak`) is real.
- **`watch-ad` item** (`quest_overview_service.go`) — reads `cfg.WatchAdReward` /
  `cfg.WatchAdDailyLimit`, but those are serving the **migration defaults**
  (`001_baseline_compacted.sql`: `watch_ad_reward BIGINT NOT NULL DEFAULT 50`,
  `watch_ad_daily_limit BIGINT NOT NULL DEFAULT 5`) and **no admin UI exists** to
  change them — a grep of `Games-Labs-backoffice` for `watch_ad_reward` /
  `watch_ad_daily_limit` returns nothing. The `+50` / `0/5` mobile shows is the
  raw DB default, not configured data.
- **`weekly_watch_ad_10`** (`weekly_service.go`) — a hardcoded entry in
  `defaultWeeklyMissionDefinitions` (`Target: 10`, `RewardAmount: 150` literals).

**Decisions locked by the operator:**

- **Plain removal, not an env-flag gate.** Re-enabling these is not a flag flip:
  the streak's 500/7 literals must be replaced with config reads, and Watch Ad
  needs a backoffice config surface that does not exist. A gate would preserve
  known-wrong code and imply a false "flip it back on" capability. Removal is in
  git history; the future task rewrites these properly.
- **Display level only.** The `WatchAd` and `CheckInStreak` RPCs/handlers and
  the `mission_config` watch-ad columns stay live and untouched — once the item
  is gone from the list, mobile has no affordance to call them, and the write
  paths stay ready for the follow-up that wires real data.
- **Scope = daily tab + the weekly `Watch 10 ads` fallback.** Hiding only the
  daily pair would leave an inconsistent watch-ad placeholder on the weekly tab.

**Removal is item-level, not `Active: false`.** The items are dropped from the
`Items` slice rather than flagged inactive, because whether the mobile client
honours the `active` field is unverified — an unhonoured flag would ship a
no-op fix.

**Weekly blast radius is narrow.** `resolveWeeklyDefinitions` returns the admin
plan's activities whenever `GetActiveWeeklyPlanActivities` yields any rows;
`defaultWeeklyMissionDefinitions` is only the `len(acts) == 0` fallback. So
removing `weekly_watch_ad_10` changes nothing for a week that has a configured
plan — it only shortens the no-plan fallback from 3 missions to 2.

**No contract change.** `GET /api/v1/quest/overview` and
`GET /api/v1/missions/weekly` are Struct-passthrough all the way to mobile
(`GetQuestOverview` bridges via `structpb.Struct`), so dropping fields from the
Go structs reaches mobile with no `.proto` edit, no `missionspb` regen, and no
`shared-lib` bump.

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns the Quest overview builder and the weekly fallback definitions. |
| `ai-dev-office` | Records the design, scope, and verification handoff for this task. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `internal/services/quest_overview_service.go` | modify | Delete the `watch-ad` and `streak` items appended in `buildDailyTab`; delete the then-orphaned `loginStreakStatus` helper (its only caller is the `streak` item; no test references it). |
| `internal/services/weekly_service.go` | modify | Delete the `weekly_watch_ad_10` entry from `defaultWeeklyMissionDefinitions`. |
| `internal/services/quest_overview_service_test.go` | modify | Drop the two index-based reward assertions for the removed items and the TASK-EAR-081 streak block; add a regression test asserting the daily tab carries neither key. |
| `internal/services/weekly_service_test.go` | modify | Drop the `weekly_watch_ad_10` claim fixture and `watch_ad` count; add a regression test asserting the fallback omits `weekly_watch_ad_10`. |
| `ai-dev-office/runs/TASK-EAR-124/status.yaml` | create | Track assignment and next action. |

### Explicitly excluded

- No `.proto` / `missionspb` / `shared-lib` / `api-gateway` change — both
  affected responses are Struct-passthrough.
- No migration, and no change to the `mission_config` watch-ad columns
  (`watch_ad_reward`, `watch_ad_reward_currency`, `watch_ad_daily_limit`) — the
  claim path still reads them.
- No change to the `WatchAd` RPC, the `CheckInStreak` handler, or their routes —
  display-level hiding only, per the approved design.
- No change to the `watch_ad_daily_count` / `check_in_max_streak` fields on the
  progress payload — they are data, not display items.
- No backoffice change — no admin UI for these values exists to begin with.
- No change to the event tab's `watch_ad` mission-event kind
  (`event_service.go`) — out of the operator-agreed scope.
- No change to the other two fallback weekly definitions
  (`weekly_daily_mission_5`, `weekly_mission_boost_1`) — out of scope.
- No merge to `main` and no prod deploy — staging only.

## Description

The Quest daily tab ends with two hardcoded `QuestOverviewItem` appends that
predate any backend config surface, and the weekly fallback list carries a
matching hardcoded watch-ad mission. Mobile renders all three as live missions:
the screenshot that triggered this task shows "Watch Ad `+50` `0/5`" (the
migration defaults) and "Daily Streak `+500` `5/7`" (Go literals, with only the
`5` real). Players see rewards nobody will pay against targets nobody
configured. This task removes them from the API until real data is wired.

## Acceptance criteria

- [ ] `GET /api/v1/quest/overview` daily tab `items[]` contains no item with
      `key: "watch-ad"` or `key: "streak"`.
- [ ] `GET /api/v1/missions/weekly` fallback (no active weekly plan) contains no
      mission with `id: "weekly_watch_ad_10"`; the other two fallback missions
      are unchanged.
- [ ] A week WITH an active admin weekly plan is byte-identical to before —
      `resolveWeeklyDefinitions` never reaches the fallback in that path.
- [ ] `loginStreakStatus` is deleted (its only caller is removed); no other
      helper is orphaned by this change.
- [ ] The `WatchAd` RPC, the `CheckInStreak` handler, their routes, and the
      `mission_config` watch-ad columns are untouched.
- [ ] No `.proto` / `missionspb` / `shared-lib` / `api-gateway` / migration
      change of any kind.
- [ ] Regression tests assert the absence of all three items, so a future
      re-add is a deliberate act.
- [ ] `go build ./...` and `go vet ./...` pass.
- [ ] `go test ./... -count=1` passes with zero regressions.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-124` passes.
- [ ] Merged to Games-Labs-Missions `staging` only (not `main`).

## Plan Summary

1. Delete the `watch-ad` + `streak` appends in `buildDailyTab`, collapsing the
   `items = append(items, ...)` call that only exists to add them.
2. Delete the orphaned `loginStreakStatus` helper.
3. Delete `weekly_watch_ad_10` from `defaultWeeklyMissionDefinitions`.
4. Fix the index-based assertions in `quest_overview_service_test.go`
   (`Items[2]` = watch-ad coin 10, `Items[3]` = streak coin 500) and delete the
   TASK-EAR-081 streak block; drop the weekly `watch_ad` fixture rows.
5. Add regression tests for all three absences.
6. Run `go build ./...`, `go vet ./...`, `go test ./... -count=1`.
7. Commit on a branch cut from `staging`
   (`feat/TASK-EAR-124-hide-placeholder-quest-items`), open a PR against
   `staging`, request review.
8. Update `status.yaml` to `in_review`, then `done` once merged.

## Working-tree note

The main `Games-Labs-Missions` checkout is on
`feat/TASK-EAR-123-weekly-completion-bonus-claim` and holds uncommitted work
from another session (see TASK-EAR-123's task.md "Global Constraints"). This
task is therefore implemented in a **git worktree** cut from `origin/staging`,
leaving that checkout untouched. Never run `git add -A`, `git stash`, or
`git reset` in the main checkout.

## Follow-up (out of scope)

Re-introducing these missions with real data is a separate task and is real
work, not a revert:

- **Daily Streak** needs the reward and the 7-day target moved out of Go
  literals into `mission_config` (or the weekly/daily plan rows), plus a claim
  path — nothing currently pays the 500 coin it advertises.
- **Watch Ad** needs a backoffice config surface for `watch_ad_reward` /
  `watch_ad_reward_currency` / `watch_ad_daily_limit` before the existing
  columns mean anything; the `WatchAd` claim RPC itself already works.
