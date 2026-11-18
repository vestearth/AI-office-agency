# TASK-VS-079: slip-api LINE platform bot: group-bind reply rejected by LINE (adjustMode shrink -> shrink-to-fit)

Opened 2026-11-18 by the Claude conductor session, after Earth answered "Fix it here"
to the investigation below. Found while checking the TASK-VS-076 production window.
Each promotion step (main → staging → prod) needs Earth's go-ahead.

## Symptom

On 2026-11-18 the LINE platform bot rejected 2 replies with HTTP 400, at 07:55:38Z and
08:03:00Z: `A message (messages[2]) in the request body is invalid`, details
`invalid property /type`. Both were logged as `line reply failed` and
`line webhook event failed` (event_type `message`, platform_bot true).
TASK-VS-076 evidence ev-008 shows that the TASK-VS-076 deploy did not cause them.

## Root cause (investigation, 2026-11-18)

slip-api `5932478` (Refactor LINE webhook handling and update FAQ messages; on prod since
the 03:48Z deploy) added `"adjustMode": "shrink"` to two text components. LINE's text
component accepts only `"shrink-to-fit"`.

- `lineGroupSendSlipMessage()` (`internal/core/service/line_flex.go`) is `messages[2]` of
  `groupConnectedMessages`, the reply after a group bind succeeds. LINE rejects the whole
  reply. The binding is already saved (`groups.Upsert` runs before the reply), so the
  group is bound but gets no confirmation.
- The same message is `messages[0]` of `groupReadyMessages`: the reply on join to an
  already bound group.
- `alreadyLinkedIntro()` is `messages[0]` of `alreadyLinkedElsewhereMessages`.

Supporting evidence:
- A scratch walk of every reply builder found an invalid `adjustMode` at `messages[2]`
  only in `groupConnectedMessages`.
- Timing: the same branch created a LINE bind QR at 07:51:24, 07:55:30 and 08:01:23Z,
  each followed by platform bot webhooks. Both errors came about 1.5 s after a webhook.
- Slip-verify replies in the same window succeeded.
- No platform bot webhooks arrived between 03:50Z and 07:00Z, which is why the error
  appeared only then.

Not verified: LINE reports the pointer `/type`, not `/body/contents/0/adjustMode`. The
assumption is that LINE reports a flex part that fails validation at the message root.
That fits the index, but this message was never validated against the LINE API.
Acceptance on prod (a group bind with no `line reply failed`) settles it.

## Scope

- Set `adjustMode` to `"shrink-to-fit"` in `lineGroupSendSlipMessage` and
  `alreadyLinkedIntro`.
- `line_flex_faq_test.go` pins the wrong value in two assertions
  (`"adjustMode":"shrink"`). Correct those assertions to the LINE value. This fixes a
  wrong expectation and does not weaken the test.
- Add a regression test over the reply builders: every text component's `adjustMode`
  is `"shrink-to-fit"`. It must be seen failing on `origin/main` before the fix.
- Not in scope: other LINE copy or layout, webhook logic, other repos.

## Acceptance

- The regression test fails before the fix and passes after.
- Full `go test ./...` (with the repository DSN), `go vet ./...` and
  `go build -mod=readonly ./...` pass.
- PR into slip-api `main`. Merge and each promotion only on Earth's go-ahead.
- Production: after deploy, a platform-bot group bind (or join of a bound group)
  produces no `line reply failed` in `/ecs/slip-api-production`.

## Implementation (2026-11-18)

SparqLab/slip-api#157, branch `fix/TASK-VS-079-line-adjust-mode` on `main` 309660f:
`8d1f014` (regression test) and `15502f4` (fix plus the two corrected assertions).

- ev-001: the new test fails on `8d1f014` in all 4 cases (`adjustMode "shrink"`).
- ev-002: on `15502f4` the new test, `TestGroupSendSlipStaysOnTwoLines` and
  `TestAlreadyLinkedElsewhereMatchesCard` pass.
- ev-003: full `go test -count=1 ./...` with the repository and migration DSNs passes on
  `15502f4`.
- ev-004: `go vet ./...` and `go build -mod=readonly ./...` pass.

ev-001 and ev-002 print the slip-api commit they ran on. ev-003 and ev-004 ran in the same
worktree at clean HEAD `15502f4` right after, but their logs do not print it. The
evidence records' `repo_sha` is the ai-dev-office checkout the wrapper ran from, not
slip-api.

A search of CloudWatch from 2026-10-20 to 2026-11-18T08:20Z found no other LINE
`invalid property` errors: production has only these 2 events (4 lines), staging none.

Not merged. `main` also carries 309660f (watcharapol-spl, feat(line-webhook)), which is
outside this task. A promotion would ship it too, so it needs Earth's scope approval.

## Merged (2026-11-18T08:57:36Z)

Earth said "Merge it" and chose that over an independent review first. PR 157 was merged
into slip-api `main` as `1b63b6b` (parents `309660f`, `15502f4`), pinned with
`--match-head-commit 15502f4`. The tree `1294f4e` equals the PR head tree and the dry run.

18 s earlier, another session merged PR 158 (main → staging, `177a25f`) for `309660f`
only, with Earth's staging-only approval. So `309660f` is on staging, and its Deploy
STAGING run was in progress at merge time. This fix is not on staging or prod.

The next promotion has two parts:
- main → staging carries only `8d1f014` and `15502f4`.
- staging → prod carries those two plus `309660f`, which is outside this task and was
  approved for staging only. It needs Earth's scope approval.

## Promoted to staging and prod (2026-11-18)

Earth answered "Both, incl. 309660f": staging and prod, with 309660f (watcharapol-spl)
going to prod as well (authz-001, authz-002).

- **Dry run:** T1 = T2 = `1294f4e`, the main tree, on which the full suite passed (ev-003).
  No migration, no config or env change.
- **Staging:** first waited for the PR 158 rollout (`staging-sha-177a25f`) to finish. Then
  PR 159 merged main → staging at `7af8c5d` (tree == T1). `slip-api-staging:208` COMPLETED
  1/1 with a clean boot (ev-006). ev-005 is a failed run of the check script, whose env vars
  did not reach it. Rollback `:207`.
- **Prod:** PR 160 merged `release/TASK-VS-079-production` → prod at `e0cfe0c` (tree == T2;
  range `836e123..e0cfe0c` = 309660f, 8d1f014, 15502f4). `slip-api-production:159`
  COMPLETED 3/3 at 09:33:53Z. Env and secrets are unchanged from `:158`; only the image
  changed (ev-007). Rollback `:158`.
- **Acceptance:** a bind QR at 09:38:16Z was followed by platform-bot webhooks, and there
  was no `line reply failed` (ev-009).
  - The 12-minute window shows 5xx 2 → 1 and email-alert lines 0 → 0 (ev-008).
  - ev-008's FAIL verdict comes only from one `POST /v1/slips/verify` 502. That 502
    pattern existed before: 22 in the 6 h before, on the old image.
- **check_after:** 2026-11-19T09:40Z.

Open: `knowledge_closeout`.
