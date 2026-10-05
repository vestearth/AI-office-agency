# TASK-VS-017 — Send stable idempotency keys from first-party verify UI

## Context

The 2026-10-05 ECS screenshot shows repeated warnings for live
`POST /v1/slips/verify` calls without `Idempotency-Key`. The current API accepts
those calls but uses a per-request fallback key, so a transport retry cannot
replay the first attempt. `TASK-VS-016` fixes the database connection held by
keyed verification, but does not make a missing-key caller retry-safe.

Source inspection found that the first-party `slip-front-end` manual QR flow
calls `POST /v1/slips/verify/qr-code` with an API key but no idempotency header.
It is a different route from the screenshot. In-repository load test callers of
`/v1/slips/verify` already send the header. The screenshot alone does not
identify the external payload caller.

## Goal

Make the first-party live verification UI send a valid key for each logical
attempt, reuse it when the same file and branch are retried after an uncertain
failure, and document the key requirement for live API integrations.

## Scope

- `slip-front-end/app/features/verification/`: supply a stable key from the
  manual QR flow and send it to `/v1/slips/verify/qr-code`.
- `slip-front-end/app/features/developers/`: explain that live `/v1/slips/verify`
  callers should send a stable key and reuse it on retries.
- `slip-api/internal/handler/middleware/cors.go`: permit `Idempotency-Key` on
  preflight requests from configured origins so the browser caller can send it.
- Record that the production screenshot is for `/v1/slips/verify`, a route not
  called by the first-party UI; identifying and changing that caller requires
  its owning integration.
- Preserve the API's optional-header contract and the intentional NOT_FOUND
  retry behavior. Do not change verification semantics, production, or external
  client code.

## Acceptance Criteria

- The UI request includes a key matching the API's 8–128 character header
  pattern, with one key per selected file and branch.
- Submitting the same file and branch again after an uncertain failure reuses
  the key. A different file or branch gets a new key.
- An allowed-origin CORS preflight for the QR verify route permits
  `Idempotency-Key`; an unapproved origin remains disallowed.
- The developer-facing live verify guidance explains stable key reuse across
  retries without suggesting that a demo call is chargeable.
- Relevant typecheck, lint, and build checks pass; no claim is made that the
  screenshot's `/v1/slips/verify` warnings are resolved by the UI change.

## Implementation and Verification (2026-10-05)

- The first-party manual QR request now sends a generated UUID as
  `Idempotency-Key`. An in-memory tracker hashes the selected file and pairs
  its digest with the branch ID. A retry of the same file and branch, including
  reselecting the file after an uncertain failure, reuses the key; a different
  file or branch gets a new key. The tracker clears after a persisted result
  is ready for display, while unsaved results, failures, or timeouts keep the
  key for retry.
- The developer page now identifies `/v1/slips/verify/demo` as a public mock
  endpoint and explains the branch API key plus stable `Idempotency-Key` for
  the live `/v1/slips/verify` endpoint. Demo code examples no longer send an
  unnecessary API key.
- Follow-up source inspection found `slip-api` CORS did not allow
  `Idempotency-Key`, which would block the new browser request at preflight.
  The task now includes that small middleware compatibility change. Allowed
  origins now receive `Idempotency-Key` in `Access-Control-Allow-Headers`;
  unapproved origins remain disallowed. The focused preflight test and
  `go build ./...`, `go vet ./internal/handler/middleware`, and
  `git diff --check` passed in the isolated `slip-api` task worktree.
- Focused Bun tests passed: valid key format, same-image retry, changed file,
  changed branch, and clearing after a completed attempt. `nuxt typecheck`,
  ESLint, production build, and `git diff --check` passed on the task worktree.
- Deploy the API CORS addition before the new frontend. The new browser header
  fails preflight against the old API. No deployment was performed here.
- The source commits are `6b3c8e9` (`slip-api` CORS) and `d7d4c33`
  (`slip-front-end`). Implementation PRs
  [slip-api #49](https://github.com/SparqLab/slip-api/pull/49) and
  [slip-front-end #6](https://github.com/SparqLab/slip-front-end/pull/6)
  targeted `main` and both merged on 2026-10-05. Frontend CI passed; the API
  repository had no check attached to the PR. API CORS promotion
  [slip-api #50](https://github.com/SparqLab/slip-api/pull/50) merged into
  `staging`; deployment workflow is pending verification. Frontend promotion
  [slip-front-end #7](https://github.com/SparqLab/slip-front-end/pull/7)
  is open until the API staging deployment and preflight are verified.
- API staging reached ECS task definition `slip-api-staging:106` with 1/1 new
  task running. A live `OPTIONS` request to
  `https://api-staging.up-slip.com/api/v1/slips/verify/qr-code` from origin
  `https://app-staging.up-slip.com` returned HTTP 204 and an
  `Access-Control-Allow-Headers` value including `Idempotency-Key`.
  Its GitHub deploy workflow was later canceled by a concurrent newer staging
  push; CORS remained in the newer API images, and the live preflight passed.
- Frontend staging promotion PR #7 merged. Its deploy workflow completed
  successfully, and ECS `slip-front-end-staging:80` ran 1/1 tasks.
- Read-only production log inspection of the screenshot interval found
  `/v1/slips/verify` requests from one Node user-agent, one branch, and one
  client IP. In a fresh 30-second sample at about 14:25 Thai time, all 74
  completed payload-verify requests were from that Node client. The warning
  still appeared 667 times in the preceding five-minute window. This is a
  distinct caller from the first-party browser QR flow, and its owning repo
  or deployment has not been identified.
- A read-only ECS check on 2026-10-05 found production slip-api running 3 of
  3 tasks at revision 66 with `POSTGRES_MAX_CONNS=80`. Its standard rolling
  deploy can overlap old and new lock protocols, so TASK-VS-016 needs a safe
  cutover before promoting this frontend to production.
- This changes only first-party `/v1/slips/verify/qr-code`. The screenshot's
  `/v1/slips/verify` warning source remains unidentified; the in-repository
  load test callers of that route already include the header. No production
  verification or external client change was performed.

## Notes

- Parent investigation: `ai-dev-office/runs/TASK-VS-016/task.md` and the
  2026-10-05 attached log screenshot.
- The payload caller's repository or integration owner was requested from the
  operator while the first-party fix proceeds.
- The task branch is `task/TASK-VS-017` in isolated `slip-front-end` and
  `slip-api` worktrees. First-party frontend production has not been changed.

## Follow-up evidence (2026-10-05)

- The operator does not know the Node caller's repository. AWS CLI checks used
  the verified `vestearth` identity (account `122991883560`). The logged client
  IP did not match this account's Elastic IPs, network interfaces, or NAT
  gateway addresses, so AWS CLI cannot map it to an owned ECS service here.
  Logs still identify one Node caller, one branch, and one source IP for
  `/v1/slips/verify`; repository ownership remains unknown.
- The API does accept a missing header today: the HTTP handler falls back to
  this request's server-generated request ID and returns it in the response
  header. That generated ID is per HTTP attempt, so a retry after an uncertain
  response receives a different key and does not deduplicate with the earlier
  attempt. A stable key must be retained by the caller across retries; deriving
  it only from payload would also replay a later intentional verification.
- First-party frontend staging promotion [PR #7](https://github.com/SparqLab/slip-front-end/pull/7)
  deployed successfully to `slip-front-end-staging:80` (1/1). Production
  promotion [PR #8](https://github.com/SparqLab/slip-front-end/pull/8) merged
  at `5900de3` after TASK-VS-016 phase 2 API completed. Production workflow
  37280766715 is still deploying; ECS revision `:40` has one running task
  while `:39` remains active during the rolling transition.
- API CORS header support is live in staging and production. TASK-VS-016 phase
  2 lease-only code is live on production revision `:70`, 3/3 tasks, rollout
  `COMPLETED`. Production CORS preflight from `https://app.up-slip.com`
  returned 204 and allowed `Idempotency-Key`.
- Frontend production promotion [PR #8](https://github.com/SparqLab/slip-front-end/pull/8)
  merged at `5900de3`; workflow 37280766715 passed. ECS
  `slip-front-end-production:40` reached 1/1 and rollout `COMPLETED`; the
  previous `:39` is drained. The public site returned 302 to sign-in. An
  authenticated manual QR verification was not exercised.
- Production logs still recorded 444 missing-key warnings for
  `/v1/slips/verify` during 15:00-15:04 Thai time, after the first-party
  frontend deploy. The route is distinct from the UI's QR route. A direct
  comparison with this AWS account's EIPs, network interfaces, and NAT gateway
  addresses across all 17 enabled AWS regions found no match for the logged
  client IP (no describe errors). The Node caller's owning repository remains
  unknown, and the screenshot warning is not resolved by this first-party task.
