# TASK-VS-094: Verification page quota tile and row quota show the real charge

## Request (operator, 2026-11-24)

QA on staging (test package, branch 719075, 24 Nov 2569 10:43–10:56 BKK) ran 7
`POST /v1/slips/verify/qr-code` checks that all answered bank 8404 (422
`rejected`). slip-api charged 4 (staging log `bank 8404 quota decision`:
true/false/true/false/true/false/true; quota history −1 at 10:43, 10:47, 10:50:31,
10:56). The branch package page showed "ใช้ไป 4" (right). The verification page
showed "โควตาที่ใช้ 7" and the row quota column "-1" on every row (wrong). The
operator asked to open a task and fix it.

## Cause

The portal guessed the charge from the status: the card summed `verified +
rejected` from `/v1/usage`, and rows treated every `bank_rejected` as 1. The
per-slip 8404 rule (TASK-VS-063: repeat within 24h and ≥30 s after the last
one is free) and the bank retry surcharge (TASK-VS-068) are invisible from the
status. slip-api never returned the ledger charge.

## Scope

- `slip-api` (SparqLab/slip-api#186, branch `task/TASK-VS-094-real-quota-charge`):
  history items carry `quota_charged` (sum of `quota_history` with reference
  types `verification` + `verification_bank_retry` for the page ids);
  `GET /v1/usage` returns `quota_charged` for the range (ledger on its
  branch/merchant index joined to the listed verifications; failure → field
  absent, logged). Internal `Usage` callers skip the lookup. No schema change.
- `slip-front-end` (SparqLab/slip-front-end#48, same branch name): rows and
  the card use `quota_charged` when present, otherwise the old guess.

## Acceptance

- QA scenario on staging after deploy: card "โควตาที่ใช้" = 4, rows show −1 on
  the 4 charged checks and 0 on the 3 free repeats, equal to the package page
  and quota history.
- Older slip-api (no field) renders as before.

## Deploy order and rollback

slip-api first (additive JSON fields), then slip-front-end; either order is
safe because the portal falls back. Rollback: redeploy previous images.

## Evidence (2026-11-24)

- slip-api: new PostgreSQL test (8404 ref-a charged, repeat free, ref-b
  charged → rows 1/0/1, total 2) seen failing (no field/method) then green;
  service test seen failing then green; `go test ./...` green; repositories +
  service packages green against a throwaway PostgreSQL 18.6.
- slip-front-end: `tests/verification-quota-ledger.test.ts` 2 of the first 4
  failed before the change, 5/5 after; all tests 103/106 with the same 3
  failing on `origin/main` (bun runtime / credit-deduction); eslint on
  changed files clean; `nuxt typecheck` clean.
- Not yet: staging smoke after deploy; query plan on production-size ranges;
  independent review.
