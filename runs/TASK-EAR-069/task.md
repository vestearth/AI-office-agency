# TASK-EAR-069: Public event list returns upcoming events (Soon tab)

## Short name

`event-list-upcoming`

## Type

bugfix

## Workstream

backend (Games-Labs-Missions) — public/mobile API

## Created

2026-07-03

## Goal

`GET /api/v1/missions/events` (public/mobile list) only returned events whose
state was `active` (enabled AND within the start/end window), so the mobile
"Soon" tab (upcoming events) had no data source — even though the backend
already permits joining an event while it is `upcoming`. Return `upcoming`
events too.

## Root cause

`EventService.ListEvents` skipped every event where
`missionEventState(now, cfg) != "active"`, dropping `upcoming` (and correctly
`expired`/`inactive`).

## Fix (Games-Labs-Missions, `internal/services/event_service.go`)

- Include an event when its state is `active` OR `upcoming`; still omit
  `expired` and `inactive`.
- The list-level `ResetInSeconds` still tracks only the earliest **active**
  window end — upcoming events (not yet started) must not shorten it.

## Mobile / web impact (contract)

- The list now returns `upcoming` cards in addition to `active`. Clients MUST
  split tabs by the card's `state`: `active` → On going, `upcoming` → Soon. A
  client that renders the list flat would show upcoming events mixed in.
- Upcoming cards carry `state: "upcoming"`, `eligible: false`,
  `claimable: false`, but are joinable (join already allows `upcoming`).
- `reset_in_seconds` semantics unchanged (active window only).
- Additive change (new items in an existing array); no field renamed/removed.
- Add to the Event Missions mobile handoff note (knowledge-base ADR-0007
  companion).

## Verification

- Updated `TestEventServiceListEventsReturnsActiveAndUpcomingBuildsStatus`:
  asserts active + upcoming returned (expired/inactive excluded), reset timer
  still active-window-based, upcoming card non-eligible/non-claimable. Verified
  it fails under the old active-only filter (returns 1, not 2) and passes with
  the fix. Full `go build/vet/test ./...` green.

## Scope

Branch `feature/TASK-EAR-069-public-list-upcoming` from `staging` (Missions
lane). Backend only; response shape unchanged (more items only).
