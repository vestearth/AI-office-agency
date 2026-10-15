# TASK-VS-026: VerifySlip reliability: prove and fix recurring verification/report failures

## Request and scope

Operator requested source-backed investigation of aws-tracking reliability findings,
opening tasks for confirmed defects, and decision-grilling before implementing fixes.
Owns this investigation and minimal fixes in `slip-api` and, only if proven necessary,
`slip-system`. Read `aws-tracking` to interpret telemetry. Existing TASK-VS-018/019
own upstream-unavailable handling; TASK-VS-024/025 own cached bank-flow reporting.
Do not duplicate their completed changes or infer deployment from local main.

## Symptoms to verify

- Production `POST /v1/slips/verify`: 502 `bank verifier unavailable`.
- Admin verification list, daily, summary and bank-flow report query timeouts.
- `persist duplicate slip attempt failed`: canceled database work.
- Dashboard counts log entries rather than unique failed requests.

## Evidence and decision boundaries

- Compare current remote main/prod, rendered ECS image and bounded sanitized logs.
- AWS reads must explicitly use the STS-verified `vestearth` identity.
- No production writes, bank calls, load tests, data repair, migration application,
  commit, push, merge or deployment is authorized by this run.
- Trace each symptom to source and tests. Preserve public status mapping,
  idempotency, quota and tenant isolation. No automatic retry of live bank calls.
- Use existing aggregates before adding SQL/schema/dependencies. A database
  optimization needs query evidence; never increase timeouts as the sole fix.
- Decision-grilling resolves discoverable questions from source first. Ask exactly
  one material product/operations question only when evidence cannot settle it.

## Acceptance

1. Each finding is classified as confirmed defect, upstream failure with correct
   handling, historical/already addressed, or unproven, with evidence references.
2. Confirmed fixes have a focused regression failing before and passing after;
   build, relevant suites and vet pass on the final branch.
3. Existing API fields/statuses, credit policy and retry/idempotency semantics stay
   compatible; explicit boundary cases are covered.
4. Changes stay on a task branch from latest main; future implementation PR targets
   main. Staging deploy and runtime acceptance remain pending until authorized.

## Initial decisions

- Investigate all three symptoms together; separate implementation tasks only when
  ownership or acceptance needs independent work.
- Treat availability and error-log totals as signals, not proof of business impact.
- Rollback for code-only fixes is a revert; any schema proposal requires a separate
  reviewed migration decision before implementation.

## Current progress

See `investigation.md` for source/runtime findings, locked decisions, regression
evidence and the one pending bank-flow reproducer question. Report count/daily
changes are implemented and locally verified on `task/TASK-VS-026-reliability`.
Bank-flow transfer query investigation remains open; no claim of full resolution
or deployed recovery is made. Staging gates remain pending.
