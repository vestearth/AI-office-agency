# TASK-VS-065 verification and frontend handoff

## Follow-up: all 22 HTTP 408s — 12 November 2026 (Bangkok)

**Finding:** this cancellation/retry pattern predates the blog deployment. All 22 target requests came from the same authenticated branch and the same hashed client-IP/User-Agent group. The immediate observed chain is two `bank_network` RPC failures around 3.06 s and 6.13 s on different slip-system replicas, followed by API cancellation at 7.941–8.003 s. The exact upstream network failure and the identity of the component enforcing the apparent eight-second budget remain unproven.

**Caller-timeout clarification (operator follow-up):** the reported ten-second caller timeout comes from prior information; the operator does not have the caller SDK/options or a measured caller-side elapsed time. Treat ten seconds as unverified configuration context, not a directly inspected setting. `duration_ms` is the time from entry into `AuditLog` to downstream handler completion. This wrapper sits outside the router, so authentication, in-flight admission, body decoding and bank work are included in the roughly eight seconds (`ev-048`, source `146d702`). DNS, connection/TLS, upstream proxy work and HTTP header parsing before entry are outside that timer. A ten-second **total** caller deadline could therefore leave eight seconds at the app if two seconds had already elapsed; that is an example, not an observed missing-two-second measurement. Which clock the SDK timeout uses and who cancels remain unresolved. ALB timeout-attribute reads and S3 bucket discovery were denied with the available IAM permissions, so upstream access-log timing was not obtained. No eight-second application timeout or two-second auth/rate-limit deduction was found in this request path.

**Evidence against a new blog regression:** the preceding 24-hour window (11 November 03:28:27 UTC through 12 November 03:28:27 UTC) contains 26 verify HTTP 408s from the same branch, 25 near eight seconds (`ev-045`, 11 pages). Ten earlier examples on the proven `slip-api-production:148` tasks also join to the same two-error timing on distinct slip-system replicas (`ev-046`, 10/10 matched). The phenomenon was therefore present before this release; the absence in the original short baseline was not evidence that it was newly introduced.

The 22 target requests reached new :149 tasks that did not enter STOPPING until 10:59:57–11:00:58 ICT, well after the 10:36–10:38 ICT incident. They were not requests interrupted by shutdown of their receiving task. Migration 082 committed before listeners started at 10:29, almost seven minutes before the first affected request. Verify service/handler/adapter and config source files were unchanged. Historical service revisions for :148 and :149 have equal Service Connect configuration (enabled), load balancers and network configuration; task-definition environment/secret entries are equal (`ev-046`). Later combined-release/restore activity after 10:51 is outside this incident window and must not be conflated with it.

**Runtime/code mechanism:** `slip-system-production:29` runs `production-sha-171baeb`, with `TIMEOUT=3.05s`, `RESPONSE_HEADER_TIMEOUT=3.05s`, `MAX_RETRIES=0`. In that exact source, an HTTP client/network failure with an uncanceled RPC context becomes `bank_network`, then gRPC `Unavailable`. The API calls the RPC once; its configured default RPC budget is 15 s, and its HTTP read/write limits are 15/20 s. `context.Canceled`/gRPC Canceled map to logged 408, while deadline exceeded maps to 504. Thus an intrinsic 15-second API deadline is not the explanation for these eight-second cancellations. Server logs do not prove that the caller received a 408 response after disconnecting.

Two failures for one HTTP request on different replicas, with application retries disabled, are strongly consistent with Service Connect retrying the RPC. AWS documents two proxy retries; gRPC transparent retries do not replay RPCs already processed by application logic. This is a supported inference rather than a captured proxy attempt trace. A third in-flight call, who closed the incoming connection, the underlying DNS/connect/TLS/header/body failure, and bank billing/side effects cannot be established from these logs.

Sources: [AWS Service Connect retries](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts-deploy.html), [gRPC retry semantics](https://grpc.io/docs/guides/retry/), API source `146d702`, slip-system source `171baeb`; `ev-044`/`ev-045`/`ev-046`. CloudTrail lookup and load-balancer timeout-attribute reads were denied; no permissions or runtime configuration were changed.

**Follow-up direction:** confirm the caller/proxy timeout for this branch and align the end-to-end deadline with bank execution and retry budgets. [slip-system PR #19](https://github.com/SparqLab/slip-system/pull/19) is already merged to main (head `2256c624`, merged 5 November), adding a 12-second bank timeout and safeguards against ambiguous retries, including the workflow timeout values. Those changes are absent from the :29/171baeb runtime. Review and promote that existing fix through staging as a separate authorized release; increasing the bank timeout alone will not fix an outer caller still canceling at eight seconds. No production fix or rollback is performed by this investigation.

### Target request timeline (22/22 joined)

Times below are on 12 November in ICT. Offsets are milliseconds from the API request start, derived from millisecond logs; they are not physical bank-attempt or billing counts. Each row has two `bank_network` log events from distinct system tasks. Full safe trace IDs are retained; client IP, User-Agent contents and branch/account data are omitted.

| Request ID | API completion ICT | HTTP ms | First error +ms | Second error +ms | API task prefix |
| --- | --- | ---: | ---: | ---: | --- |
| `e7982a594170cc0c416ad2daeeb04898` | 10:36:07.491 | 7986 | 3068 | 6127 | `4aa41910` |
| `d731aed5589205978285cd1db3e10e4f` | 10:36:09.922 | 7986 | 3059 | 6143 | `c9f1c836` |
| `728de44be466cf48b6d041d930b32642` | 10:36:10.995 | 7973 | 3070 | 6144 | `4aa41910` |
| `5d8b02a7807241e5c8be4b7dd13c0db3` | 10:36:12.879 | 7997 | 3070 | 6132 | `4aa41910` |
| `74468a454e1dd01ca3e9aaa2a6d8a740` | 10:36:15.010 | 7984 | 3065 | 6141 | `4605859a` |
| `80b6b112b53e4802f0487d7e99c5914e` | 10:36:15.525 | 7952 | 3070 | 6130 | `4aa41910` |
| `225f40cfb7dc0fdda4b48956f4970bd3` | 10:37:47.658 | 7995 | 3062 | 6128 | `c9f1c836` |
| `d415577afee5c32d0aa916742138a402` | 10:37:49.581 | 7965 | 3070 | 6129 | `4aa41910` |
| `6e4279f8ba774efa39c81cebe38ade09` | 10:37:50.333 | 7997 | 3068 | 6129 | `4aa41910` |
| `1c190d83cc96a8d48d1e32c9b529de7f` | 10:37:50.902 | 7970 | 3063 | 6120 | `4605859a` |
| `127edc255f1c34f7e046cc9374a75610` | 10:37:51.307 | 7971 | 3068 | 6141 | `4aa41910` |
| `aa5448928ea7476595f819ab499df724` | 10:37:51.564 | 7941 | 3061 | 6128 | `4605859a` |
| `5ec847709d751d54a97672387f49116c` | 10:37:52.573 | 7961 | 3060 | 6147 | `c9f1c836` |
| `b336b7402b547bce7dc7e903ba390c45` | 10:37:52.910 | 7996 | 3071 | 6141 | `4aa41910` |
| `2e06ab4e71c07bc8379eb7f3645d313b` | 10:37:54.783 | 7993 | 3069 | 6151 | `4aa41910` |
| `257d3344371b2bdab696d42a94d589ec` | 10:37:55.279 | 7970 | 3067 | 6126 | `c9f1c836` |
| `4a0e2672634bda04d9dba017f223f07f` | 10:37:55.741 | 7971 | 3067 | 6147 | `4aa41910` |
| `5e5666aa32281e9a2d4aa078112a0e38` | 10:37:56.955 | 7974 | 3068 | 6148 | `4aa41910` |
| `8eaacbe7c6fe578a9a33f15d76268269` | 10:37:58.045 | 8003 | 3061 | 6124 | `4605859a` |
| `9d7476e52996e8fa8650ee523c7d5700` | 10:37:58.071 | 7983 | 3066 | 6124 | `4605859a` |
| `339f38a95a691e21e0dda264e39ff901` | 10:37:59.710 | 7990 | 3060 | 6122 | `c9f1c836` |
| `462c5e48e0c0786e8fc9b0ad6085afeb` | 10:38:00.646 | 7989 | 3061 | 6126 | `4605859a` |

The target read used 2 API pages and 2 system pages (`ev-044`). Historical comparisons used 11 API pages (`ev-045`) plus 2 system pages for the matched ten-request sample (`ev-046`). The first parser attempt `ev-043` failed on nanosecond ISO timestamps; `ev-044` supersedes it after normalizing timestamp precision. All reads were bounded and read-only. No code, runtime, credential, customer credit or billing state was changed.

## Production promotion — 12 November 2026 (Bangkok)

Earth explicitly requested “Promote ขึ้น prod ได้เลยครับ” after the preceding
staging report had identified authenticated admin acceptance as pending.
`authz-002` records production authorization for this feature; it does not
claim that the missing authenticated acceptance happened.

Production promotion PR [#136](https://github.com/SparqLab/slip-api/pull/136)
merged release branch `release/TASK-VS-065-production` (head `22258d90`) into
`prod` as `146d702a7a62a3e974f7547bfe85f2afa2fb9d7f`. Production range:
`d567be900e5394828e4359f6c2231764186dee0b..146d702a7a62a3e974f7547bfe85f2afa2fb9d7f`;
the staging range previously shipped was `fc678046..dd79bcf5`. The only new
non-merge feature commit is `f31fd458` by Sichol-Earth. Dry-run and final
production tree `f645cbb11de9aabcab9db087d495892d0d649f77` equals tested staging.
No unrelated commit, environment or configuration file is in the promotion.

The read-only production DB row-count/lock preflight could not run:
`GetSecretValue` was denied to profile `vestearth` (`ev-032`); DBeaver UI access
also failed before any action. No secret was exposed, persisted or changed,
and no IAM change was attempted. This limitation was disclosed in the chat
before merging. The migration plan remained the reviewed nullable-FK and
NOT VALID CHECK expansion, no backfill or index, with a five-second lock timeout.
Production subsequently logged migration 082 successfully applied in **56 ms**
and database version 82 at 03:29:07 UTC (10:29:07 ICT).

[Deploy PRODUCTION 43148184577](https://github.com/SparqLab/slip-api/actions/runs/43148184577)
succeeded. ECS reached PRIMARY COMPLETED at 03:36:58.490 UTC (10:36:58 ICT),
with all three desired tasks RUNNING/HEALTHY on `slip-api-production:149`,
image `production-sha-146d702` (`ev-038`, `ev-039`). Deployment started at
03:28:27.165 UTC (10:28:27 ICT).
Rollback baseline is `slip-api-production:148`, `production-sha-d567be9`, 3/3;
rollback keeps schema/history. The new task definition is `:149`, image
`production-sha-146d702`, with environment and secret entries compared equal
to `:148` without exposing values; CPU and memory are unchanged too. All three
new tasks started their HTTP listeners.

The final closed window 03:28:27–03:40:27 UTC (10:28:27–10:40:27 ICT),
12 minutes from rollout start, was read completely: 4 pages, 8,451 events,
4,164 HTTP requests, 0 5xx, 0 ERROR/panic/activity-save errors, and 0 non-JSON
lines. Histogram: 200=3,935, 422=96, 400=24, 409=82, 404=2, 401=3, **408=22**.
The pure post-COMPLETED subset contained 1,286 requests including 16 of the
408s. Before-window and rollout counts are separate, equal-duration samples;
overlapping early/mid/final windows must not be added together.

The 22 HTTP 408s require an explicit caveat despite passing the 5xx/ERROR
checks. All were `/v1/slips/verify`, `context canceled`, duration 7,941–8,003 ms,
at 03:36:07–03:38:00 UTC (10:36:07–10:38:00 ICT), distributed across the three
new tasks. All 22 request IDs joined to the unchanged `slip-system-production:29`
image `production-sha-171baeb`; matching logs report class `bank_network`
(44 matching log lines, not a count of billable attempts). The unchanged
`internal/handler/http/bank.go` maps context/gRPC cancellation to 408.
These facts do not establish who canceled or prove the network's underlying
failure or a deployment regression. No verify/bank path changed in this PR.

A follow-up closed window 03:38:30–03:42:00 UTC (10:38:30–10:42:00 ICT)
contained 1,302 requests, with no 408, 5xx or ERROR. No rollback was performed:
the symptom was absent in that subsequent sample, all desired tasks stayed
healthy, and there is no established causal link to the blog change. Do not
describe the release as having no failed requests; cancellation origin remains
unresolved and should be investigated if it recurs.

| Evidence | Scope | Result |
| --- | --- | --- |
| ev-032 | Bounded read-only DB preflight attempt | UNAVAILABLE: GetSecretValue denied; row counts/locks unverified |
| ev-033 | Production scope, tested tree and rollback baseline | PASS |
| ev-034 | Pre-deploy 03:14–03:26 UTC, every log page | 4 pages, 8,165 events, 4,066 requests, 0 5xx/ERROR |
| ev-035 | Production read-only smoke after new tasks were serving | PASS: 5 public posts, 4 categories, exact public keys and 401 auth boundaries |
| ev-036 | Early rollout 03:26:07–03:30 UTC | 2 pages, 3,003 events, 1,436 requests, 0 5xx/ERROR; migration and 3 HTTP listeners observed |
| ev-037 | Mid-rollout 03:30–03:34 UTC | 2 pages, 2,682 events, 1,336 requests, 0 5xx/ERROR |
| ev-038 | Exact expected-image ECS rollout waiter | COMPLETED `:149`, 3/3 |
| ev-039 | Workflow SHA, tree/image, all desired tasks healthy, config comparison | PASS: 3/3, environment/secret entries and CPU/memory unchanged |
| ev-040 | Complete 12-minute rollout window and pure post-COMPLETED subset | 4 pages / 8,451 events / 4,164 requests; 0 5xx/ERROR, but 22 HTTP 408s |
| ev-041 | All 408s joined by request ID to slip-system logs; safe aggregates only | 22/22 matched, class bank_network; cancellation origin/causality unproven |
| ev-042 | Subsequent 03:38:30–03:42 window | 2 pages / 2,637 events / 1,302 requests; 0 408/5xx/ERROR |

Authenticated `staging_acceptance` and `production_acceptance` remain pending.
`deploy_production` also remains pending in the Office gate graph because it
depends on the unresolved staging acceptance; actual authorized deployment is
recorded here separately rather than fabricating acceptance or weakening the
gate dependency. Keep the task in review. A native `check_after` marker at
2026-11-13 03:45 UTC (10:45 ICT) names two-admin actor/history acceptance and
the activity-save error check after viewsupat integration; no acceptance pass
or recurring automation is implied.

## Staging promotion — 12 November 2026 (Bangkok)

Implementation PR [#133](https://github.com/SparqLab/slip-api/pull/133) merged
into main as `615df268`. Earth then explicitly approved staging in the Codex
chat: “แจงรายการที่ผมต้องบอก viewsupat และ promote ขึ้น staging ต่อได้เลย”.
Authorization `authz-001` covers TASK-VS-065 and migration 082 on staging only.

Promotion PR [#134](https://github.com/SparqLab/slip-api/pull/134) merged
`main` into `staging` as `dd79bcf563d127480e43be262643c1cb76969fe9`.
The only new non-merge commit was `f31fd458` by Sichol-Earth. Dry-run T1 and T2
were both `f645cbb11de9aabcab9db087d495892d0d649f77`, byte-identical to the
reviewed implementation tree; T2 was inspection only. The staging merged tree
matches T1. At the staging closeout, no production promotion had been performed;
the later authorized production rollout is recorded above.

[Deploy STAGING 43089142512](https://github.com/SparqLab/slip-api/actions/runs/43089142512)
succeeded. ECS runs `slip-api-staging:195`, image `staging-sha-dd79bcf`,
PRIMARY COMPLETED, RUNNING/desired 1/1, task HEALTHY. Deployment started at
19:41:19.972 UTC on 11 November and reached COMPLETED at 19:49:57.857 UTC
(12 November 02:41:19–02:49:57 ICT). Environment and secret entries are unchanged
from `:194` (compared in memory without printing values). Rollback is
`slip-api-staging:194`, keeping the expanded schema and history. Production was
observed unchanged at `slip-api-production:148`, 3/3.

Boot logged `goose: OK up 082_blog_actor.sql (50ms)`, version 82, and HTTP
listener startup on the new task. The closed mixed-rollout window
19:38:50–19:52:00 UTC (12 November 02:38:50–02:52:00 ICT), covering merge
through two minutes after COMPLETED, was read in full: 2 pages, 15 events,
8 logged HTTP requests, all on the new task (200=4, 404=1, 401=3),
0 5xx, 0 ERROR, 0 panic/fatal, 0 activity-save errors, 0 non-JSON lines.
These observations prove boot and traffic; authenticated history writes were
not exercised, so the zero activity-save count is not feature acceptance.

| Evidence | Scope | Result |
| --- | --- | --- |
| ev-027 | Exact scope, merge trees, reviewed-tree equality, original ev-017 output hash, rollback baseline | PASS |
| ev-028 | Staging health/ready, exact public blog keys, packages, 404, unauthenticated admin/history 401 | PASS: 9 public posts, 5 categories |
| ev-029 | Exact expected-image ECS rollout waiter | COMPLETED `:195`, 1/1 |
| ev-030 | Successful workflow SHA, expected tree/image, HEALTHY task, unchanged env/secrets | PASS |
| ev-031 | Complete closed-window CloudWatch pagination, new task boot and traffic | PASS; coverage and counts above |

`implementation_verification` and `deploy_staging` are passed through the
governed gate writer. `staging_acceptance`, `deploy_production`, and
`production_acceptance` remain pending. SPAR-68 remains in review; production
requires a separate approval and migration preflight.

## Checklist for Earth to relay to viewsupat

The API is available on `https://api-staging.up-slip.com`. Implement the
following in `slip-admin`; this backend promotion does not implement the UI.

1. Show “แก้ไขล่าสุดโดย {name or email} · {updated_at}” in the post list and
   category list/modal. Actors are `{id,name,email}` or `null`; prefer `name`,
   fall back to `email`, show the email on hover, and show `—` for null.
   `created_by` can supply creator information in the detail view. Existing
   rows have no backfill and a deleted user becomes null. Keep the article
   `author` byline separate from editor identity.
2. Treat `created_by` and `updated_by` as read-only response fields. Preserve
   the existing create/update request body; the API resolves identity from
   the logged-in admin and clients should not send actor objects in writes.
3. Add a history panel from the post edit form and each category row:
   `GET /v1/admin/activity-logs?entity_type=blog_post&entity_id=<post UUID>&limit=20&offset=0`
   or `entity_type=blog_category&entity_id=<category slug>`. Use the post UUID,
   which remains stable when a draft slug changes, and the immutable category slug.
4. Display newest first, with action (`created`, `updated`, `deleted`), time,
   and `actor_name` falling back to historical `actor_email`. Show changed
   fields from `new_value.changed`; snapshots omit article bodies and long
   content, so this is a field-change history rather than a full-text diff.
   Category rename includes `new_value.post_count`; deletion includes
   `old_value.post_count` and `old_value.moved_to`. Moved posts each receive
   a category-change entry.
5. Handle `{items,total,has_more,limit,offset}` pagination, loading, empty,
   and error states. Refetch actor/history data after successful writes and
   refresh other affected rows after changing featured or deleting a category
   with a move. A category rename intentionally preserves post editor/timestamps.
6. On staging, verify with two admin users: create/edit and editor switch,
   cover upload/removal, featured toggles including the previously featured
   post, and category rename/reorder/delete-with-move. Verify history and
   pagination and the null/email fallback states. This authenticated acceptance
   is still pending; provide the observed results before production promotion.
7. Deploy the UI to staging against this API. On production, deploy slip-api
   first and wait for the separate API production acceptance before enabling
   the UI feature there. History remains best effort; monitor
   `save activity log` during authenticated acceptance and rollout.

The canonical contract is the README section
[`Blog editor attribution and history`](https://github.com/SparqLab/slip-api/blob/615df268d32f0973448695308f73febb0c1a0aaa/README.md#blog-editor-attribution-and-history-task-vs-065).

## Original implementation handoff (historical)

Implementation PR: https://github.com/SparqLab/slip-api/pull/133

Commit: `f31fd458bdfe5b8fad33b5617e6ba2963a6903ae`, branch
`task/TASK-VS-065-blog-actors`, based on main `814fc798`.
Multica: SPAR-68, run `01a1c4c8-b1e8-7cda-8ed2-010b4260a05a`.

## Verification

All commands ran through `scripts/record-evidence.sh TASK-VS-065`.

| Evidence | Command / scope | Result |
| --- | --- | --- |
| ev-001 | Source search, remote migrations, TASK-VS-066 PR state | 079 already used; main also has 080 and 081 |
| ev-002 | `go test ./internal/blog -run TestBlogActorAttribution -count=1 -v` on original behavior | RED: missing admin created_by |
| ev-013 | Focused actor, migration lifecycle, snapshot/privacy and router auth tests | PASS |
| ev-014 | Diff whitespace, changed file and every updated_at write inspection | PASS |
| ev-015 | `go vet ./...` on clean final commit | PASS |
| ev-016 | `GOWORK=off go build -mod=readonly ./...` on clean final commit | PASS |
| ev-017 | `go test -race -json ./... -count=1` on clean final commit | PASS: 585 test/subtest pass events, no skipped or failed tests |
| ev-018 | `ruby validate-yaml.rb TASK-VS-065` after governed review transition and knowledge closeout | PASS |
| ev-019 | GitHub PR 133 snapshot | OPEN, main base, exact f31fd458 head, no checks reported |

PostgreSQL 16 ran locally on disposable UTF-8 databases with
`SLIP_API_BLOG_TEST_DSN`, `SLIP_API_REPOSITORY_TEST_DSN`, and
`SLIP_API_MIGRATION_TEST_DSN` enabled. No real credential values are recorded.
The actual boot migration chain ran in repository integration; the focused
082 goose lifecycle starts with legacy seeded blog tables on an isolated schema.
It verifies Up/Down/Up, repeated direct Up, nullable old rows, FK enforcement,
the unvalidated CHECK enforcing new inserts, and history surviving Down.

Historical failed attempts stay in the append-only ledger: ev-003 used a
SQL_ASCII fixture (recreated as UTF-8); ev-005 compared JSONB formatting instead
of decoded metadata (corrected assertion); ev-007/ev-008 showed that old migration
033 hardcodes public.kyc_users and cannot run under an arbitrary search_path.
The actor migration fixture now uses its real predecessor migrations on an
isolated schema, while the full repository suite uses the existing public-schema
database harness. ev-008 also exposed the stale migration inventory count,
which is updated to the actual 82 files without removing inventory validation.

## Contract for Earth to relay to viewsupat

Admin post list/detail/create/update/cover responses and category
list/create/update return `created_by` / `updated_by` as `{id,name,email}` or
null. Display `name`, else `email`, with email on hover; show `—` for null.
The existing article `author` field remains the byline.

History:

```text
GET /v1/admin/activity-logs?entity_type=blog_post&entity_id=<UUID>&limit=20&offset=0
GET /v1/admin/activity-logs?entity_type=blog_category&entity_id=<slug>&limit=20&offset=0
```

Response: `{items,total,has_more,limit,offset}`, newest first. Use `actor_name`,
else `actor_email`; each item includes action/time, compact old/new snapshots,
and `new_value.changed` for updates. Category rename has `new_value.post_count`;
deletion has `old_value.post_count` and `old_value.moved_to` (slug or null).
Each moved post has an update with `changed: ["category"]`. The post UUID stays
stable across draft slug edits. Public responses contain no actor fields.

Ship slip-api before the admin frontend. Frontend implementation remains with
viewsupat via Earth and is outside this run's gates.

## Review and release boundary

Michael De Santa posted an independent APPROVE review on Multica at
2026-11-10 09:53:12 UTC for `f31fd458`, reporting his own PostgreSQL 16 race
suite rerun (585 pass, zero skip/fail) and vet. The review is recorded at
comment `01a1c4e0-3d45-7571-9f24-7a83132d74da` on SPAR-68; this is a reviewer's
report, separate from the implementation evidence above. No GitHub review is
recorded in the PR snapshot. Local tests do not satisfy staging or production
acceptance; no merge/deploy occurred. Every promotion requires
Earth's approval. SPAR-55 remains independently blocked and was not changed.
GitHub reported no CI checks on the PR snapshot; no CI success is claimed.
Office state moved through the governed dev-output writer to `review`.
Only the recorded knowledge-closeout skip is passed; implementation and all
environment gates remain pending. The original implementation handoff left
Office records uncommitted; Jason requested their publication in comment
`01a1c4e0-bbc3-793a-95f0-466599bd8c86`. The follow-up publishes only
`status.yaml`, `dev-output.yaml`, and this verification record under
`runs/TASK-VS-065/`, following the manual task-scoped sync in
`docs/multi-user-git.md`. The original dev output remains the historical
implementation-role handoff; no reviewer output is fabricated from the comment.

The repository allowlist deliberately keeps `evidence.yaml`, raw logs,
`meta.yaml`, and knowledge-closeout runtime records local. Their original
copies were delivered in the implementation comment's `TASK-VS-065-evidence.zip`
(attachment `01a1c4db-0af5-7d79-86b4-19f7ed98bdc2`); the follow-up supplies an
updated archive with the Office validation and publication evidence. Nothing
ignored is force-added. The final SPAR-68 reply provides the Office commit and
remote verification; publishing these records does not pass any acceptance or
promotion gate.

Migration: `migrations/082_blog_actor.sql`. A 5-second lock timeout bounds DDL
waits; inspect production activity row count and plan a quiet window before
promotion. The existing best-effort logger can lose history if its insert fails;
observe `save activity log` across the actual rollout window.

Rollback the image and retain schema. Old images accept nullable actor columns
but leave actors stale on writes. Goose Down removes the four actor columns and
retains the widened CHECK/history; deleting history to narrow it is not authorized.
