# TASK-EAR-130: Player admin API completion — phase 1 (summary, get-by-id, honest list contract)

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-17

## Goal

Close the highest-value API gaps found in the `admin/manage/player` audit
(Games-Labs-backoffice) without waiting on the phase-2 contract work
(status update, reset password, voucher/pass/mission grants):

1. Implement `PlayerSummary` (`GET /api/v1/admin/user/summary`) in
   Games-Labs-User — the RPC exists in the proto but has no handler — and
   wire the 6 stat cards on `admin/manage/player/index.vue` to it.
2. Add `GetUser` (`GET /api/v1/admin/user/{user_id}`) to the AdminUserService
   proto + Games-Labs-User handler. The backoffice edit page already probes
   this exact URL first and eats a 404 on every load before falling back to
   `ListUser?search=`.
3. Make the player list FE honest about the current ListUser contract: the
   backend ignores `search`/`startDate`/`endDate`/`page.size` entirely
   (handler discards the request), so stop sending `page.size` (a trap the
   day the backend honors it and client-side pagination/stats silently
   break) and source stats from the summary endpoint instead of the loaded
   page.

## Verified current defects

- `Games-Labs-User/internal/core/handlers/adminuserhdl/grpc.go` has no
  `PlayerSummary` method — calls to `/api/v1/admin/user/summary` hit
  gRPC Unimplemented through the gateway.
- No `GetUser` RPC exists anywhere in
  `shared-lib/proto/admin/adminuserpb/adminuser.proto`;
  `app/pages/admin/manage/player/edit/[id].vue` fires
  `GET /api/v1/admin/user/{id}` → guaranteed 404 → falls back to list
  search on every page load.
- `ListUser` handler signature is `(ctx, _ *ListUserRequest)` — request is
  discarded; returns ALL users (N+1 `GetProfile` per row). FE search/date
  filters and stat cards only work because the full dataset happens to
  arrive.
- `userRepo.List` filters `soft_deleted_at IS NULL`, so a "Deleted Player"
  count derived from the list is structurally always 0; only an aggregate
  over the full `users` table can count deleted players.

## Scope

In:
- shared-lib: add `GetUser` RPC (declared AFTER `ListUserWallets` /
  `PlayerSummary` in the service so grpc-gateway registration order keeps
  the literal `/wallets` and `/summary` routes winning over `{user_id}`),
  `make buf` regen.
- Games-Labs-User: `PlayerSummary` handler + service + single aggregate SQL
  (counts by status incl. soft-deleted + `SUM(user_profiles.lifetime_topup)`),
  `GetUser` handler reusing `GetByID` + `GetProfile`.
- api-gateway: bump shared-lib so the new route registers.
- Games-Labs-backoffice: `index.vue` stat cards read
  `/api/v1/admin/user/summary` (camelCase JSON — typed proto via gateway),
  drop the ignored `page.size` param; `edit/[id].vue` unwrap handles the
  `GetUserResponse` `{status, user:{userId,...}}` shape.

Out (phase 2 — needs contract decisions):
- Server-side search/date/pagination in ListUser.
- Player status update RPC, reset password, E-Voucher / VIP grant /
  Grant Pass / Missions panels (all still mock + fake-success toasts).
- Detail page (`Detail/[id].vue`) — 100% mock, separate task.

## Acceptance criteria

- `GET /api/v1/admin/user/summary` returns 200 with real counts on dev
  gateway; player list stat cards show those numbers.
- `GET /api/v1/admin/user/{uuid}` returns the user item; `/summary` and
  `/wallets` still resolve to their own RPCs (registration-order check).
- Player list no longer sends `page.size`; edit page header populates from
  the direct GET (no 404 in network tab).
- `go build ./...` green in both Go repos; backoffice `npm run build` green.
- PRs opened per repo (backend → staging, FE → main), links recorded here.
