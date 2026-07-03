# TASK-EAR-064: Event Missions — Admin CRUD + Public Join (Contract v1.1)

## Short name

`event-missions-contract-v11`

## Type

feature

## Workstream

fullstack (shared-lib proto + Missions backend + api-gateway + Backoffice)

## Priority

high

## Created

2026-07-03

## Goal

Implement the locked Event Missions contract v1.1: multi-mission (per-game)
event container with join-gate, accumulating progress (no daily reset),
achievement target derived from the count of selected distinct games, single
event-level reward, admin CRUD API, and Backoffice wiring replacing the
preview-only mock.

## Approved contract (v1.1 — locked 2026-07-03 with operator)

- Event = container of per-game sub-missions. Admin selects N distinct games;
  achievement target = N (derived server-side from `len(game_ids)`).
- Join-gate: user must join before progress counts; join allowed pre-start
  (upcoming). `POST /api/v1/missions/events/{event_id}/join`, idempotent.
- No progress reset: per-game turnover accumulates over the whole event
  window; event simply closes at `end_at`. `ResetAt`/`ResetInSeconds` in
  event responses are repurposed to event end (operator-approved).
- Collect only when achievement == target (existing claim logic + idempotency
  via `mission_logs` unique index stays untouched).
- Reward = single event-level `{amount, currency}` (group pays; no
  per-sub-mission rewards).
- Cut from phase 1: `valueBonus`, bonus currency, `activeDay` (daily-mission
  leftovers in Backoffice Step 3).
- Admin API base `/api/v1/admin/missions/events` (list/get/create/update
  PUT/PATCH active/soft delete). Currency enum uppercase COIN|DIAMOND|POINT.
  Timestamps RFC3339 with timezone.
- `eligible` on public cards changes meaning to "joined"; new `joined` field
  added. Mobile handoff note required.

## Plan

Execution plan with per-task specs: `runs/TASK-EAR-064/plan.md`.

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `shared-lib` | New admin event RPCs in `adminmissionpb`, `JoinMissionEvent` in `missionspb`, regenerated artifacts. |
| `Games-Labs-Missions` | Migrations (4 child tables + header columns), event service rewrite, admin handlers, join/progress, routes, gRPC bridge. |
| `api-gateway` | shared-lib bump + route exposure for new admin/public RPCs. |
| `Games-Labs-backoffice` | Replace preview-only event pages with real API wiring; UI corrections per contract. |
| `knowledge-base` | ADR for contract v1.1 + mobile handoff note (meta-exempt repo). |

### Out of scope

- Mobile app changes (handoff notes only).
- `spend_prop` runtime progress tracking beyond storing condition config.
- Weekly/invite mission gaps (tracked separately).

## Known gotchas (must apply)

- Admin by-id handlers must not read `r.PathValue()` directly — gateway gRPC
  bridge bypasses the mux; use `s.callPath` (EAR-046 lesson).
- Update RPCs are PUT, not POST (405 via gateway otherwise).
- No proto field names ending `_1` (gateway DiscardUnknown silently drops).
- Backoffice selects must use the custom chevron pattern (no bare native
  `<select>`).
