# TASK-VS-053: Use hourly rollup for scoped admin verification counts

Scope: slip-api only. Confirm same-snapshot raw/rollup production counts read-only; reuse hourly coverage splitting for scoped admin CountAll and CountAllByStatus. Preserve exact inclusive timestamps, all filters, raw fallback and response contract. Add failing-before regression tests and parity/coverage tests. Build, integration tests, vet; implementation PR into main only. No merge, deployment, schema or config changes.

## Implementation and verification — 2026-10-28

Implementation: `SparqLab/slip-api` branch `task/TASK-VS-053`, commit `ecaf2abfb591d937ddaf76a6e547ba46e4e635c8`.
PR: https://github.com/SparqLab/slip-api/pull/104 — verified OPEN, base **main**, head `task/TASK-VS-053`. Deployment workflows were inspected: staging/prod only. No merge or deployment.

- `CountAll` and `CountAllByStatus` reuse the hourly rollup for scoped, bounded filters. Existing `splitUsageRange` retains inclusive microsecond boundaries, whole-hour coverage and raw edges. Both sources are combined in one statement snapshot.
- Unscoped/open-ended/uncovered counts retain their raw query; coverage metadata uses existing missing-migration/no-row fallback. Raw fallback may still exceed the budget for a large uncovered range.
- No schema, migration, dependency, timeout, service contract, config or frontend changes.
- TASK-VS-053 ev-001: representative production merchant, 28-day interval, raw vs rollup comparison within one statement/snapshot. Verified=8,804,386; rejected=107,985; duplicate=191,436; all equal. Range is covered; operation took 5.834s with transaction-local planner controls for the raw oracle. No production data/config mutation.
- ev-002 RED: new real-PostgreSQL regression returns zero on old code after covered raw rows are removed behind the trigger, rather than the preserved rollup totals. Pre-existing tests were not weakened or removed.
- ev-003 GREEN: focused PostgreSQL regressions pass after implementation.
- ev-004: `go test ./... -count=1` passes with the localhost PostgreSQL 18.3 integration DSN enabled. Includes merchant/branch/multi-branch/channel filters, grouped counts, inclusive and sub-microsecond bounds, partial-hour edges, zero/partial/full/after-range coverage, stale rollup rows below coverage, reversed/empty/open-ended ranges.
- ev-005: `GOWORK=off go build -mod=readonly ./...` passes.
- ev-006: `go vet ./...` passes.
- `git diff --check` passes. Manual source/diff review found no contract, schema or credential changes.

Not verified: deployed patched endpoint, authenticated staging UI, production HTTP recovery or performance of this patch. The prior 0.357ms rollup probe was a diagnostic query, not a deployed-patch benchmark. Keep the task in_review awaiting review; implementation PR alone is not a runtime resolution.

## Release authorization and staging — 2026-10-28

Operator explicitly authorized merge/deploy and observation in chat. Grants authz-001 (staging) and authz-002 (production, TASK-VS-053 only) were recorded; deployment and acceptance gates declared.

- Implementation PR #104 merged to main 0f9ee271579b52ea5564cbbfda4d4bb590910d6d.
- Staging promotion #105 main -> staging merged as 7a611b9f1082f643ae57c46dee8e42b0450c8f78. Deploy STAGING run 40629983263.
- Previous staging task/image :158 / staging-sha-a4e246f; new task :159 / staging-sha-7a611b9. New task healthy; rollout was still draining at ev-010, so that observation alone is not a completed deployment.
- Staging authenticated Report UI, This month: merchant test package verified 7 / total 10; branch สาขา 3 verified 2 / total 3; no error. Evidence: evidence/staging-ui.json and staging-branch-count.png. Credentials were entered by the operator in the normal browser login; no token/credential extraction.
- ev-009 contains paginated staging COUNT-related logs. The new :159 task stream 512731bb96a04a90983c11f7c5a7d2a8 has 318 access entries, all 200, max 80ms in that sample. Counts include UI-generated daily rows/other activity and are not claimed as 318 independent monthly trials.
- Staging includes separately unapproved TASK-VS-052 for production. Production release branch starts from existing prod 0654241 and cherry-picks only ecaf2ab as 1c4c7e1a62165700d89d5acf6610ece05b63afc8. Stable patch ID identical: a9e26109b1429bdb53face2790bad5f68a7ebbb6. Only the three COUNT source/test files differ from prod; VS-052 quota-history files unchanged.
- Production PR #106: release/TASK-VS-053-production -> prod, prepared pending staging completion. Previous production task/image :114 / production-sha-0654241, desired/running 3/3. Rollback: redeploy :114 / prior image, no data rollback.
- ev-007 build and ev-008 full PostgreSQL-enabled tests pass on the isolated production release branch. No integration test was skipped through missing DSN.

Staging completed: ev-011 GitHub workflow success; ev-012 ECS :159 is COMPLETED, 1/1. Deploy/staging acceptance gates passed with authz-001. Global Report sibling after clearing filters: 401 verified / 521 checks. Production PR #106 merged as 742df4fd905f97514d70baae77213934262e264f; Deploy PRODUCTION run 40631130025 started. ev-014 verifies the prod delta is exactly the three COUNT files.

Fresh pre-production baseline: authenticated production Report showed "Could not load the report" in the Slips verified section (production-before-ui.json, credit entries excluded). ev-015 has 4 COUNT deadline errors in its old-task sample, all scoped merchant/status/from/to, span28, 10,000ms; latest request 6120db34e5a6cc126b459e85b3acf59d at 2026-10-28T04:10:13.46532922Z returned HTTP500. This is a current pre-rollout reproduction, not only the earlier historical screenshot.

## Production outcome — 2026-10-28 11:27 ICT

- ev-019: Deploy PRODUCTION run 40631130025 succeeded for prod 742df4fd905f97514d70baae77213934262e264f.
- ev-020: slip-api-production:115 / production-sha-742df4f, COMPLETED, desired/running 3/3; only one completed deployment remains. No scaling/config/migration changes. Previous :114 remains the rollback reference.
- Before test cutoff, all new tasks were RUNNING/HEALTHY on :115 and old tasks running0. production-smoke-start.json records cutoff 1793161145272ms. Logs are independently confirmed to come from all three new task streams.
- Authenticated production Report, same page that failed before deploy: global month now succeeds (8,814,212 verified / 9,115,504 checks in that snapshot).
- Month O2p succeeds (8,814,269 / 9,115,532); month O2p/5G succeeds (8,814,417 / 9,115,707); seven-day O2p/5G succeeds (2,723,775 / 2,832,254); month refresh repeats successfully (8,815,172 / 9,116,600). After ECS COMPLETED, another refresh succeeds (8,815,897 / 9,117,443).
- These UI values are separate live snapshots while customer traffic continues. The header and branch row are separate requests, so tiny count increases between them are not a same-snapshot equality test. Production raw/rollup same-snapshot equality is ev-001.
- ev-021 and derived ev-023: paginated post-cutoff COUNT-related access sample has 224 requests, all HTTP200, max265ms, zero filtered ERROR/deadline events. First access 04:19:12.109734169Z; last access 04:25:47.367644531Z; reviewed through 04:26:51Z. Task distribution: 73 / 75 / 76 requests. The sample includes UI-generated daily counts and repeated windows, not 224 independent monthly trials or a load test.
- ev-022: authenticated UI cases (no credentials/auth headers); image evidence/production-count-success.png contains only the successful slip-count section. Stage screenshot is separately retained.
- Tested recovery: the original bounded Report failure class now succeeds in the sampled monthly merchant/branch and seven-day windows. Not verified: every possible filter/account, unbounded or old uncovered raw paths, long-term absence of recurrence. No claim that SMTP/cooldown/digest errors were fixed.
- Production only received TASK-VS-053. TASK-VS-052 quota-history contract changes were excluded by verified release delta.
