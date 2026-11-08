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
the PR for the trade-off. Flipping it is a one-line change. **Decision (Earth, chat,
2026-11-08, after the prod frequency check below): keep fail closed.**

4. Added at Earth's request on 2026-11-08 (same defect class). After the bank answers, `Verify`
   (legacy, gRPC) and `VerifyBank` treated any post-bank `rejectIfDuplicate` error as a duplicate.
   An `ExistsVerified` DB error saved a `duplicate` row that carried the Idempotency-Key and
   answered "duplicate slip" for a genuine slip, and a same-key retry replayed "duplicate"
   forever. Now only `models.ErrDuplicateSlip` takes the duplicate path. Any other error is
   returned without saving or charging, as the pre-bank check already does.
5. Added at Earth's request on 2026-11-08, after the independent review of items 1–4 (approved).
   `queue.go` `processJob` (single queue / HTTP overflow) called `VerifyBank` with
   `SkipReceiverCheck`, so the slip was saved and charged first. Only then did it load the
   default receivers. A `ListByBranchID` error marked the job failed while the charged row stayed.
   The receiver condition is now built before the bank call, so a lookup error fails the job
   before any bank call, saved row or charge.

## Acceptance

- Regression tests in `internal/core/service`, seen failing on `origin/main` before the fix:
  - a branch repo whose `GetByID` fails plus a bank 8404 produces no verified or charged row;
  - a bank-account lookup failure on a verified result saves nothing and charges nothing;
  - a failed post-bank duplicate check (`Verify` and `VerifyBank`) returns the error, saves no
    duplicate row, and a same-key retry verifies;
  - a queue job whose receiver lookup fails makes no bank call, saved row or charge.
- `GOWORK=off go vet ./...`, `go build -mod=readonly ./...`, `go test ./... -count=1` pass.
- A PR into slip-api `main`. Promotion to staging and prod waits for Earth (verifyslip-promote).

## Status (2026-11-08)

- PR: SparqLab/slip-api#127 (`task/TASK-VS-064`), into `main`, not merged. Commits:
  e19a09c receiver, 038fd73 duplicate, 802dc14 queue. Head is 802dc14.
- All five regression tests failed before their fix and pass after it. A mutation check shows
  each guard has its own failing test. On head 802dc14, `go vet`, `go build -mod=readonly` and
  `go test ./... -count=1` all exit 0. The raw output is in the PR.
- Independent review (reviewer lane) approved e19a09c and 038fd73. Open follow-ups from that
  review, not done here:
  - raw error text reaches LINE and gRPC users (existing pattern);
  - historical keyed `duplicate` rows from lost idempotency leases (count off-peak);
  - carrying `ReceiverCheckEnabled` in `BranchIdentity` so `GetByID` is skipped.
- Staging and prod promotion wait for Earth (verifyslip-promote).

## Prod frequency check (2026-11-08 ~15:10 UTC, read-only, counts only)

The queries ran read-only through ECS Exec on `slip-api-production`, with the same method as
TASK-VS-055 `prod-readonly-psql.py` (5 s statement timeout).

- **Receiver bug (1): no sign it has ever fired.** All time there are 5 `receiver_mismatch` rows.
  All 5 have bank code `0000` and sit on the one branch that has the check on (last one
  2026-10-08), so they are likely real mismatches. There are 0 rows with a non-verified bank code
  and 0 rows on branches with the check off. Either kind could only come from a lookup error.
- **Receiver check usage:** 1 of 10 active branches has `receiver_check_enabled`. In the last 30
  days that branch had no verifications. All verified traffic came from branches with the check
  off.
- **Duplicate bug (2): no sign in the last 24 h.** All 9,599 `duplicate` rows have a verified row
  for the same slip that was created before them. The 7-day query hit the 5 s timeout and was not
  rerun with a longer timeout.
- Both bugs are latent, with no observed damage, so no data repair is needed. The fail-closed
  choice costs roughly nothing at today's lookup-error rate. Its protection applies today only to
  the one enabled branch.
