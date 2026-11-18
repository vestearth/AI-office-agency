# TASK-VS-077: SPAR-72 Admin manual follow-ups

Multica SPAR-72 / 01a1eccc-f541-702c-bde6-0f5d91c416ae, run 01a1edb4-8b0f-7246-930c-58fc86095f5d. Tommy owns slip-admin only in isolated worktree from latest main; six Admin follow-ups, no API/schema/dependencies. Regression fail-before/pass-after, full test/typecheck/build. Open PR into main with SPAR-72 title, return head/tests/open gates to Jason for Michael review. No merge/deploy or production data; Portal/content owned by Claude Speed.

## Implementation scope and publication target

- Worktree: `/Users/earth/Documents/GitHub/slip-admin-TASK-VS-077`.
- Branch: `fix/TASK-VS-077-manual-followups`, based on fetched `origin/main` `8b0c40d`.
- Verified PR target: **main**, before publication. Both deployment workflow files inspected: staging push / prod push or workflow_dispatch, respectively. Creating this implementation PR does not deploy it.
- Admin manual code, shared activity field rendering, TH/EN manual copy, runtime config, environment template, Docker/workflow Portal URL propagation, existing manual docs and focused tests only. No other repository implementation changes.
- Remove unused seed/mock UI/service/error remnants; use resource-neutral not_found and field-path validation_failed messages; environment Portal links; allow deletion of the final empty topic; show topic old/new history values.
- Current API source verified from fetched `slip-api origin/main` `e132009f78cbd7986cad3a76554c56bbce126253`, `internal/manual/repository.go` DeleteTopic/articleValues and `docs/manual-api.md`: API permits empty-topic deletion, requires a different existing move_to for nonempty topics, already logs old/new topic slugs. No API/business-rule change is required.
- Preserve shared Blog history behavior and local credential files. NUXT_PUBLIC_PORTAL_URL is a public origin, not a secret; no credential values added.
- Regression evidence: ev-001 reproduced eight defects before changes; ev-010 exports baseline HEAD and proves ten failures / one pass including Portal-link cases. ev-008 was a test harness failure (older Python lacks tarfile filter), corrected by ev-010, not a product failure.
- Open delivery gates: Michael independent review through Jason, authorized staging QA after separate promotion, release and QA acceptance separately. Production content changes and first real production image upload/save remain external handoff; this task does not execute them. Claude Speed owns Portal changes and staging-only content before/after work.

## Approved merge and staging promotion — 2026-11-18

Authority: Jason comment `01a1edcb-52e0-7626-bff5-f283c1bc9af0`; Michael APPROVE
on pinned head in `01a1edc9-ac1e-706a-9495-22424ed8e65b`. No required code changes;
MINOR-1 (finer API field paths) remains outside this task. Existing independent
review gate passed through the governed writer; staging acceptance is still pending.

- PR #48 merged with `--match-head-commit 3dca9b82814381981a666417537c8c8a50cf2cd9`, main merge `6de87987441631f6e541820311218e4eceb3333f`.
- Separate PR #49, `main` -> `staging`, opened and remotely verified. Merged with head pinned to `6de87987441631f6e541820311218e4eceb3333f`; staging merge `b0d7de462f15fbbd5771054a5ce46af960a370e1`.
- Fetched staging tree equals the reviewed implementation tree; promotion contains only the approved Admin changes.
- `NUXT_PUBLIC_PORTAL_URL`: matches staging, verified before promotion merge (ev-018). No variable/secret values emitted. Effective value resolved from environment/repository/organization-for-repository variables and workflow fallback. ev-017 used an unavailable organization-level lookup; corrected repository-scoped inherited-variable lookup in ev-018 passes.
- Deploy STAGING run: https://github.com/SparqLab/slip-admin/actions/runs/44269249401, triggered by staging merge SHA. Its result is being collected by one foreground `gh run watch` call because the trigger explicitly requests deploy results.
- Pre-release staging rollback task definition: `slip-admin-staging:104`, image suffix `staging-sha-fd5d0b3`, previously completed 1/1. No rollback executed.
- AWS identity verified using profile `vestearth`: required account and user matched. Runtime inspection restricted to staging; no production workflow dispatch/push/runtime/data action.

### Staging result and acceptance boundary

- Deploy STAGING run `44269249401` completed **success** on `b0d7de462f15fbbd5771054a5ce46af960a370e1`; check/typecheck, build-push and deploy-ecs jobs all succeeded (`ev-020`, `ev-023`).
- Live staging readback (`ev-022`): task definition `slip-admin-staging:105`, image `staging-sha-b0d7de4`, single completed deployment, desired/running 1/1, pending 0. Runtime `NUXT_PUBLIC_PORTAL_URL`: matches staging. No variable values printed.
- Anonymous HTTP smoke (`ev-025`, curl): Admin staging shell 200 and served Portal config matches staging; unauthenticated Admin manual topics API 401; public topics API 200 (8 topics); Portal `/manual`, `/manual/getting-started`, `/manual/getting-started/how-up-slip-works` and the corresponding public topic/article APIs all 200 without login redirect.
- Smoke evidence caveats: `ev-021` was an indentation failure in the temporary harness before requests; corrected harness `ev-024` received HTTP 403 using urllib's default client. The curl HTTP checks with a normal browser User-Agent passed in `ev-025`. No claim is made about the cause of that client-dependent response.
- Browser interaction and authenticated CRUD/history/topic-delete QA remain unverified; `staging_acceptance` remains pending. MINOR-1 remains a separate API follow-up. No staging content edits, uploads, production push/dispatch/data operations or rollback performed.
- Working tree remains clean on the original Admin worktree branch. Office records/evidence remain local/uncommitted pending publication.

## Operator staging acceptance recorded — 2026-11-18

Earth report: SPAR-72 comment `01a1ee45-f387-7a7b-a9d5-23dd63c0b899`, created
10:48:44Z; authenticated tests performed approximately 10:09–10:25Z on Admin
staging `b0d7de4`. Jason accepts the report and explicitly requests recording
`staging_acceptance: pass` in `01a1ee48-9906-7d7b-977b-7ace0175c15d`.
The prior pending acceptance notes above are historical and superseded by this
operator decision. Source excerpt is recorded as `ev-026`, explicitly labelled
operator-reported; no independent authenticated retest was performed in this run.

- Checks 1–3, 5 and 6 passed: all 42 published links target staging; missing topic/article messages; TH/EN validation toast; moving articles before topic deletion; topic old/new history.
- Check 4 is partial: deleting an empty topic passed; deleting the only remaining topic was NOT tested because doing so would require removing the eight real topics. Jason explicitly prohibits continuing that destructive test. This limitation is retained on the accepted gate and does not imply full runtime coverage of the final-topic case.
- `validation_failed` reports `topic` as supplied by the API; finer field paths remain nonblocking MINOR-1 outside this task. Earth also observed that topic counts can be stale after another client changes data until reload; this is recorded as a nonblocking observation only.
- Earth reports removal of test topics `zz-qa-a`, `zz-qa-b`, `zz-qa-c` and draft article `zz-qa-article`; API readback restored 8 topics / 61 articles / 42 published, with public counts 4,7,5,6,3,7,6,4. Test create/delete history remains in activity log. No log cleanup is authorized or performed.
- Used the governed `update-completion-gate.rb` writer to pass only `staging_acceptance`, citing `ev-026` and recording `ran.by: operator` at staging SHA `b0d7de462f15fbbd5771054a5ce46af960a370e1`.
- Task remains `in_review` per Jason's explicit instruction not to close it. No production gates added; no writes to TASK-VS-073/078 or product repositories, and no deploy, runtime operation, content application, or extra QA test performed.
- Content decisions for the 28 articles and LINE OA sample URL remain open, with no editorial application. Office records remain local/uncommitted pending publication.
