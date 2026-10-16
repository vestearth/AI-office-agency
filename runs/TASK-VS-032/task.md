# TASK-VS-032: Make TestScopedVerificationCountIsAnsweredByIndex branch case deterministic

Describe the scope and acceptance criteria here before work starts.

## Result (2026-10-16, Claude conductor lane)

PR: https://github.com/SparqLab/slip-api/pull/73 (branch task/TASK-VS-032-plan-test-deterministic, test-only)

Root cause: each tenant was one contiguous heap block, so merchant_id planner correlation
depended on random UUID order; at |corr|~1 a PG18 skip scan of
verifications_merchant_status_created_idx (branch_id Filter) won. Reproduced on pristine
PG 18.3 by inserting tenants in UUID order (corr 1.000 → exact CI plan); old test failed
1/10 fresh containers.

Fix: interleave tenants + permute created_at; target merchant 8 branches, verified 1 in 4.
Assertion unchanged.

Evidence: new test 0/40 fresh PG 18.3 containers; 0/60 after full suite on 3 used DBs;
RED without 061/062 (both cases → old (x, created_at) index + status Filter);
go test ./... -count=1 fresh DB all ok; vet + build ok.
Pre-existing, out of scope: TestAdminDailyCountsUsesBangkokDates fails on reused DBs.
