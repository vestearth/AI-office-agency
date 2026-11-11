# TASK-VS-065 verification and frontend handoff

## Current status — 12 November 2026 (Bangkok)

Implementation PR [#133](https://github.com/SparqLab/slip-api/pull/133) merged
into main as `615df268`. Earth then explicitly approved staging in the Codex
chat: “แจงรายการที่ผมต้องบอก viewsupat และ promote ขึ้น staging ต่อได้เลย”.
Authorization `authz-001` covers TASK-VS-065 and migration 082 on staging only.

Promotion PR [#134](https://github.com/SparqLab/slip-api/pull/134) merged
`main` into `staging` as `dd79bcf563d127480e43be262643c1cb76969fe9`.
The only new non-merge commit was `f31fd458` by Sichol-Earth. Dry-run T1 and T2
were both `f645cbb11de9aabcab9db087d495892d0d649f77`, byte-identical to the
reviewed implementation tree; T2 was inspection only. The staging merged tree
matches T1. No production promotion was performed.

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
