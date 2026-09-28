# TASK-VS-006 — Branch auto-renew toggles show ON, revert to OFF after refresh

## Why

Operator video (2026-09-26, prod app.up-slip.com, branch 5G `816d9bc9-…`, API channel, Enterprise Plus):
both "ต่ออายุอัตโนมัติ" toggles show ON when you navigate in from the branch list, and OFF after a hard
refresh. The toggles were not clicked in the video.

## Findings (verified 2026-09-26 on slip-front-end 88c4299, slip-api origin/main)

- The toggles' only data source is `GET /v1/branch-packages` → `watch(subscriptions)` in
  `slip-front-end/app/features/branches/composables/useBranchDetail.ts:291`.
- `persistAutoRenew` (`useBranchDetail.ts:~813`) ignores the PUT response body. On 2xx it keeps the values it
  **sent**, and patches the `ups-branch-packages:*` Nuxt cache with them. The UI shows ON until a hard refresh
  refetches the DB value.
- `slip-api` `BranchPackageRepository.UpdateRenewal` (`internal/repositories/branch_package.go:~646`): when the
  row's `price` is free (`packageIsFree`), it silently forces both flags to FALSE and returns **200**. This is the only
  path besides cancel that drops the flags, and cancel was not clicked.
- Prod logs (`/ecs/slip-api-production`): every `PUT /v1/branch-packages/{id}` on 2026-09-25 returned 200, and there
  has been no PUT since 2026-09-25 11:04Z. So the ON state was the stale optimistic cache, not a fresh save.
- Not proven: the 5G row actually having price 0 (no RDS access on `vestearth`; prod API needs a token).
  Circumstantial: ~60 `PUT /v1/admin/packages/*` on 2026-09-25 03:50–03:57Z, before branch 5G was created (07:33Z)
  and bought its package (07:35Z). Purchase copies catalog price into `branch_packages.price`.

## Scope

1. **Frontend:** `persistAutoRenew` uses the values returned by `updateRenewal` for both state and cache. If the
   server returned values other than the ones requested, show a toast. (Disabling the toggles on free packages was
   dropped to keep the approved UI design unchanged; the 409 toast covers it.)
2. **Backend:** `UpdateRenewal` on a free package returns an error (409 `auto renew is not available for free
   packages`) when any flag is requested true. Requesting false/false stays 200, so clients can still turn it off.

Out of scope, reported to the operator: audit the 2026-09-25 admin catalog edits for paid packages accidentally set to
price 0 (money path: those purchases were not debited).

## Tests

- Backend RED: repository test against real PostgreSQL (`SLIP_API_REPOSITORY_TEST_DSN`). Seed a free branch
  package, call `UpdateRenewal` with true → expect `ErrAutoRenewFreePackage` (currently returns nil with flags
  false). Plus: false/false on free still succeeds, and true on a paid package persists.
- Frontend: **blocker, no test runner in slip-front-end** (package.json has no test script and no vitest).
  Verify with `nuxt typecheck` + `eslint` + a local browser check.

## Deploy / rollback

Independent. Deploying backend first is safe: the current frontend shows a toast on the 409 and rolls back.
Frontend alone is also safe. Rollback = revert the pin/commit. No schema change.
