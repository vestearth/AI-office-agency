# TASK-VS-082: slip-api: stop auto-renew debits for packages on deleted branches

Opened 2026-11-19 by a Claude conductor side session. The independent reviewer
found the gap on 2026-11-18 while reviewing the TASK-VS-081 manual content batch
(Multica SPAR-72). The manual articles deliberately say nothing about renewal after
a branch is deleted. Each promotion step (main → staging → prod) needs Earth's
go-ahead.

## Suspected symptom

A merchant deletes a branch. Its branch package stays `active` with
`auto_renew_on_expiry = true`. When the package expires, the renewal path debits the
merchant's credit (`package_auto_renew`) and renews the package, although the branch
can no longer verify slips (API key revoked, LINE channel cleared).

## Code evidence (slip-api `origin/main` `1b63b6b`, read before the fix)

- `internal/core/service/branch.go` `Delete` calls only
  `BranchRepository.SoftDelete`. It does not touch `branch_packages`.
- `internal/repositories/branch.go` `SoftDelete` sets `status = 'deleted'`,
  `deleted_at`, revokes the API key and clears the LINE channel fields.
  `MerchantRepository.SoftDelete` cascades the same update to all the merchant's
  branches.
- `internal/repositories/branch_package.go`:
  - `RenewExpired` (the cron in `cmd/main.go`) and `processExpiredForUser` (run by
    `ListByUserID` / `ListEventsByUserID`, i.e. whenever the merchant opens the
    package list) select active expired packages with no join on `branches`.
  - `processExpiredForBranchChannelTx` calls `lockBranch`, which reads
    `branches.status`, but never checks it. `Purchase` does check it (branch and
    merchant must be active).
  - `expireOrRenewIfNeeded` → `resetFromCatalog` → `debitUserBalanceWithLedger(...,
    CreditTxnActionPackageAutoRenew, ...)` when `AutoRenewOnExpiry &&
    !CancelAtPeriodEnd`. The only existing no-debit guard is `lockErr`, set when the
    owning user is inactive or missing.
  - `RequestPlanChange`, `CancelSubscription` and `UpdateRenewal` call
    `expireOrRenewIfNeeded(..., nil)` on a locked package without checking branch
    status either. `ListByUserID` lists packages of deleted branches, so these are
    reachable from the dashboard.
- Quota-exhausted renewal (`consumeQuotaInTx`) is not reachable for a deleted
  branch: verification resolves the branch through `FindByAPIKey` / the LINE channel
  lookup, which both filter `deleted_at IS NULL AND status <> 'deleted'` (and a
  revoked API key).

## Scope

- Regression test (real PostgreSQL, `SLIP_API_REPOSITORY_TEST_DSN`): an expired,
  active, auto-renewing package on a deleted branch must expire with no credit
  debit and no `package_auto_renew` ledger row. It must fail on `origin/main` first.
- Smallest fix in the renewal path: a deleted branch blocks renewal the same way an
  inactive user already does (expire, no debit). This also covers branches deleted
  before the fix and merchant deletion (which cascades to branches).
- Not in scope: paused (`inactive`) branches or merchants. The manual says a paused
  branch's package keeps counting down; whether it should keep auto-renewing is a
  product question for Earth, not changed here. Also not in scope: changing what
  `Delete` writes, refunds, or data repair.

## Acceptance

- The regression test fails before the fix and passes after (evidence recorded with
  `scripts/record-evidence.sh`).
- Full `GOWORK=off go test ./...` with the repository DSN, `go vet ./...` and
  `go build -mod=readonly ./...` pass.
- PR into slip-api `main` with the analysis. No merge, no staging/prod promotion
  without Earth's explicit go-ahead.
- Prod impact: this machine has no prod DB read access. The PR lists the read-only
  query Earth would run to find `package_auto_renew` debits on deleted branches.
