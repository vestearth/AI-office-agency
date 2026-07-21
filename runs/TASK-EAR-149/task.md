# TASK-EAR-149: Game classification epic — Phase 3: Missions consume game_category, exact matcher + fuzzy fallback

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 3 of 5. Depends on TASK-EAR-146
(mapping) and TASK-EAR-148 (events carry game_category). Unblocks 150
(backoffice) and 151 (retire fallback).

## Goal

Score game-scoped missions on the canonical `game_category` with exact
matching, keeping a temporary, observable fuzzy fallback for legacy
config/events until migration is proven complete.

## Scope (Games-Labs-Missions, + shared-lib bump to the 148 version)

1. Add a `game_category` scope field to daily/weekly activity rules; hydrate
   it in `ListActiveDailyActivityRules` / `ListActiveWeeklyActivityRules`;
   expose it in the admin API for the Backoffice editor.
2. Migrate existing `daily_activities` / `weekly_activities` `game_type`
   values to `game_category.code` using the TASK-EAR-146 legacy mapping.
3. Matcher (`activity_match.go`): **primary** = exact match
   `event.game_category` == `rule.game_category`; **fallback** = the existing
   normalize+contains on `game_type` ONLY when `game_category` is absent on
   either side (legacy events/config).
4. Record a distinct consumer-event status (e.g.
   `applied_forward_legacy_fuzzy`) whenever the fallback path scores, so the
   fallback rate is SQL-queryable off `daily_activity_consumer_events`
   (no prometheus needed — reuse the existing status enum).

## Acceptance

- A `game_category`-scoped rule scores a settled event carrying the matching
  `game_category` exactly (daily + weekly share the matcher).
- A legacy `game_type`-only config still scores via the fallback, and the
  legacy status is recorded on the consumer-event row.
- Migration maps every existing config; unmapped tokens (flagged by 146) fall
  through to fallback, not to zero.
- `go build` + `go test ./...` green (extend matcher tests for both paths).
  PR targets staging.
