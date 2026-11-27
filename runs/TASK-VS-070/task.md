# TASK-VS-070 — Use hourly rollup for admin daily verification counts

## Scope
- slip-api only; branch from latest main, implementation PR into main.
- Reuse usageCoveredFrom and splitUsageRange in AdminStatusCountsByDay. Whole covered hours read verification_usage_hourly; partial hours and uncovered history read verifications in one SQL statement snapshot.
- Preserve Bangkok day grouping, ordered nonempty days, all status counters, and [from, to) boundaries including PostgreSQL microsecond precision.
- Regression must fail before implementation and pass afterward against disposable local PostgreSQL. Add raw/rollup parity coverage for full/partial/missing coverage, partial hours, midnight, empty/reversed intervals and multiple merchants.
- No schema, dependencies, public API, timeout, production data/config or frontend changes.

## Authorization / delivery
Operator explicitly requested implementation, regression tests and a review PR into main. No merge or deployment is authorized. Existing staging checkout is left intact; implementation uses isolated slip-api-TASK-VS-070 worktree.

## Evidence context
Live investigation: production :148 / d567be9 includes VS-053/056 but /daily still calls raw AdminStatusCountsByDay. HTTP500 after 10000ms on 2026-11-12T02:41:51Z, request c29922ced160db7de6ba9bd18e02caff. Exact database wait cause remains unproven; production recovery/performance is outside this change's verification scope.

## Implementation / verification — 2026-11-12
- Commit b0fea9245107e60d61438d6f44cbd8d2ff53de8e, PR https://github.com/SparqLab/slip-api/pull/135. Remote verified OPEN, base main, exact head b0fea924, non-draft, merge state CLEAN; zero configured PR checks.
- Changes limited to verification.go and verification_summary_test.go; no schema/dependency/config/public-contract changes. Reuses existing range splitter and test fixture helpers.
- ev-001: first test invocation could not access the protected host Go build cache. Reran with approved escalation.
- ev-002 RED: new real-PostgreSQL regression on original source returned only 1 raw verification instead of the preserved rollup's 6 across two Bangkok days.
- ev-003 GREEN: all AdminStatusCountsByDay tests passed after the implementation, including 40 coverage/boundary parity combinations.
- ev-004: go vet ./... passed. ev-005: GOWORK=off go build -mod=readonly ./... passed.
- ev-006: GOWORK=off go test ./... -count=1 passed with SLIP_API_REPOSITORY_TEST_DSN pointed at disposable localhost PostgreSQL 18.3; repository integrations ran. Separate unrelated blog integration DSN remained unset.
- ev-007: git diff --check passed. ev-008: gh pr view verified base main and published head.
- No existing test/assertion was removed or weakened. Manual SQL/diff review checked coverage fallback, same-statement data snapshot, status null-to-zero handling, Bangkok grouping and half-open microsecond bounds. No additional helpers, dependencies or abstractions were added.
- No merge, deploy, production data/config mutation or production recovery/performance measurement. Uncovered historical ranges still read raw data.

## Review and release authorization — 2026-11-12
Operator requested a second review and explicitly authorized merge/deploy if clear. No blocking counting issue found on b0fea924. Rechecked coverage splitting and monotonic backfill metadata, [from,to) conversion at PostgreSQL precision, non-overlap/no-double-count, sums and zero status counters, Bangkok date grouping, multiple merchants and raw fallback. Fresh full repository-DB-enabled tests/build/vet passed (ev-009..ev-011).

Before promotion: main 615df26, staging dd79bcf, prod 146d702; no pending unrelated nonmerge commits in either promotion lane. Running prod :149 matches production-sha-146d702, 3/3 COMPLETED; staging :195 matches staging-sha-dd79bcf, 1/1 COMPLETED. System remains staging :34/prod :29. Rollbacks are API staging :195 and production :149. T1/T2 both c76c5ba86c2ed876d566aaa8d9ecda91cdefa5d8; exactly two source/test files, no migrations. PR135 merged pinned b0fea924 as main 2905d02 (ev-012). Staging PR137 main->staging merged pinned 2905d02 as0d4b39a; its tree equals T1. Deploy STAGING43150548296 underway. Authz001/002 cover staging/prod for PR135 only; delivery gates declared.

## Release interrupted by concurrent upstream change — 2026-11-12 10:53 ICT
- Watcharapol-spl pushed main2c1cbf7, staging8a0bc69 and prod302af62 while our staging workflow43150548296 ran. This canceled our workflow before its deployment. New staging43150646952 and production43150695800 were started by that separate release; PR135 is an ancestor of its prod branch. We did not create/merge this production release.
- Added unrelated commit: 2c1cbf7 by watcharapol-spl, add manual flag, 10 files including migrations/082_verification_manual.sql. Existing migrations/082_blog_actor.sql already owns version82. Per verifyslip-promote STOP conditions, no further release mutation was made; optional expanded-scope and explicit cancel-workflow approval questions are pending in chat.
- Local pinned Goose reproduction ev-014 confirms provider construction rejects duplicate version82 before any migration runs. Current runtime logs independently confirm the error: window2026-11-12T03:51:00Z..03:53:11.053171Z, all2pages per group; staging1 event and production3 events say migrations: goose provider: found duplicate migration version82, naming both files. Production new task9688940754f24726a208aed50773eeb3 on :150 exited1 (Essential container in task exited). These fatal startup messages are emitted at INFO, so ERROR-only observation would miss them.
- Current service still has old production :149 ACTIVE running3/3 and new :150 PRIMARY running0; staging old :195 running1 and new :196 running0. New artifact is production-sha-302af62. No completed rollout or endpoint acceptance for PR135; delivery gates remain pending. Cancellation alone would not roll back an ECS update already sent.
- Pre-release fixed12minute sample03:38Z..03:50Z (ev-013) read4pages/3973requests: one existing /v1/slips/verify HTTP502/ERROR, no daily traffic. This is baseline evidence, not a post-deploy failure attributable to PR135.

Operator answered all pending questions affirmatively: expanded combined-release review/acceptance, stop both workflows, and restore staging195/production149. Submitted gh run cancel for43150646952/43150695800, then ecs update-service to old revisions without force-new-deployment or desired-count change. Both API calls returned149 running3/desired3 and195 running1/desired1. TASK-VS-071 owns migration collision fix and combined redeployment; TASK-VS-070 delivery acceptance remains pending until that release is healthy.

## Final reviewed production outcome
PR135 passed a fresh source/SQL review and full PostgreSQL-enabled tests/build/vet, then merged main2905d02 and stagingPR137. Concurrent unrelated manual-flag release caused duplicate migration82; operator approved containment and expanded review. TASK-VS-071 corrected only the never-applied manual migration to083 (PR138), then promoted through stagingPR139 and productionPR140. Final imageproduction-sha-47e4245 / revision151 is COMPLETED3/3; staging197COMPLETED1/1, source b0fea924 is included (ev018).

Operator refreshed production Admin Overview. Own canonical ev017 (fixed05:43Z..05:46:14Z,all2pages1737requests,0parsefail) includes2dailyHTTP200 requests at16ms and11ms on new151tasks. No daily error/timeout in that window. The one bank-flow ERROR joins a different request toHTTP408/context canceled; checker globalzeroERROR assertion remains exit1, not hidden. TASK-VS-071 ev025 covers12m22s since rollout,5838requests/0fiveXX; its ev017 hashes all27config entries unchanged. This verifies sampled original-path recovery and preserves uncertainty about long-term recurrence and original query-vs-cache/pool wait breakdown. Longer-window check_after set for2026-11-13T02:00Z(09:00ICT).
