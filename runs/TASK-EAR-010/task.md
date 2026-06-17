# TASK-EAR-010: Populate RateCatalog.created_at in Wallet (Option A)

## Short name
`wallet-rate-catalog-created-at`

## Type
bugfix / contract cleanup

## Priority
low (P3)

## Parent / Epic
- Parent: `TASK-EAR-001`
- Follow-up of: TASK-EAR-007 nit N3 (created_at unpopulated),
  re-raised as P3 in the TASK-EAR-008 code review pass.

## Background

`adminwallet.proto` `message RateCatalog` declares `created_at = 15`, but the
field was never populated — `rateModelToPB` only mapped `updated_at`, and
`models.RateCatalog` had no `CreatedAt` field. The DB column `created_at
TIMESTAMPTZ NOT NULL DEFAULT NOW()` **already existed** in
`migrations/014_create_rate_catalog.sql`; no migration was required.

Team chose **Option A** (wire the existing column through model + repo + proto
mapping) over Option B (remove from proto + shared-lib regeneration).

## What was implemented

Three files changed in `Games-Labs-Wallet` — no shared-lib change, no DB migration:

| File | Change |
| --- | --- |
| `internal/models/rate_catalog.go` | Added `CreatedAt time.Time \`json:"created_at"\`` |
| `internal/repositories/exchange_rate.go` | Added `created_at` to SELECT column list in `ListActiveRates` and `GetActiveRateByKey`; added `&rc.CreatedAt` to `scanRateCatalog` |
| `internal/core/handlers/adminwallethdl/grpc.go` | Added `if !rc.CreatedAt.IsZero() { out.CreatedAt = timestamppb.New(rc.CreatedAt) }` in `rateModelToPB` |

A new test `TestRateModelToPBMapsCreatedAt` in `grpc_rate_catalog_test.go`
verifies the field is non-nil and correct.

## Verification

```sh
cd Games-Labs-Wallet
GOWORK=off GOPRIVATE=github.com/SparqLab go build -mod=readonly ./...  # exit 0
GOWORK=off go test ./...  # all pass
```
