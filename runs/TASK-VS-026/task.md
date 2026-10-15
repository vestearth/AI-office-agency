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
- Operator follow-up on October 15: "ทำ TASK-VS-026 ต่อจนจบได้เลย" authorizes
  completing this task through reviewed commit/push, implementation PR into main,
  main-to-staging promotion, staging deployment and authenticated acceptance.
  This supersedes the earlier investigation-only commit/rollout boundary.
- Follow-up on October 15 explicitly authorizes production deployment and read-only
  acceptance against real data. Preserve the production branch's workflow/config,
  existing desired count and pool sizes. Production data repair, live bank calls,
  load tests and unrelated migration/schema changes remain excluded.
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

See `investigation.md` for source/runtime findings, locked decisions and regression
evidence. Operator supplied the exact bank-flow reproducer; the query fix and
all-history platform-wide list/daily changes are implemented and locally verified
on `task/TASK-VS-026-reliability`. Cold-history backfill runs through existing boot
warm-up and the shared day store in seven-day batches. Cold/busy requests keep the
exact COUNT fallback. Merchant/branch/channel counts keep their original path.
Code review, clean-commit verification, staging rollout and authenticated acceptance
completed under the operator follow-up. Implementation 398ff26 merged via PR 66
to main, then PR 67 to staging 7a93ad0. Workflow 38694528604 succeeded; ECS revision
130 is HEALTHY 1/1, pending 0, COMPLETED. Subsequent explicit production follow-up
promoted staging through PR 68 into prod d35af57. Workflow 38696406338 succeeded;
production revision 89 is healthy 3/3, pending 0, COMPLETED. Authenticated global
history/status, daily and exact month/seven-day/SCB transfer cases pass on real
data. ev-063/064 show all 17 report requests HTTP 200 and no ERROR entries in the
14:07–14:16 Bangkok watch. See production-acceptance.md for counts, timing bounds,
rollback and limitations; this is not a load test or long-term latency guarantee.

Earlier October 15 refresh at approximately 13:40 Bangkok, before VS-026 rollout:
task branch included origin/main b3513e9 (LINE onboarding,
including migration 059). Correct the existing migration inventory test from 58
to 59 files; keep its Up/Down validation. No migration SQL change is in this task.
Latest full PostgreSQL 18.3 integration suite, race, vet and readonly build pass
(ev-040/041/044/045). Production revision 88 contains the LINE update, not VS-026;
the report errors still recur (ev-039/043). See investigation.md for time bounds.
