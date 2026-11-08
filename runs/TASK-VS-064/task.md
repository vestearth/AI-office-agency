# TASK-VS-064: slip-api: receiver-check lookup errors must not save a charged verified row

Opened 2026-11-08 by the Claude conductor. It comes from the independent review of
SparqLab/slip-api#125 (TASK-VS-063). The bug predates that PR and is outside VS-063's scope.

## Bug (on `origin/main` 7de73f8)

- `internal/core/service/verification.go` `VerifyBank` calls
  `receiverErr := s.assertReceiverCheck(ctx, branchID, resp)` after the bank has answered.
- `assertReceiverCheck` returns `s.br.GetByID` and `s.bar.ListByBranchID` errors as they are
  (DB timeout, pool exhausted, branch soft-deleted mid-request). Only `assertBranchReceiverMatch`
  (`condition.go`) returns `models.ErrReceiverMismatch`, and only for a verified response.
- `VerifyBank` treats **any** non-nil `receiverErr` as a mismatch. It relabels the record
  `status=verified` with `outcome_reason=receiver_mismatch`, saves it with quota, and returns the
  raw error.
- Effect of one DB error during the lookup: an 8404 or any other bank rejection becomes a charged
  "verified" row. The caller sees a 5xx (HTTP), an error reply (LINE) or a failed batch item with
  `quota_used=false`. The saved verified row then blocks the real slip as a duplicate.
- All callers pass an authenticated branch id (HTTP, gRPC, LINE, batch queue), so the error here
  is an infrastructure error, not a business outcome.

## Scope

1. Only `errors.Is(receiverErr, models.ErrReceiverMismatch)` takes the mismatch path.
2. A non-verified bank result (8404, rejection, not found) can never mismatch, so skip the
   receiver lookups for it. A lookup failure then cannot touch that result, and it is saved and
   charged by its own rule.
3. A verified result whose lookup fails: the merchant's receiver check could not run. Return the
   lookup error, save nothing, charge nothing. Never report an unchecked slip as verified. The
   caller retries (HTTP 5xx / LINE error reply / batch item `failed`, `quota_used=false`, which is
   what `queue.go` `batchOutcomeFromVerify` already gives a non-sentinel error).

Option 3 deviates from the requested default "fail open" (continue as if the check passed). See
the PR for the trade-off. Flipping it is a one-line change.

Out of scope (follow-up): `rejectIfDuplicate` errors (an `ExistsVerified` DB error) are also
treated as a duplicate in `VerifyBank`. That is the same defect class.

## Acceptance

- Regression tests in `internal/core/service`, seen failing on `origin/main` before the fix:
  - a branch repo whose `GetByID` fails plus a bank 8404 produces no verified or charged row;
  - a bank-account lookup failure on a verified result saves nothing and charges nothing.
- `GOWORK=off go vet ./...`, `go build -mod=readonly ./...`, `go test ./... -count=1` pass.
- A PR into slip-api `main`. Promotion to staging and prod waits for Earth (verifyslip-promote).
