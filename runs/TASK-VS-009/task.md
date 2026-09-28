# TASK-VS-009 — Admin bank transfer summary and list API

## Request

The operator wants the live `KBANK in / out` admin page to use bank-separated API results for both the two summary cards and the Transfers list, including date, merchant, branch, direction, counterparty bank, search, and pagination.

## Scope

- `slip-api`: admin-authenticated, read-only bank-flow summary and transfer-list endpoints over verified `verifications`; aggregate the full filtered range in PostgreSQL and keep money as decimal strings.
- `slip-admin`: replace the 5,000-row client aggregation on the existing page with these endpoints; preserve the visible controls and labels.
- Work from `origin/main` in isolated TASK-VS-009 worktrees. Leave other tasks and the main checkouts untouched.

## Acceptance

- A verified slip is classified as out, in, internal, other, or unknown from normalized sender and receiver bank codes. The two cards group out by receiving bank and in by sending bank.
- Summary totals cover the whole selected range, with no 5,000-row cap. Admin filters match the existing page. The Transfers list supports direction and bank drilldown, search, and exact paginated total.
- Existing admin authentication guards the new endpoints. Invalid filters return 400. Existing APIs remain compatible.
- Focused tests and builds pass; browser/runtime verification is reported separately from local checks.
