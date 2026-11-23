# TASK-VS-093: Manual topic cover image: admin upload + portal card

## Request (operator, 2026-11-23)

Admin manual editing should accept an image that the merchant portal shows on
the manual home (`/manual`). The attached screenshot showed the **topic** cards
("เริ่มต้นใช้งาน · 4 บทความ"), whose artwork slot only held a preset icon. The
operator chose: image belongs to the topic (card cover), icon stays as fallback.

## Scope

- `slip-api`: `manual_topics.image_key` (migration `087_manual_topic_image.sql`,
  idempotent ADD COLUMN + CHECK, forward-only Down). Topic create/update accept
  `image_key` from the existing `POST /v1/admin/manual/images` upload, same key
  pattern as image blocks, object existence checked (422 `validation_failed`
  `image_key` / 503 `storage_unavailable`). Admin and public topic DTOs return
  `image_url`; public never returns the key. History snapshot includes
  `image_key`. Doc: `docs/manual-api.md`.
- `slip-admin`: "รูปการ์ด" upload/replace/remove in the topics modal (add and
  edit), thumbnail in the topic list, `ManualTopicImage.vue`.
- `slip-front-end`: `/manual` card shows the image (object-cover) instead of the
  icon when `image_url` is http(s); otherwise the icon as before.

Branches: `task/TASK-VS-093-manual-topic-image` in all three repos. PRs into
`main` opened 2026-11-23: SparqLab/slip-api#177 (`a19b60f`),
SparqLab/slip-admin#62 (`c33ec7d`), SparqLab/slip-front-end#42 (`7d63956`).
Independent review gate still pending before merge.

## Acceptance

- Upload in admin → save → `/manual` card shows the image; removing it restores
  the icon.
- Topic without image renders exactly as before.

## Deploy order and rollback

1. `slip-api` first (migration runs on boot; metadata-only ADD COLUMN).
2. Then `slip-admin` and `slip-front-end` (either order).

Topic PUT is a full replace: an admin build older than this change omits
`image_key` and would clear a topic's image if someone saves a topic from it
during the rollout window. Rollback: redeploy the previous images; the column
stays (the old binary selects named columns), artwork is kept.

## Evidence (2026-11-23)

- slip-api `go test ./...` green; `internal/manual` integration test against a
  throwaway PostgreSQL 18.3 container (`SLIP_API_MANUAL_TEST_DSN`) green,
  including 087 replay; seen failing with the repository change removed.
- slip-admin `node --test tests/*.test.ts` 26/26, `nuxt typecheck` clean; the new
  list-thumbnail UI test seen failing without the modal change.
- slip-front-end `eslint .` clean, `nuxt typecheck` clean (after installing the
  missing local `qrcode`/`pdf-lib` modules), `tests/manual.test.ts` 9/9. Other
  front-end test files fail under plain node on extensionless imports (they need
  bun, not installed here) — unrelated to this change.
- Local browser check with a mock API: admin upload → save sends `image_key`;
  portal card shows the image; topic without image keeps the icon.
- Not yet verified on staging (needs real S3 upload + deploy). NOTE: the
  `implementation_verification` gate was marked pass on 2026-11-23 before this
  staging smoke, which its declared reason includes; the writer cannot revert a
  gate. Treat the staging smoke as outstanding until recorded here.

## Review (2026-11-23)

Independent reviewer subagent: no blockers. Fixed after review — admin
stuck-upload flag + per-form upload state (`slip-admin` 244b8bf), PUT
keep/replace tests and clearer missing-image message (`slip-api` 208b2d0),
rollback order in slip-api#177 body. Verdicts posted as PR comments. Open
follow-ups (not blocking): portal icon fallback when the CDN image 404s;
`safeImageUrl` accepts http.

## Merged (2026-11-23)

Merged into `main` in deploy order: SparqLab/slip-api#177 (`38d3547`),
SparqLab/slip-admin#62 (`4cef3b8`), SparqLab/slip-front-end#42 (`88374b5`).
`main` does not deploy; nothing is on staging or prod yet. Next: promote
main → staging → prod through PRs (slip-api first; rollback admin first), then
the staging smoke (upload in admin-staging, check app-staging `/manual`).

## Staging promotion PRs (opened 2026-11-23, not merged)

SparqLab/slip-api#178, SparqLab/slip-admin#63, SparqLab/slip-front-end#43 —
`main` → `staging`. Scope `origin/staging..origin/main` = only the TASK-VS-093
commits. Dry-run trees (T1): slip-api `d372595`, slip-admin `7e0cc93`,
slip-front-end `a3bf2fa`; no conflicts. slip-api carries migration 087
(ADD COLUMN with constant default + CHECK on `manual_topics`, no index), which
the promote skill makes a STOP: merge needs the operator's go-ahead for boot-time
migration. Merge order slip-api → admin/front-end, each pinned to its head; the
merged tree must equal T1.

## Staging (2026-11-23, operator approved "อนุมัติ merge" incl. boot-time migration 087)

- slip-api#178 merged → staging `df99db5` (tree = T1 `d372595`), Deploy STAGING
  success, `slip-api-staging:221` COMPLETED 1/1. Boot log: `goose: OK up
  087_manual_topic_image.sql (25ms)`, listeners started, 0 ERROR/panic; old task
  drained cleanly. Public `GET /v1/web/manual/topics` returns `image_url`, no
  `image_key`.
- slip-admin#63 → staging `50d5176` (tree = T1), `slip-admin-staging:110`
  COMPLETED. slip-front-end#43 → staging `cc857c7` (tree = T1),
  `slip-front-end-staging:148` COMPLETED.
- A teammate then pushed `48c4ab3` (branches refactor, not this task) straight to
  slip-front-end `staging` and merged it as `5e0fe98`; deployed successfully and
  still contains this change. It will ride along to prod unless handled first.
- Rollback revisions recorded: `slip-api-staging:220`, `slip-admin-staging:109`,
  `slip-front-end-staging:147`.
- Smoke test (operator's Chrome, signed in by the operator): uploaded a 1200×500
  test PNG on topic `getting-started` in admin-staging → preview from CloudFront,
  PUT `/v1/admin/manual/topics/getting-started` 200, toast "บันทึกหัวข้อแล้ว".
  Public API returns the CloudFront `image_url` (GET 200 image/png 18192 B);
  app-staging `/manual` shows the image on that card, other cards keep icons.
  Removed afterwards at the operator's request: reopened edit still showed the
  saved image, "ลบรูป" + save → PUT 200; public API has no topic with
  `image_url`; app-staging card shows the rocket icon again. The uploaded S3
  object stays (no cleanup job, same as article images).
- Staging smoke for `implementation_verification` is now done.

## Prod promotion PRs (opened 2026-11-23, not merged)

- SparqLab/slip-api#179 and SparqLab/slip-admin#64:
  `release/TASK-VS-093-production` (= `origin/prod` + merge of `origin/staging`) → `prod`.
  Heads `c48a587` / `dfaba12`; merged trees = dry-run T2 (`d372595` / `7e0cc93`);
  scope `origin/prod..origin/staging` = only TASK-VS-093 commits.
- Prod before: `slip-api-production:168` (`production-sha-1dbe0aa`),
  `slip-admin-production:96` (`production-sha-c13ccb7`); both equal `origin/prod`,
  no deploy in flight. These are the rollback revisions.
- slip-front-end is ALREADY on prod: a teammate merged `staging` into `prod` directly
  at 17:16 (`d3c0f0f`, no PR), carrying `7d63956` (this task) and `48c4ab3`
  (their branches refactor); `slip-front-end-production:106` runs
  `production-sha-d3c0f0f`. Harmless for this feature (icon fallback until the API
  ships `image_url`).
- Merging #179 needs the operator's prod approval incl. boot-time migration 087
  (25 ms on staging). Then #64 after the API is live.

## Prod (2026-11-23, operator approved "อนุมัติขึ้น prod")

- slip-api#179 merged → `prod` `23f1e6a` (tree = T2). Deploy PRODUCTION success;
  `slip-api-production:169` (`production-sha-23f1e6a`) COMPLETED 3/3; rollout
  10:51:19Z → 11:00:11Z. Env (26) / secrets (1) / other container fields
  hash-identical to :168, image only. `goose: OK up 087_manual_topic_image.sql
  (32ms)`. Public prod `/v1/web/manual/topics` returns `image_url`, no `image_key`.
- slip-admin#64 merged → `prod` `42181b8` (tree = T2). Deploy PRODUCTION success;
  `slip-admin-production:97` COMPLETED 1/1; env/secrets/other identical to :96.
- Post-deploy evidence **ev-001** (`record-evidence.sh`, exit 0, VERDICT PASS),
  `/ecs/slip-api-production`, filter `"http request completed"` + `{ $.level = "ERROR" }`:
  before 10:39:00–10:51:00Z (17:39–17:51 ICT) 4047 requests, 5xx 0, ERROR 0,
  p50/p95 198/602 ms; after 11:00:30–11:12:30Z (18:00:30–18:12:30 ICT) 3959
  requests, 5xx 0, ERROR 0, p50/p95 203/553 ms; all reads complete (pages 1–3).
  Filter control: `{ $.level = "INFO" }` = 340 events in one minute. WARN steady
  (4119 → 4054, ~97% the pre-existing "verify without Idempotency-Key").
- Rollback revisions: `slip-api-production:168`, `slip-admin-production:96`
  (admin first).

## Follow-ups (2026-11-23, operator asked to do both)

- SparqLab/slip-front-end#44 (`1e34460`): `/manual` card falls back to the icon
  when its image fails (error event + on-mount `complete && naturalWidth === 0`
  check for failures before hydration; lazy loading dropped). Tests 10/10, manual
  files lint clean, typecheck clean; local mock check: 404 image → icon. Repo
  `main` CI already red from `48c4ab3` (teammate's lint errors in branches /
  packages files), so this PR's CI will be red for those files.
- SparqLab/slip-api#180 (`8605a0f`): background sweep of orphaned
  `public/manual/` images (unreferenced by topics or any article image block,
  older than 7 days; cap 100 / half of prefix; one task at a time; under the
  manual writer lock). `MANUAL_IMAGE_SWEEP` defaults to `dry-run`; deletion only
  with `delete`, which needs the operator's go-ahead (deleting data). Buckets are
  separate per env. S3 List/Delete permission of the service key is unknown
  (vestearth cannot read IAM / bucket policy) — staging dry-run log will show
  List. `go test ./...` + PostgreSQL integration green.
- Review (independent subagent): portal approve; sweep had a blocker (grace
  counted from upload, not from unlink) → fixed in `ca14722` with migration 088
  `manual_image_orphans` (first-seen-unreferenced stamps), S3 calls outside DB
  locks, writer lock dropped, JSON-path reference query, cap 100/run, shutdown
  log guard. Positive control: ignoring first-seen makes the grace tests fail.
- Merged to `main`: slip-api#180 (`2cccc0f`), slip-front-end#44 (`8c91e2f`,
  CI red only from the teammate's pre-existing lint errors in branches/packages
  files — checked in the CI log).
- Staging: slip-front-end#45 → `a269406` (tree = T1), `slip-front-end-staging:150`
  COMPLETED. slip-api#181 → `d96797b` (tree = T1, operator approved migration
  088), `slip-api-staging:222` COMPLETED; boot: `goose: OK up
  088_manual_image_orphans.sql (50ms)`, `manual image sweep configured
  mode=dry-run`, no errors. Rollback: `slip-api-staging:221`,
  `slip-front-end-staging:149`.
- First staging sweep (12:52:08Z): S3 List works (listed 10), then
  `manual image sweep aborted: 7 of 10 manual images unreferenced (more than
  half)` — nothing deleted (dry-run anyway). Cross-check: 42 published articles
  reference 2 distinct images publicly; the sweep saw 3 referenced (2 + a
  draft), so the query is not missing references. The 7 are real orphans
  (incl. the TASK-VS-093 test upload). The half-of-prefix guard is too strict
  for a small bucket and needs retuning before `delete` is useful.
- Guard retuned (operator: "ปรับกฎ"): abort when no listed upload is referenced,
  half-rule only from 50 uploads. SparqLab/slip-api#183 (`c8f08ef`), test
  reproducing staging seen failing first; `go test ./...` green. Merged to
  `main` (`2ccfda0`) and staging via #184 (`f4858b9`, tree = T1 `64e6084`) on
  the operator's "Merge + staging"; `slip-api-staging:223` COMPLETED 1/1, no
  ERROR. Sweep 13:29:18Z: `mode=dry-run listed=10 orphans=7 eligible=0
  deleted=0` (no abort). The 7 become eligible ~2026-11-30 12:52Z (first seen
  unreferenced 2026-11-23 12:52Z); the dry-run log will list them then.
  Rollback: `slip-api-staging:222`.
- Not on prod. S3 versioning and the key's Delete permission still unknown.

## Follow-ups: prod promotion PRs (opened 2026-11-23, not merged)

- SparqLab/slip-api#185 (`169121a`, T2 `64e6084`): sweep + guard; migration 088
  (50 ms on staging); dry-run by default. Prod now `slip-api-production:169`
  (= rollback).
- SparqLab/slip-front-end#46 (`97072cb`, T2 `a2732b3`): card icon fallback.
  Prod now `slip-front-end-production:106` (= rollback).
- Scopes `origin/prod..origin/staging` = only TASK-VS-093 commits; prod images
  equal `origin/prod`; no deploy in flight. Merging needs the operator's prod
  approval (slip-api incl. boot-time migration 088).

## Follow-ups on prod (2026-11-23, operator approved "อนุมัติขึ้น prod")

- slip-api#185 → `prod` `cd511bc` (tree = T2). `slip-api-production:170`
  (`production-sha-cd511bc`) COMPLETED 5/5 (rollout 14:01:44Z → 14:10:09Z);
  env/secrets/other hash-identical to :169. `goose: OK up
  088_manual_image_orphans.sql (41ms)`; all 5 tasks `mode=dry-run`. One 5xx
  during the rollout (14:01:44Z, old-image task): `/v1/slips/verify` 502 "bank
  verifier unavailable" — bank-connector path, unrelated.
- Post-deploy **ev-002** (exit 0, PASS): before 13:49:44–14:01:44Z 5891 req,
  5xx 0, ERROR 0, p50/p95 197/497 ms; after 14:10:30–14:22:30Z 5399 req, 5xx 0,
  ERROR 0, p50/p95 195/492 ms.
- First prod sweep 14:12Z on all 5 tasks: `listed=0 orphans=0 eligible=0
  deleted=0` — consistent with prod's 42 published articles referencing 0 images.
- slip-front-end#46 → `prod` `9b1164a` (tree = T2). `slip-front-end-production:107`
  COMPLETED 1/1; env/secrets/other identical to :106; app.up-slip.com/manual 200.
- Rollback: `slip-api-production:169`, `slip-front-end-production:106`.
- Open: `MANUAL_IMAGE_SWEEP=delete` not set anywhere (needs S3 Delete permission
  + versioning check; operator decision). Staging's 7 orphans become eligible
  ~2026-11-30 12:52Z (visible in the dry-run log).
