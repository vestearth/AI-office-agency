# TASK-VS-087: SPAR-75 account suspension response

Multica SPAR-75 / 01a1f26b-1899-7916-82f6-df3b7bf100fc. Earth approved the contract on 2026-11-19. Implementation owner is Tommy Vercetti through that Multica issue. Do not start a second office runner for this task.

Repo: slip-api only. Branch from origin/main. Open a PR with test results. Do not merge or deploy.

Contract:
1. Existing inactive accounts stay status inactive and suspension null. No backfill from logs and no guessed type, reason, times, or actor.
2. New suspensions store real data. Status is suspended or temporarily_suspended. Response includes id, customer-safe reason, started_at, resume_at only when temporary, and acted_by only when permanent. acted_by is a customer-displayable name. Document how Ops records and lifts a suspension. Schema changes ship with a migration that fits existing rows.
3. Sign-in returns a structured error with a stable code plus status and suspension after password or provider auth succeeds, and does not issue a normal session. Failed auth must not reveal suspension details. For an account suspended during an active Portal session, specify the GET /v1/me option for the owner while their token is still valid. Other endpoints stay rejected.
4. resume_at is the actual reactivation time. Document automatic resume at that time and test before and after it. Tests cover legacy inactive, permanent, normal, and failed auth.

Deliver the response contract and example payloads on the Multica issue for the frontend. Implement the clear parts incrementally.

## Follow-up approved 2026-11-19

On the same PR (head was `de73b09` when assigned), Google sign-in must not return suspension details for a Google account that is not linked to UpSlip when the only match is the email plus `email_verified`. Return those details only after ownership is established, such as a provider identity already linked to the account. Add a regression test that fails before the fix and passes after it for insufficient ownership, and keep the existing contract response, with no normal session, when ownership is already proven. Stay on `TASK-VS-087`. Do not merge or deploy. Admin and Portal UI are separate backlog issues and are not part of this task.

## Merge recorded 2026-11-19

Earth recorded that PR 164 merged to `main` at `20375208a96f6a08cddc39206b6223179349504f` at 15:03 Asia/Bangkok (`mergedAt` 2026-11-19T08:03:34Z). Parents are `ab78394e7dd31ee2090f084d15f1f5f5925c709e` and `dc061ebcb3f899cc04f7afc22b4ed315b43b1d8d`. Earth reported the Go suite on PostgreSQL 16 passed when re-run on this merge commit. GitHub check runs on the commit are empty, so that suite result is the operator report, not a CI snapshot. The merge tree differs from the reviewed tree of `dc061eb`. Production remains unauthorized.

`20375208a96f6a08cddc39206b6223179349504f` is evidence of the merge to `main` only. The `staging` branch has a separate history and a promotion PR may produce a new SHA. Joint QA confirms that the staging build contains the changes from PR 164, then records the SHA and image that were actually deployed. Admin and Portal use that same staging API during QA. They do not need the staging SHA to equal the main merge commit. UI work starts from the agreed contract when assigned. Waiting for the staging API blocks only the joint test. SPAR-76 owner is Niko Belic on slip-admin. SPAR-77 owner is Thanwa (thanwa-t), tracked on https://github.com/SparqLab/slip-front-end/issues/31, and he may proceed from the contract. Staging API for joint QA is `adb89e9d078b1a877a80118703ced3ca938af650`. It contains the main merge of PR 164. Admin PR 51 and Portal issue 31 were still open on 2026-11-19, so the joint test waits until both UIs are ready. Do not promote Admin or Portal to production.

Production workflow https://github.com/SparqLab/slip-api/actions/runs/44499504721 for PR 167 finished with conclusion failure at 2026-11-19T09:59:26Z. Image tag `production-sha-682216b` was pushed. `aws ecs wait services-stable` exceeded its max attempts. At 2026-11-19T09:48:58Z the service snapshot had one completed deployment with 3 running tasks and another in-progress deployment with 15 failed tasks. Earth reported that revision `:163` was 3/3 and `/health`, `/ready`, and `/v1/line/banks/scb.png` returned 200 while that workflow was still in progress.
