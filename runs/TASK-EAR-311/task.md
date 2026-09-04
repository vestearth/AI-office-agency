# TASK-EAR-311 — Fix 42P08 in Order integration test coupon_usages INSERT

## Type

bug

## Workstream

backend

## Priority

medium

## Created

2026-09-03

## Goal

`TestFailPendingCheckoutOrderReleasesReservationWithoutRegressingPaidOrder`
in Games-Labs-Order fails on origin/staging at
`tests/integration/purchase_test.go:120`:

    insert coupon usage: ERROR: inconsistent types deduced for parameter $5 (SQLSTATE 42P08)

Reproduced 2026-09-03 on a clean detached worktree of origin/staging
(64013bf) against local Postgres 16 through the real pgx driver. Not caused
by TASK-EAR-310 (PR #46).

## Root cause

The test's own raw INSERT (introduced with TASK-EAR-296, commit 3d80ac7)
binds `$5` to `campaign_day` (DATE, migration 028) and to `reserved_at`,
`created_at`, `updated_at` (TIMESTAMPTZ). Postgres cannot deduce one type
for the parameter. Production code in `internal/core/repositories/coupon.go`
is not affected: it passes `campaign_day` as its own `$n::date` parameter.

## Scope

- Split the DATE bind from the TIMESTAMPTZ binds in the test INSERT.
- No production code, migration, or contract change.
- The test itself is the regression proof; it must be seen RED before and
  GREEN after through the real driver (sqlmock cannot catch bind types).

## Acceptance

- `go test -tags integration ./tests/integration/ -run TestFailPendingCheckoutOrderReleasesReservationWithoutRegressingPaidOrder -count=1` passes on a fresh database.
- Full `./tests/integration/` suite has no other regressions.
