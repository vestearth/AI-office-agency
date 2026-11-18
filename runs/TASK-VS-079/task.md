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
