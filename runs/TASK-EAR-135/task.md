# TASK-EAR-135: ListUser server-side search / date / pagination (+ kill N+1)

## Type

refactor

## Workstream

backend

## Priority

medium

## Created

2026-07-17

## Goal

Make `GET /api/v1/admin/user` (AdminUserService.ListUser) honor the request
it currently discards. Today the handler signature is
`ListUser(ctx, _ *ListUserRequest)` — it ignores `search`/`start_date`/
`end_date`/`page` and returns EVERY user, doing an N+1 `GetProfile` (which
includes a live wallet call) per row. The backoffice player list only works
because it filters/paginates the full dump client-side; that breaks as the
user table grows, and TASK-EAR-130 deliberately stopped sending `page.size`
so the FE wouldn't advertise pagination the backend didn't honor. This task
makes it real.

## Scope

In:
- shared-lib (`adminuserpb`): add `basepb.Pagination page = 3` to
  `ListUserResponse` (additive field number — wire-safe; carries
  size/total/totalPage back to the FE). Request already has
  `search`/`start_date`/`end_date`/`page`.
- Games-Labs-User:
  - New repo method `ListPlayers(ctx, filter)` returning
    `([]*models.AdminPlayerRow, total int64, error)`: WHERE builds from
    search (ILIKE over username/email/phone/display_name), date range on
    `created_at`, `soft_deleted_at IS NULL` (unchanged — deleted players
    stay excluded from the list, see Known limitations), LIMIT/OFFSET,
    plus a COUNT over the same WHERE. **LEFT JOIN user_profiles** so
    display_name/level/lifetime_topup/lifetime_ggr come back in ONE query
    — kills the per-row `GetProfile` (both the DB round trip AND the live
    `wallet.SumLifetimeTopup` gRPC call per row).
  - Mirror the existing `ListLevelConfigs` filter/pagination pattern
    (levelConfigListWhere + count + LIMIT/OFFSET, default 20 cap 100 →
    use default 10 cap 100 to match the FE page size).
  - Handler: read `req.GetSearch()`, `req.GetStartDate()`,
    `req.GetEndDate()`, `req.GetPage()`; map rows directly (no
    GetProfile); set `ListUserResponse.Page` (size/total/totalPage).
- api-gateway: shared-lib bump.
- Games-Labs-backoffice `index.vue`: send `page.size` + `page.offset`
  again; drop the client-side search filter and client-side slice; drive
  `totalEntries` from `res.page.total`; re-fetch on page/perPage change
  and on Search. Stats stay sourced from `/summary` (unaffected).

## Decisions

- **lifetime_topup source**: the list uses the stored
  `user_profiles.lifetime_topup` (consistent with PlayerSummary, which
  sums that column), NOT the live wallet sum. The single-user GetProfile
  detail path keeps the live wallet call where accuracy matters.
- Search is button/Enter-driven (server round trip), not live keystroke
  filtering — correct for a server-paged list.

## Known limitations (unchanged, documented not fixed)

- Deleted players (`soft_deleted_at` set) remain excluded from the list;
  restoring one still requires navigating to its edit URL by id. Adding a
  status filter / deleted view is a separate product ask.
- `referral_code` is still not populated by ListUser (pre-existing; the
  handler never set it — out of scope).

## Acceptance criteria

- `GET /api/v1/admin/user?search=&startDate=&endDate=&page.size=&page.offset=`
  returns only matching rows for that page, with `page.total` = full match
  count; changing page returns different rows (not a client slice).
- No per-row wallet/profile calls in the list path (verified by reading the
  handler — single query).
- `go build`/`go test` green in User; backoffice `npm run build` green;
  Browser-pane capture shows `page.size`/`page.offset` sent and paging
  driven by server total. PRs opened (User+gateway → staging, FE → main).
