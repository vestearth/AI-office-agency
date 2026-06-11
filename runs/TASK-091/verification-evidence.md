# TASK-091 Verification Evidence

## Shared-lib contract phase

- Updated `shared-lib/proto/admin/adminorderpb/adminorder.proto`:
  - `CreateRedemptionItemRequest.total_quota = 24`
  - `UpdateRedemptionItemRequest.total_quota = 25`
- Regenerated shared-lib artifacts with:

```bash
cd /Users/earth/Documents/GitHub/shared-lib
make buf
```

- Verified shared-lib build/test health with:

```bash
cd /Users/earth/Documents/GitHub/shared-lib
go test ./...
```

Result: passed

## Downstream implementation

- Bumped `Games-Labs-Order` to `github.com/SparqLab/shared-lib v0.0.0-20260611104343-2c9648152bf6`
- Bumped `api-gateway` to `github.com/SparqLab/shared-lib v0.0.0-20260611104343-2c9648152bf6`
- Added `TotalQuota` to `Games-Labs-Order/internal/models/redemption.go`
- Mapped `req.GetTotalQuota()` in `Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go`
- Rejected negative `total_quota` in `Games-Labs-Order/internal/core/services/ordersvc/service.go`
- Updated repository quota sync so Gift items persist submitted quota and
  E-Voucher items still derive quota from code count

Focused TDD verification:

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Order
go test ./internal/core/services/ordersvc -run 'Test(Create|Update)RedemptionItem(AllowsGiftManualTotalQuota|RejectsNegativeGiftTotalQuota)'
```

Result:

- failed first because `CreateRedemptionItemRequest` / `UpdateRedemptionItemRequest`
  did not yet expose `TotalQuota`
- passed after implementation

Broader verification:

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Order
go test ./internal/core/services/ordersvc
go test ./...
GOWORK=off go build -mod=readonly ./...

cd /Users/earth/Documents/GitHub/api-gateway
go test ./...
GOWORK=off go build -mod=readonly ./...
```

Result: passed
