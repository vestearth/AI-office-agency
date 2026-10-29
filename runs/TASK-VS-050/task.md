# TASK-VS-050: Fix branch summary API lock contention for many-shop accounts

Scope: slip-api branch-package expiry processing and focused PostgreSQL regression tests. Prove non-due packages do not acquire renewal row locks; preserve due expiry and auto-renew behavior. Merchant summary endpoint currently returns intermittent 500s on staging. No runtime billing changes or production actions.

## Investigation and verification — 2026-10-26

- Read-only staging CloudWatch query for the reported merchant: 33 summary HTTP 500s, 7 HTTP 200s, and 1 HTTP 401 in the last-day sample. Several 500s took ~3 seconds. Generic response logging does not reveal the underlying PostgreSQL error.
- Source path: branch Summary -> BranchPackageRepository.ListByUserID -> processExpiredForUser. Previously, every package (including future active and already expired rows) entered renewal transactions locking branch/merchant/user/package rows.
- Fix: select only active packages with expires_at <= NOW() before entering the existing renewal transaction. Existing transaction checks and billing semantics remain in place. No schema/contract change; existing user/status and active-expiry indexes cover these predicates. Rollback: revert the query predicate change and redeploy the previous image; no data rollback required.
- Impact: ListByUserID and ListEventsByUserID share this expiry helper. Direct branch/channel operations retain their original paths.
- Regression evidence: TASK-VS-050 ev-003 fails on both valid non-due states with `lock user: timeout: context deadline exceeded` while an external transaction holds the user row. Initial authoring attempts ev-001/ev-002 included an unsupported cancelling-status fixture; corrected to the actual schema's active/expired states (migration 006). No pre-existing tests were changed or removed.
- TASK-VS-050 ev-006: focused real-PostgreSQL tests pass, including 82 shops; non-due active/expired reads; due expiry; paid auto-renewal; insufficient balance; pending plan change; cancellation at period end; repeated reads without double charging.
- TASK-VS-050 ev-007: go vet ./... passes.
- TASK-VS-050 ev-008: GOWORK=off go build -mod=readonly ./... passes.
- TASK-VS-050 ev-009: go test ./... -count=1 passes with the local repository PostgreSQL integration DSN configured.
- Local tests demonstrate the contention defect; they do not prove all observed staging 500s share this cause. No merge/deploy or authenticated staging acceptance has been performed.
- Verified implementation PR target: main (VerifySlip main -> staging -> prod; deploy workflows trigger staging/prod only).

Backend draft PR: https://github.com/SparqLab/slip-api/pull/98 (base main, head fix/TASK-VS-050-summary-locks, commit 82bd3be).

## Staging release and acceptance — 2026-10-26

Operator explicitly authorized merge/deploy staging and continued testing; recorded as authz-001.

- Backend implementation #98 merged to main as 64ae573; staging promotion #99 merged as 319f9ff0bc9376450555573724941de910367f22.
- Frontend implementation #14 merged to main as 098f3a3; staging promotion #15 merged as b43d889fb638037b39e41b933485c75f6916f089.
- TASK-VS-050 ev-011: backend Deploy STAGING run 40265948723 succeeded (https://github.com/SparqLab/slip-api/actions/runs/40265948723).
- TASK-VS-050 ev-010: frontend Deploy STAGING run 40265960254 succeeded (https://github.com/SparqLab/slip-front-end/actions/runs/40265960254).
- TASK-VS-050 ev-013: both ECS services completed rollout at desired/running 1/1. API slip-api-staging:156 uses staging-sha-319f9ff; frontend slip-front-end-staging:106 uses staging-sha-b43d889 (image tags read from those immutable task definitions).
- Browser QA used the existing authenticated Bombay staging session. Before reload it displayed only 2 branches for 82 shops and had failed summary requests in DevTools.
- TASK-VS-050 ev-012: two clean browser Network HAR captures each contain 82 unique merchant summary GETs, all HTTP 200, with identical summary bodies between loads (164/164 successful requests).
- Rendered card and table totals match API captures: 82 shops, 83 branches (81 active, 2 inactive), 67 shops with branches, 15 empty shops, quota sum 468052. No missing card legend counts.
- Reported merchant 2b568bcd-bb50-4794-9cf5-44a1d378cbad: HTTP 200 at 179.116 ms / 202.009 ms; 1 active branch, API quota 190, LINE quota 0.
- A previously working sibling, PW Test Shop 20260930032440077 (000025), still displays 1 active branch and quota 190.
- HAR request maximums were 202.131 ms / 217.940 ms across the two captures. These are observed samples, not a load-capacity guarantee.
- Read-only CloudWatch sample beginning 03:54:05 UTC independently observed 657 summary requests across 82 distinct merchant paths, all HTTP 200 (max server duration 226 ms); other operator refreshes may be included, so these are not attributed exclusively to this agent.
- Extracted response-only evidence (no authorization/cookie headers or unrelated profile/KYC bodies): evidence/staging-summary-acceptance.json. Temporary raw captures were reduced to summary responses before verification.
- Screenshot: /Users/earth/.codex/visualizations/2026/10/26/01a17634-68aa-7930-839f-6ae203c5d77d/staging-shop-summaries.png (SHA256 d2aa550142dd23ee4f9308a62afda994656e86a4f9406ad3f2316e684a8e49b9).
- No production release was requested or performed. Error/retry UI was covered by local failure regressions, not by deliberately injecting a staging outage. No shop/branch/package data was created or edited during QA.

## Production promotion — authorized 2026-10-26

Operator requested production deployment after staging closeout; TASK-VS-050 was reopened and production gates were added through governed writers. Authorization: authz-002.

- Verified cherry-pick-unique diff staging -> prod contains only implementation 82bd3be (API) / 9a97c08 (frontend). No schema/config/workflow changes in this promotion.
- API production PR #100 merged staging 319f9ff as c47e68713b5aa3abafea2bf075b08b00703f261a.
- Frontend production PR #16 merged staging b43d889 as 411f1f0a8086604df39cb619e9fec087dcf259e4.
- Accepted staging commits are ancestors of the promoted prod branches (verified with git merge-base --is-ancestor).
- Previous API task definition/image: slip-api-production:112 / production-sha-8477b0a, desired/running 3/3.
- Previous frontend task definition/image: slip-front-end-production:65 / production-sha-b3b5948, desired/running 1/1.
- Production workflows: https://github.com/SparqLab/slip-api/actions/runs/40268295415 and https://github.com/SparqLab/slip-front-end/actions/runs/40268296067.
- Rollback: deploy the previous known images/task definitions or revert the promoted fix and redeploy. No data rollback/migration is required.

## Production runtime outcome — 2026-10-26

- Our API Deploy PRODUCTION workflow 40268295415 succeeded (TASK-VS-050 ev-016).
- Our frontend Deploy PRODUCTION workflow 40268296067 succeeded (TASK-VS-050 ev-014).
- A subsequent teammate frontend release cadb720 started during final verification, creating slip-front-end-production:67. It includes 9a97c08 and keeps app/features/home/shop-summaries.ts byte-identical to our accepted implementation. Its CI and Deploy PRODUCTION 40268943782 also succeeded (ev-019). No edits or rollback were made to that release.
- Runtime check ev-018 correctly detected the intervening rollout instead of accepting stale revision 66; final validation was repeated against cadb720.
- Final ECS/ALB verification ev-020: API slip-api-production:113 / production-sha-c47e687 at desired/running 3/3; frontend slip-front-end-production:67 / production-sha-cadb720 at desired/running 1/1. Both rollouts completed and all serving ALB targets are healthy.
- Authenticated production smoke used an isolated tab in the existing production session. The existing one-shop/one-branch account rendered Summary successfully through repeated reloads, including after revision 67. Quota changed over time with live traffic; equality across reloads was intentionally not asserted. No shop, branch, package, verification, or payment data was created or edited for this smoke.
- Browser console inspection returned zero matching authentication-failed messages in the test tab.
- Read-only CloudWatch window beginning 04:21:54 UTC initially showed 3 summary HTTP 200s, one merchant path, max server duration 11 ms, and zero authentication-failed events (ev-017); final monitor re-run follows in the evidence ledger.
- Production smoke is scoped to the existing one-shop account. The 82-shop acceptance remains the recorded staging test; no many-shop account was created in production. Fresh logout/login and deliberately injected failure states were not tested.
- Direct public /health probe from Python received HTTP 403 (ev-015); /ready was not reached by that command. This did not establish an application outage. Readiness was checked through ECS completed rollouts, serving ALB target health, and the authenticated Summary flow instead. Public health/readiness endpoints were not externally validated.

- Final production monitor ev-021 covers 04:21:54–04:31:29 UTC: 4 summary requests, all HTTP 200, one observed production merchant, max server duration 11 ms, zero authentication-failed events; results are scoped to that interval. Temporary smoke-test tab was closed after verification.
- Production deploy and production acceptance completion gates passed with authz-002 and ev-014/016/019/020/021. The scope is now complete through production.
