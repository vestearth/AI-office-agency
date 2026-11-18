# TASK-VS-073 — backend delivery

Current release record is the production-delivery section below and the
production-delivery section in `task.md`. Earlier sections preserve the evidence at
the time of each phase; their pending/import/prod statements are historical.

Multica SPAR-71 / `01a1e79f-3c97-73b5-a69f-58a415266ff0`.
Earth approval: `01a1e872-c8a6-7883-ac02-094ee232fb3d`.
Staging grant: authz-001; no production grant or action.

Implementation commit: b4a5c361c6b44e585725c1062f487cfc58bb619d.
PR https://github.com/SparqLab/slip-api/pull/145 merged into main at 3ea510f.
PR https://github.com/SparqLab/slip-api/pull/146 promoted main to staging at
46f32b0cc382daff554e9de22daf5875a6bec266. Actual merged tree equals dry-run tree
1531b8b07b30300a0fb035dff3ce9dad6370d82e. No unrelated patch-unique commits.

## Local verification

- ev-007: `GOWORK=off go vet ./...` passed.
- ev-008: `GOWORK=off go build -mod=readonly ./...` passed.
- ev-009: full `go test -race -json ./... -count=1` passed on clean b4a5c36:
  697 test/subtest pass events, zero failures and zero skips. PostgreSQL 18
  integration enabled for manual, Blog, repository and migration suites.
- Local fixtures used a disposable PostgreSQL container, stopped after testing.
- New manual tests cover real migration/CRUD/history through the HTTP router,
  draft visibility/navigation, publication semantics, block variants, boundaries,
  fail-closed auth, move/reorder atomicity and concurrent writers.
- Existing credential-source test moved with shared image storage and kept its
  assertions. Blog API wrappers and namespace remain compatible.
- Earlier ev-001 failed on sandbox Go cache access, rerun with approval as ev-002
  passed. ev-003 exposed a moved private field dependency in the old Blog test;
  relocating that test with its implementation preserved coverage. ev-004/005
  passed after correction. All failures remain in the append-only ledger.

## Staging verification

- ev-010: https://api-staging.up-slip.com health 200; existing Blog public read
  200; manual topic list 200; missing topic/article 404 with `not_found` and
  `Cache-Control: no-store`; unauthenticated Admin topic/article reads 401.
  Portal/Admin staging origins both passed CORS preflight (204 with matching ACAO).
- ev-011: image staging-sha-46f32b0, task definition slip-api-staging:201,
  1/1 tasks; boot migration `084_manual_cms.sql` applied in 136ms. New task log
  window 08:00:41–08:07:06 UTC on 2026-11-17: 41 events, zero ERROR/panic events.
- ev-012: ECS rollout COMPLETED on the exact image, running/desired 1/1.
- ev-013: Deploy STAGING run 44043125251 completed success at the expected SHA:
  https://github.com/SparqLab/slip-api/actions/runs/44043125251.
- Rollback revision: slip-api-staging:200. Retain manual tables and widened
  history CHECK; image rollback does not destroy content/history.

## Open acceptance and handoff

- staging_acceptance stays pending: authenticated staging CRUD/history and
  real S3 upload/HeadObject were not exercised without an admin session.
  Their handler/repository paths were tested locally against real PostgreSQL
  and stubbed object storage. Verify actual storage permissions during QA.
- Admin then Portal implementation remains separate. Portal must make /manual
  and descendants anonymous, render Thai content with an English UI notice,
  and use safe block/Markdown rendering. Frontend staging E2E remains open.
- API handoff: slip-api/docs/manual-api.md at the implementation revision.
- Multica PR auto-complete disabled for SPAR-71 so backend merges cannot close
  the multi-phase feature. Leader can restore it for the final delivery.
  Multica's PR link table was empty at readback; GitHub URLs/state above are
  independently verified and are provided explicitly in the result comment.
- Knowledge capture proposal and same-scope closeout recorded; librarian audit
  unavailable (no matching agent/runtime/subagent tool). No vault edit.
- Office task records are local pending review/publication; no claim that they
  were committed or synchronized to the Office remote.

## Staging seed request — 2026-11-17, blocked on existing access

Request: Multica comment 01a1e916-6e99-7b2a-af9f-69e5c5a567d7 authorizes
loading the Admin sample manual into staging only, preserving seed statuses,
without duplicate rows on repeat or a production boot migration. It explicitly
allows reporting an access blocker without requesting a token in the issue.

- ev-025: executed the existing `slip-admin/app/features/manual/seed.ts` exports
  with Node's TypeScript stripping. Working file, fetched origin/main and
  origin/prod have identical blob `5e0c82a3ca60f694f9a010eb32f9d1fb018d9ce2`.
  Expected input: 8 published topics, 61 articles (42 published, 19 draft).
  All 61 article slugs are unique. These are source counts, not imported counts.
- ev-026: verified `vestearth` operator account/ARN and current staging service
  task definition `slip-api-staging:203`, image `staging-sha-0b548a6`.
  PostgreSQL is reachable but the existing local authentication attempt fails
  with `no password supplied`. Reading its configured `POSTGRES_PASSWORD`
  Secrets Manager reference returns `AccessDeniedException` for
  `secretsmanager:GetSecretValue`. No credential values were written or logged.
  Python urllib requests in this probe received Cloudflare 403/1010; the curl
  checks below independently establish the application responses.
- ev-027: curl GET `https://api-staging.up-slip.com/v1/web/manual/topics`
  returned HTTP 200, body `[]`, `Cache-Control: no-store` at 10:44:15 UTC.
- ev-028: curl GET `/v1/admin/manual/topics` without an existing session
  returned HTTP 401, `invalid token`. No local PostgreSQL credential/profile
  or existing Admin token was found in the inspected runtime environment.

Result: no rows imported or updated; database contents/counts and repeat-run
idempotence remain unverified. No importer, migration, product code, IAM change,
deployment, or production action was made. Stop at the requested access
boundary; an operator with existing staging DB/Admin access must run the import
or establish an approved access path outside the issue. Do not send credentials
in comments. `staging_acceptance` remains pending; this probe does not prove
authenticated CRUD/history or real S3 behavior.

## Prepared operator import — 2026-11-17 (not run against staging)

Follow-up authorization: comment 01a1e91d-5b0a-7150-bae2-16c5945e34c2.
Files are local task artifacts in `ai-dev-office/runs/TASK-VS-073/`:

- `import-manual-seed.mjs`: Node 24 + installed `psql`; no new dependencies.
- `import-manual-seed.test.mjs`: disposable local PostgreSQL integration and
  validation against the reviewed Go model in `slip-api-TASK-VS-073-review`.

Searched exact importer/seed names, related scripts, manual mapper/validators,
and existing `ON CONFLICT DO NOTHING` SQL in slip-api and the task directory.
No importer was found in those searches. Reuse: original seed exports, Admin
`toArticleBody`, PostgreSQL transaction/unique constraints, the existing manual
writer advisory lock, and existing activity-log schema/metadata shape. The
new command belongs outside boot migrations and product runtime code.

The seed blob is pinned to `5e0c82a3ca60f694f9a010eb32f9d1fb018d9ce2`.
Statuses remain 8 published topics and 42 published / 19 draft articles.
28 published articles in the old mock have only a summary and no sections;
the adapter copies that exact summary into one text block under `รายละเอียด`
to satisfy the existing API validation without changing their status. Existing
sections and dates are preserved. Empty optional block strings are omitted to
match Go's JSON encoding.

Behavior: one transaction, the same advisory lock as manual API writers,
insert missing slugs only, preserve existing IDs/timestamps/order and unrelated
content, append missing rows in seed order. An existing seed slug with different
content or status aborts the whole transaction; it is never overwritten. New
rows receive metadata-only `system` history entries in that same transaction.
A repeat changes neither rows nor history. A connection loss around commit
can leave the outcome uncertain; rerun the same command safely.

From `/Users/earth/Documents/GitHub`, show the plan without a DB connection:

```sh
node --experimental-strip-types ai-dev-office/runs/TASK-VS-073/import-manual-seed.mjs
```

Operator-only apply command (prepared, **not executed** here): provide
`STAGING_POSTGRES_HOST`, `STAGING_POSTGRES_USER`, and
`STAGING_POSTGRES_PASSWORD` through the existing credential channel outside
the issue. No `.env` file is read or modified. Only variable names are shown:

```sh
PGHOST="$STAGING_POSTGRES_HOST" PGPORT=5432 \
PGDATABASE=upslip PGUSER="$STAGING_POSTGRES_USER" \
PGPASSWORD="$STAGING_POSTGRES_PASSWORD" PGSSLMODE=require \
node --experimental-strip-types ai-dev-office/runs/TASK-VS-073/import-manual-seed.mjs --apply --target staging
```

Alternatively export `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
`PGSSLMODE` in the authorized operator shell and run just the Node command.
Staging accepts only the `upslip-postgres-dev` RDS host in ap-southeast-1,
database `upslip`, port 5432, with TLS and a nonempty env password. It ignores
ambient `PGSERVICE`, `PGHOSTADDR`, and `PGOPTIONS`. Production targets/hostnames
are rejected. The separate test target accepts only loopback and a disposable
`vs073_seed_test_*` database. Passwords are never placed in argv/output/files;
raw libpq errors are suppressed and only exit/SQLSTATE are reported.

On an initially empty manual DB, expect inserted topics/articles 8/61 with
seed published/draft counts 42/19; a second run reports inserted 0/0.
After the operator's successful apply, verify the real public response:

```sh
curl --fail-with-body --silent --show-error --dump-header - https://api-staging.up-slip.com/v1/web/manual/topics
```

Expected seed topic order/counts: getting-started 4, branches 7, line 5, api 6,
slips 3, packages 7, credits 6, tax-documents 4 (42 published articles total).
Other existing published content can increase public counts. The command's
`public_topics` report is a DB query, not evidence of this HTTP request.

Verification:

- ev-030: 7 tests passed, 0 failures/skips on disposable PostgreSQL 18.7.
  First import inserted 8/61, second inserted 0/0; IDs/timestamps/history are
  byte-for-byte stable. Partial-prefix resume and unrelated content/order,
  concurrent CLI executions, conflicting existing content, and rollback when
  audit insertion fails are covered. All transformed rows pass the reviewed
  Go manual validators with no further normalization required. Dry run,
  target restrictions, missing passwords, ignored connection overrides,
  and credential redaction on errors are covered. No staging connection ran.
- ev-031: SHA-256 importer
  `1175d955e08bce8b9c407c702781c98b117dfaa109aff3a80253ec788eefbbc5`;
  test `731fde1646dc6ddaa0d0d9b629f5b70190dcacb459371c57cd4099c55ee06f36`.
- ev-032: CLI plan reports 8/42/19, 28 summary adapters, and
  `databaseContacted: false`.
- Test DB was dropped and the local PostgreSQL container stopped afterward.
  No product code, migration, IAM, deployment or real credential file changed.
  Nothing was imported into staging or production in this preparation session.
  `staging_acceptance` remains pending; this does not prove authenticated
  staging CRUD/history, public HTTP content after import, or S3 behavior.

## Scope restored to Portal only; existing production state — 2026-11-18

Earth decision: `01a1eca4-f49d-7b21-b834-2b7c41aa2a73`. Jason recording
request: `01a1eca6-4a5b-7acf-aadb-c2ea39f6e365`. The temporary landing/API
scope in comment `01a1ea65` is canceled. API manuals are served in Portal only;
the marketing landing `/manual` keeps its static UI.

GitHub read-only checks recorded in ev-033:

- https://github.com/SparqLab/slip-landing/pull/23 merged into main at
  `19ef72cfeb4c6809e2afb99dd8d40cd15a67dd40` on November 18 at 03:07:15 UTC.
  PR #23 reverts manual implementation PR #19 and renderer follow-up PR #21.
- https://github.com/SparqLab/slip-landing/pull/24 promoted main -> staging at
  `dc1674d89aa504fa1eab31f2ad1195919e8a2e3d` at 03:07:45 UTC.
- main `19ef72c`, staging `dc1674d`, pre-feature `0f0910c`, and prod `e6dc302`
  share tree `03658f915e8419d089fe77e51b2dd292c3124da6`. The actual prod
  commit is `e6dc302f13088f2d0eae2a4099471361ada0a91c`, not the revert merge.
- https://github.com/SparqLab/slip-landing/actions/runs/44228202726 completed
  successfully on the exact staging revert SHA. No workflow was started here.
- `slip-api` prod ref points to `d5a99e2d41589d761cc17adf02b455554218a668`.
  GitHub identifies author/committer `watcharapol-spl`, committed at
  `2026-11-17T09:44:41Z`, message `Merge branch 'staging' into prod`.
  Parents: prior prod `ba4424004b1916cadb0a0de04d48ce8c9695868d` and staging
  `0b548a6e353a774c3f644047f74ef05da0140827`. Associated-PR API returns `[]`.

Operator reports, explicitly not independently reverified against AWS, DB or
live HTTP in this record-only session:

- Earth reports migration 084 applied in **74 ms** on production. Source:
  comment `01a1eca4-f49d-7b21-b834-2b7c41aa2a73`. GitHub commit/ref evidence
  does not independently establish migration execution or its duration.
- Earth reports landing staging task :51/image `staging-sha-dc1674d`, identical
  visible static manual text to prod, and removed nested manual routes 404.
- Earth reports seed import on staging through the Admin API around 16:30 UTC
  on November 17 (comment `01a1ea65-fce1-7e7d-acdd-da0be2b06931`): 201 x8
  topics and x61 articles, read back matching seed, 42 published / 19 draft,
  public counts 4,7,5,6,3,7,6,4. Dates and actor history come from that API
  import. The prepared DB script was not used and must not be rerun now.
- Authenticated staging acceptance was already recorded as `pass` from Earth
  comment `01a1ea33-e7af-79f1-9734-73e8d96d5cd2`; it is not changed here.

Remaining proposed production sequence: content import via Admin API ->
`slip-admin` -> `slip-front-end`, pending Earth's explicit approval of the
plan before execution. `slip-landing` is excluded. The existing backend prod
state above is an observation, not approval to perform another deployment.

This session updates task records only. No product files, branches, deployments,
production resources or content changed. Preserve every completion gate and
the task phase/state. The task remains open; no `knowledge_closeout` gate is
resolved or rewritten by this recording work.

## Production delivery and acceptance closeout — 2026-11-18

Authority/source: Earth approval and release report
`01a1eccb-9d54-7330-a840-9514f91651e0`; Jason closure decision
`01a1eccd-3c68-7ced-98c5-9ee5dd662b9f`. These supersede the previous pending
production-plan record. No new production operation is authorized in this session.

Independent GitHub and public HTTP verification, ev-035:

| Repository | Production PR / merge | Pinned head | Matching prod/staging/pin tree | Successful deploy |
| --- | --- | --- | --- | --- |
| slip-admin | [#47](https://github.com/SparqLab/slip-admin/pull/47), `2e787115327c47adc52fc758b58acf96893744a9` | `fd5d0b3c6b1076dad1def00def1b06c575d77b11` | `548ec57974346822690f062b0c172e255dadd45e` | [44232436293](https://github.com/SparqLab/slip-admin/actions/runs/44232436293) |
| slip-front-end | [#23](https://github.com/SparqLab/slip-front-end/pull/23), `7022c10eec7722d1cdf6e76275b2830df2ea9b76` | `3ae2d17916efe91965822498a42ea295ab7832fd` | `69548fb1fe2176467871d6f3d125f048cbed5937` | [44233097971](https://github.com/SparqLab/slip-front-end/actions/runs/44233097971) |

Both PRs target prod, are MERGED, and current prod refs match their merge
commits. Landing prod remains `e6dc302`; no landing production promotion.

- Public `https://api.up-slip.com/v1/web/manual/topics`: 200, no-store, 8
  topics in order getting-started/branches/line/api/slips/packages/credits/
  tax-documents, article_count 4,7,5,6,3,7,6,4 (42 published total).
- Draft article API `/v1/web/manual/articles/sign-up-and-login`: 404 not_found.
- `https://app.up-slip.com/manual`: 200, final URL remains /manual, no login
  redirect or Coming soon page.
- `/manual/api/api-response-codes`: 200, exactly one HTML table, visible
  "บทที่ 3 จาก 6", no visible raw Markdown table separator. Only rendered
  text was checked for the separator; embedded hydration data is excluded.
- ev-034 was the first failed verification command due to the smoke helper's
  newline-marker parsing error, not a service failure. Corrected parser and
  reran as ev-035; the failed evidence record is retained.

Earth-reported operational facts (not independently checked against ECS, S3,
secrets or authenticated Admin in this session):

| Service | Active revision | Image | Rollback revision |
| --- | --- | --- | --- |
| Admin | slip-admin-production:92 | production-sha-2e78711 | slip-admin-production:91 |
| Portal | slip-front-end-production:95 | production-sha-7022c10 | slip-front-end-production:94 |

Earth reports both rollouts COMPLETED 1/1, unchanged env/secret hashes versus
the preceding revisions, and successful authenticated Admin topic/article
reads. The release content was imported by Earth through Admin API at 03:42
UTC, not by the DB script: topics 201 x8 and articles 201 x61, no errors;
payload SHA-256 prefix `952f540e` matched the reviewed seed; authenticated
readback matched all articles, ordering, 42 published and 19 draft. Public
visibility of the 42 published articles is independently checked above;
authenticated draft totals/import execution remain attributed to Earth.
The already deployed slip-api prod d5a99e2/migration report remains as in the
previous section. No rollback was requested or executed.

CI limitation, ev-036: [Portal CI 44233098854](https://github.com/SparqLab/slip-front-end/actions/runs/44233098854)
failed at Lint with 11 errors / 6 warnings in
app/features/branches/ui/BranchChangePackageModal.vue and
app/features/packages/api.ts. Failed log inspected with `gh run view --log-failed`.
GitHub blob checks show both files unchanged between pre-manual main 3f3517b
and production 7022c10. Deploy PRODUCTION succeeded separately. No claim that
all CI is green or that this baseline lint was fixed.

Follow-ups: SPAR-72 (`01a1eccc-f541-702c-bde6-0f5d91c416ae`) was read back as
backlog, low priority, unassigned. It contains Admin, Portal, editorial and
first-production-image checks listed in Earth's report. They are not added as
gates or dependencies here. Production image upload/save remains unverified
(seed has no images); no cleanup of staging image/history was performed.

The existing completion guard reported allowed=true with no unresolved gates.
`force-status-route.rb` returned `Status forced: in_review -> done (next: done)`.
Readback confirms phase/state/current_agent done and all five existing gates
unchanged; history gained only the guarded closure event. No follow-up gates
or dependencies were added. `ruby ai-dev-office/validate-yaml.rb TASK-VS-073`
returned `Validation passed: TASK-VS-073` after closure. This session performs no deployment,
content mutation, IAM change, or follow-up implementation.
