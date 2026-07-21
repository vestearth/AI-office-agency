# TASK-EAR-136: Game status visibility (public active filter) + provider-edit game toggle wiring

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-07-18

## Goal

Make `games.status = inactive` behave as the operator expects end-to-end:
inactive games disappear from the player-facing game lists, the Backoffice
admin/games page gains a status filter (keeping the badge), and the Provider
Edit page's per-game status toggles (single + bulk) are wired to the existing
admin `UpdateGame` API.

## Background / verified current behavior

- Provider Games List status = `games.status` in the Game service DB
  (Provider service calls `AdminGameService.ListGames` with forwarded staff
  metadata). Single source of truth.
- Public surfaces already active-only: `/api/v1/game/category`,
  frequently-played, last-played, launch (blocks non-active with
  GameUnavailable), and all `/api/v1/website/game*` endpoints.
- Gap: `GET /api/v1/game` (main FE/mobile list) and `GET /api/v1/game/my-games`
  pass `status=""` into `gameRepo.List` → inactive/pending/maintain games leak
  to players.
- Backoffice admin/games (`GET /api/v1/admin/games`) returns all statuses;
  page shows an Active/Inactive badge, no filter.
- Provider Edit game toggles are stubs behind `canPersistProviderWrites=false`;
  backend `AdminGameService.UpdateGame` (`PUT /api/v1/game/{id}`, status enum
  pending|active|inactive|maintain) exists. Handler requires `provider_id`;
  repo merge treats empty strings/nil optionals as keep-existing, so a minimal
  body `{provider_id, status}` updates status only (verified in
  `admingamehdl/grpc.go:480` + `repositories/game.go:396`).
- Provider-level status/image writes still have NO backend RPC — the single
  Provider Status toggle (TASK-EAR-129, done) stays read-only.

## Approved implementation (operator decisions 2026-07-18)

1. **Games-Labs-Game** (branch from `staging`): filter public lists to
   active-only at the `gamesvc` service layer (repo `List` is shared with the
   admin service and must stay unfiltered): pass `models.GameStatusActive` in
   `List` (→ `GET /api/v1/game`) and `ListUserGame` (→ `/my-games`).
   Active-only rather than exclude-inactive: consistent with every other
   public surface; `pending` must never reach players; `maintain` games fail
   launch anyway. `GetGameByID` and settlement paths untouched.
2. **Backoffice admin/games**: keep the status badge, add a status filter
   (All/Active/Inactive) in the filter bar; client-side over the loaded list,
   wrapped select + chevron per UI convention (no bare native select).
3. **Backoffice provider/edit/[id]**: wire single + bulk game status toggles
   to `PUT /api/v1/game/{id}` with body `{provider_id, status}` via a new
   `updateAdminProviderGameStatus` in `useAdminProviderApi.ts` (same
   gateway-base + bearer-header pattern); refresh the games list after
   success; keep confirm dialogs; un-gate game toggles from
   `canPersistProviderWrites` (which keeps gating provider status + image).

## Deferred / follow-ups

- Provider Status write + Provider Image upload persistence: blocked on
  Provider service admin write RPCs (own backend task).
- Mobile-team confirmation that no client screen depends on seeing
  non-active games in `GET /api/v1/game` (other public lists already hide
  them). Deploy Game service change staging-first.
- Ops note: a game set inactive that sits in a Missions event/mission
  `game_ids` pool becomes unplayable → distinct-games targets can become
  unreachable. Not code; surface when toggling games off.

## Acceptance criteria

- `GET /api/v1/game` and `/api/v1/game/my-games` return only `active` games;
  Game service tests pass (`go test ./...`).
- admin/games page filters by status; badge unchanged.
- Provider Edit game toggle (single + bulk) persists via
  `PUT /api/v1/game/{id}`; list reflects new status after refresh; pending/
  maintenance games remain non-toggleable; provider status toggle remains
  read-only.
- Backoffice tests and production build pass.
