# TASK-VS-073: SPAR-71 public manual CMS backend and staging delivery

## Production delivery and closure decision — 2026-11-18

Earth approved and reported completing production delivery in comment
`01a1eccb-9d54-7330-a840-9514f91651e0`. Jason requested task closure in
`01a1eccd-3c68-7ced-98c5-9ee5dd662b9f`; that decision supersedes the earlier
hold below. The existing `force-status-route.rb` writer allowed guarded closure
from in_review to done; readback confirms phase/state/current_agent are done.
All existing completion gates are unchanged and no follow-up gate was added.
Do not deploy or import more content as part of this completed delivery.

- Earth reports production content import through authenticated Admin API at
  03:42 UTC: topics 201 x8, articles 201 x61, reviewed seed payload SHA-256
  prefix `952f540e`, readback 42 published / 19 draft in seed order. No DB
  importer ran. Authenticated import/readback is operator-reported.
- Independently verified in ev-035: slip-admin PR #47 staging -> prod merged
  `2e787115327c47adc52fc758b58acf96893744a9`, pinned head `fd5d0b3`, tree
  `548ec57974346822690f062b0c172e255dadd45e`; Deploy PRODUCTION run
  `44232436293` completed successfully. Prod, staging, merged and pinned
  trees match.
- Independently verified in ev-035: slip-front-end PR #23 staging -> prod
  merged `7022c10eec7722d1cdf6e76275b2830df2ea9b76`, pinned head `3ae2d17`,
  tree `69548fb1fe2176467871d6f3d125f048cbed5937`; Deploy PRODUCTION run
  `44233097971` completed successfully. Prod, staging, merged and pinned
  trees match. Landing prod remains `e6dc302`; API manual stays Portal-only.
- Earth-reported ECS/runtime/rollback: Admin revision
  `slip-admin-production:92`, image `production-sha-2e78711`, rollback `:91`;
  Portal revision `slip-front-end-production:95`, image
  `production-sha-7022c10`, rollback `:94`. Earth reports COMPLETED 1/1 for
  both, unchanged env/secret hashes from their rollback revisions, and
  authenticated Admin reads displaying 8 topics/61 articles/42 published/19
  draft. No AWS/runtime credential inspection or rollback was performed here.
- Public production smoke independently passed (ev-035): 8 topics with
  article counts 4,7,5,6,3,7,6,4 and no-store; draft article API 404;
  app.up-slip.com/manual 200 without login redirect; api-response-codes 200
  with one rendered table, no visible raw separator, and "บทที่ 3 จาก 6".
- CI limitation (ev-036): Portal CI run `44233098854` fails existing lint in
  BranchChangePackageModal.vue and packages/api.ts. Both file blobs are
  unchanged from pre-manual main `3f3517b`. Deployment success is not an
  all-CI-green claim; no lint fix or new gate is introduced by this closeout.

Nonblocking follow-ups are in SPAR-72
(`01a1eccc-f541-702c-bde6-0f5d91c416ae`), verified backlog/unassigned:
Admin mock/error messages/field paths/environment Portal URL/final-topic rule/
move history; Portal link safety/error distinction/SSR 404; editorial summary
duplication and example LINE URL; first real production image upload/save
check. Production image upload is still untested because the seed has no
images. Staging test image and qa-vs073-* history remain as previously recorded.
SPAR-72 is not a completion gate or dependency of this delivered task.

See verification-evidence.md for source attribution, PR/run URLs and checks.
This session records the existing release and completes guarded task closure only;
it does not perform deploy, content import, cleanup, or follow-up implementation.

## Scope decision before production delivery — 2026-11-18 03:13 UTC (historical)

Authority: Earth comment `01a1eca4-f49d-7b21-b834-2b7c41aa2a73` and Jason
handoff `01a1eca6-4a5b-7acf-aadb-c2ea39f6e365`. This supersedes the landing
scope expansion in comment `01a1ea65-fce1-7e7d-acdd-da0be2b06931`.

- API manuals belong only to Portal: staging `app-staging.up-slip.com/manual`,
  production `app.up-slip.com/manual`. `up-slip.com/manual` retains its original
  static landing UI. No remaining landing implementation or production step.
- Landing changes were reverted by PR #23 into main at `19ef72c`, then PR #24
  main -> staging at `dc1674d`. GitHub confirms main, staging, pre-feature
  `0f0910c` and prod all have tree `03658f915e8419d089fe77e51b2dd292c3124da6`.
  Landing prod commit remains `e6dc302`; equal trees do not mean equal commits.
  Deploy STAGING run `44228202726` completed successfully at `dc1674d`.
  Earth reports staging task `slip-landing-staging:51`, image
  `staging-sha-dc1674d`, matching static text and removed manual detail routes
  returning 404. Those runtime observations were not rerun in this session.
- `slip-api` prod is already `d5a99e2d41589d761cc17adf02b455554218a668`.
  GitHub records `watcharapol-spl` merging staging directly into prod at
  `2026-11-17T09:44:41Z`; the commit has no associated PR. Earth reports
  migration `084_manual_cms.sql` applied in 74 ms. That migration duration is
  operator-reported, not independently checked against runtime logs here.
- Earth reported completing staging seed import through the authenticated
  Admin API around 16:30 UTC on November 17: 8 topics and 61 articles,
  42 published / 19 draft, public counts 4,7,5,6,3,7,6,4. This was not the DB
  script. The task-local DB importer is historical tooling; do not run it again.
- `staging_acceptance` remains `pass` based on Earth's authenticated QA in
  comment `01a1ea33-e7af-79f1-9734-73e8d96d5cd2`. Preserve that gate and all
  other gates, including `knowledge_closeout`; keep the task `in_review`.

Proposed production sequence, NOT approved to execute: (1) import content via
the production Admin API, (2) promote `slip-admin`, (3) promote
`slip-front-end`. There is no `slip-landing` step and no need to re-promote the
already deployed backend as part of this record. Earth must approve the plan
before any production/content action. This session is record-only: no deploy,
promotion, merge, content import, or task/gate closure.

Portal handoff: use the existing `useManualService`/mapper/types, rich-text
renderer and manual pages in `slip-front-end` (PR #21/#22), not a replacement
implementation. Contract: `slip-api/docs/manual-api.md` and Earth's latest
comment. Remaining Portal follow-ups reported there: reject `//` and `/\`
links, distinguish not-found from other load errors, and set real SSR HTTP 404.
The three Admin findings remain nonblocking follow-ups, as recorded on the
unchanged staging acceptance gate. See `verification-evidence.md` / ev-033
for GitHub evidence and the distinction from operator runtime reports.

## Original backend assignment (historical)

Backend phase of Multica SPAR-71, issue 01a1e79f-3c97-73b5-a69f-58a415266ff0.
Earth approval: comment 01a1e872-c8a6-7883-ac02-094ee232fb3d (2026-11-17).
Delegation: comment 01a1e873-2868-7e26-8364-4d4c59304a6d.

Scope: slip-api only, worktree ../slip-api-TASK-VS-073, branch task/TASK-VS-073
from main dde060a. Public Thai manual topics/articles for Portal UM1–UM3;
AdminAuth CRUD/order/image upload; two tables + JSONB sections; manual activity
CHECK/constants/whitelist. Public images from server keys, no branch variables,
single-version/last-write-wins. Reserved topic slug order; JSON cap 1 MiB;
file cap 5 MiB and multipart cap +64 KiB; structured manual errors. No landing,
Admin or Portal edits in this phase; no production promotion.

Contract: slip-admin/docs/user-manual.md plus approved SPAR-71 proposal and
review addendum comments 01a1e7a4-6514-7dfb-b1ec-50c21ae43649,
01a1e81d-3cb0-71e4-8d81-31edc03f209b, 01a1e845-c90d-7782-baaa-e9f96b5df460.

Acceptance: all 15 endpoints with exact wire names; published-only public
responses with no actors/drafts; transactionally safe reorder/move; stable slugs
and publication timestamps; 6 typed block variants, strict limits, safe image
validation; history persisted and readable for both manual entities. Preserve
Blog/auth behavior. Run real disposable PostgreSQL integration and concurrency
checks, focused HTTP/validation tests, full build/test, and staging smoke.
Record commands in canonical evidence ledger. Additive migration runs on boot;
rollback image while retaining manual tables and widened history CHECK.

Delivery: implementation PR targets main (verified deploy workflow: staging push
triggers Deploy STAGING); merge approved implementation then promote main to
staging through a separate PR and verify staging. Return commit/PR/deploy/smoke
evidence to Jason before Admin/Portal follow-up. Do not call full feature done
until those later phases and staging E2E are accepted.

## Backend review follow-up (2026-11-17)

Earth's review comment 01a1e8bb-612e-742a-8df1-50746ffd0211 requests two
corrections before production: preserve Blog upload validation messages and
reject client NUL text before PostgreSQL (422, not 503). Worktree
../slip-api-TASK-VS-073-review, branch fix/TASK-VS-073-review, from latest
main 3ea510f. Add real HTTP/PostgreSQL regression tests, capture failure before
the fix and success after, then open a reviewable PR into main. Keep this PR
unmerged pending review; do not repeat the prior unreviewed merge. Current
staging remains available for Admin work. No deployment or IAM mutation in this
follow-up. Add docs for display numbering and S3 permissions and clarify the
shared image error log. Heading/trim normalization and audit timeout/batch
changes remain separate nonblocking follow-ups. Gate backend_review_fixes
records the production prerequisite; staging_acceptance still awaits Admin QA.

## Manual seed operator command (2026-11-17)

Comment 01a1e91d-5b0a-7150-bae2-16c5945e34c2 authorizes preparing an
idempotent command from the existing Admin seed, with credentials read only
from named environment variables. Do not execute it against staging or
production in this preparation session and do not add a boot migration.
Deliver the command/file paths and local verification. The operator runs it
later using existing staging access. See `verification-evidence.md` for the
runbook and `import-manual-seed.mjs` for the implementation.
