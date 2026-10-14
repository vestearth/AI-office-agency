# TASK-VS-022: Admin bank-flows summary times out at 15s on month range

## Symptom
slip-admin KBank flow page (KbankFlowSummary.vue, default preset `month`) calls
`GET /v1/admin/verifications/bank-flows?from=<Bangkok month start>&to=<today 23:59:59.999>`.
On prod 2026-10-14 it returned 500 after 15001ms at 03:50, 03:51, 03:55 x2, 04:00, 06:17, 06:18, 06:33Z.
The error (logged since TASK-VS-020) is `summarize bank flows: timeout: context deadline exceeded`.
`BankFlowSummary` (repositories/bank_flows.go) runs one range query over every verified row of the
month, with a 15s floor.

## Constraint found
The http.Server has `WriteTimeout: 20s` (cmd/main.go). Any fill on the request path must finish inside 20s,
so caching the single month query would still fail on its first fill.

## Fix (SparqLab/slip-api#63, service only, SQL/contract/frontend unchanged)
- Ranges on Bangkok day edges are built from per-day `BankFlowSummary` calls.
- Closed days are cached per scope (merchant, branches, channel).
- Uncached days fill 4 at a time on a detached context, so progress survives an abandoned request.
- Only open days are scanned per call.
- Other ranges, and ranges over 93 days, keep the single query.

## Not addressed
- `/bank-flows/transfers` (about 3s on prod; COUNT + list over the same CTE).
- Same per-day-fill idea for VS-021 `/summary` (its cold fill took 15.1s on prod, under the 20s write deadline).

## Acceptance
- Prod: the KBank flow month preset returns 200. The first call per task may take up to a few seconds per 4 days;
  warm calls stay fast. There are no more `summarize bank flows ... deadline exceeded` for day-aligned ranges.
