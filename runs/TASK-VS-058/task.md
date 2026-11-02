# TASK-VS-058: UpSlip blog: articles served by slip-api, edited in slip-admin, with cover upload

Move up-slip.com/blog articles out of `slip-landing/app/data/articles.ts` into slip-api.
slip-landing reads published articles over the API at SSR; slip-admin edits them,
including a per-article cover upload with the existing SVG preset as fallback.

- Type: feature across `slip-api`, `slip-admin`, `slip-landing` + one IAM role.
  Schema change: new table(s) with migration `069_*` (latest on slip-api origin/main
  55260b8 is `068_line_bind_token_target.sql`).
- Created: 2026-11-02 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Source: Multica **SPAR-55** (brainstorm only, no code). Trevor's proposal
  2026-11-02 03:15Z, Tommy's backend review 03:19Z. Multica comments are not in git,
  so the decisions are copied below; this file wins where they differ.
- Gates: `production` preset (implementation_verification → deploy_staging →
  staging_acceptance → deploy_production → production_acceptance) + `storage_role`
  + `knowledge_closeout`. UpSlip prod is live, not cost-gated. Promote main → staging
  → prod through PRs (`verifyslip-promote` skill).

## Operator decisions (Earth, 2026-11-02)

1. **Scope: articles only.** The `/blog` heading, weekly blurb, end CTA, share
   buttons, the «อ่านต่อ» heading and `/manual` stay in slip-landing code.
2. **Content baseline:** everything https://up-slip.com/blog/fake-slip-signs shows
   today must come from the editor (field table below). Anything extra is a
   suggestion, not a requirement.
3. **Cover image:** per-article upload is in phase 1. The existing SVG preset shows
   when there is no image or after the image is removed.
4. **API unreachable:** `/blog` and `/blog/[slug]` answer **503** with a temporary
   notice page. No fallback to `articles.ts`, a build copy or a stale cache, so an
   article moved to draft can never reappear.
5. **Seed:** `fake-slip-signs` is published and featured. The other **6 sample
   articles are seeded as draft**, so their URLs answer 404 until someone fills in
   sections and publishes them.
6. **Upload permission:** a **new ECS task role for slip-api only** (staging and
   production), allowed only `s3:PutObject` on
   `arn:aws:s3:::<environment bucket>/public/blog/*`. Do not add it to the shared
   `ecsTaskRole`, and do not reuse the `upslip-assets` IAM user keys.
   **Amended 2026-11-02:** the role also carries the four `ssmmessages` actions
   ECS Exec needs. ECS Exec is enabled on `slip-api-staging` and
   `slip-api-production`, and today it works through `AmazonSSMManagedInstanceCore`
   on `ecsTaskRole`. Do not attach that whole managed policy.
7. **F2 CORS (frontend review, decided 2026-11-02): option A.** Append the landing
   origins to slip-api `CORS_ALLOWED_ORIGINS`; no landing proxy. Earth accepts that
   the allowlist is global (landing scripts may read any slip-api route's response).
   Admin, API key and user auth read only the `Authorization` header, and slip-api
   sets or reads no cookie. Full values, keeping every current entry (checked against
   the live task definitions):
   - staging (`slip-api-staging:169` + 1 origin):
     `http://localhost:3000,http://localhost:5173,http://localhost:3010,https://app-staging.up-slip.com,https://admin-staging.up-slip.com,https://staging.up-slip.com`
   - production (`slip-api-production:127` + 2 origins):
     `http://localhost:3000,http://localhost:5173,http://localhost:3010,https://app.up-slip.com,https://admin.up-slip.com,https://up-slip.com,https://www.up-slip.com`

   Set it in the GitHub environment secret `CORS_ALLOWED_ORIGINS` of each slip-api
   environment. The deploy workflows rebuild the task definition env from that secret
   on every run, so editing only a task definition is undone by the next deploy. Do
   not rely on the fallbacks: `deploy.yml` (staging) has none, and
   `deploy-production.yml` falls back to the two landing origins only, which would
   drop app and admin. Ship it with the slip-api deploy of this run (after
   `storage_role`), staging first; never as a separate CORS-only deploy.
   Done 2026-11-02 05:40Z: Tommy set both environment secrets. Since then, any
   slip-api deploy from any branch push carries the new origins, so a teammate's
   promote can ship CORS before this run's deploy. That is accepted.
8. **Who creates the role (2026-11-02): an IAM admin, by hand (CLI or console).**
   `upslip-infra` is not the deployed source for ECS IAM. Its `lib/ecs-stack.ts`
   would create one role per service, but every live service runs on the hand-made
   `ecsTaskRole`. Its README says not to `cdk deploy` until reviewed. The
   `upslip-assets` user was made once by hand. CloudFormation is unreadable for
   vestearth. Policies to apply, with `<env-bucket>` = `upslip-assets-staging` or
   `upslip-assets-prod`. The buckets use SSE-S3 (`setup-s3-cloudfront.sh`), so no
   KMS grant is needed.
   - Trust: `ecs-tasks.amazonaws.com`, condition `aws:SourceAccount` = `122991883560`.
   - Permissions (inline, one per role):
     ```json
     {"Version": "2012-10-17", "Statement": [
       {"Sid": "BlogCoverUpload", "Effect": "Allow", "Action": "s3:PutObject",
        "Resource": "arn:aws:s3:::<env-bucket>/public/blog/*"},
       {"Sid": "EcsExec", "Effect": "Allow",
        "Action": ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
                   "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"],
        "Resource": "*"}]}
     ```
   - Suggested names: `slip-api-staging-task-role`, `slip-api-production-task-role`.

   PR #115 (merged) already updated the deploy workflows. The IAM admin must
   register a new revision of each `slip-api-<env>` family with the dedicated
   `taskRoleArn` before this run deploys. Both workflows start from the family's
   latest revision and preserve that role. Staging `deploy.yml` injects/replaces
   `S3_REGION`, `S3_BUCKET` and `S3_PUBLIC_BASE_URL` from the GitHub **staging**
   environment secrets; setting them only in its task definition will not survive
   the deploy. Production `deploy-production.yml` does not inject those keys, so
   its new task definition revision must include all three environment variables.
   Production GitHub secrets for those keys are not part of this workflow. Record
   who applied the roles and their ARNs in this run.
9. **Minor review findings (2026-11-02):** fix two in this run, before staging,
   because they set how fast decision 4's 503 appears:
   - F3 (landing): with the API hung, the detail page shows 503 only after about
     16.5 s (2 calls × 8 s). Bound the total wait.
   - Backend MINOR 1: the blog repository has no 3 s `queryTimeout` like the other
     repositories (`cmd/main.go:85`), so a hung DB answers 503 only at the 20 s
     WriteTimeout.

   Before staging, set the three GitHub **staging** S3 environment secrets above
   to the operator-provided values below. `S3_PUBLIC_BASE_URL` must be a bare host;
   the slip-api startup guard rejects a malformed base URL or an incomplete
   bucket/region/base-URL set. Verify the secret update metadata before deploy.
   During staging acceptance, compare the deployed task definition's three S3
   values against the locally recorded SHA-256 hashes without printing values,
   confirm ECS tasks stay healthy, and inspect startup logs for fatal `blog CDN
   URL`, `S3_BUCKET and S3_PUBLIC_BASE_URL must be set together`, `S3_REGION is
   required when S3_BUCKET is set`, or `blog storage` messages.
   This P2 pass does not register a task definition or deploy; the IAM admin must
   register the dedicated-role revisions from decision 8 before staging deploy.

   Follow-ups, not in this run: F4 (no warning that draft takes the article offline),
   400 instead of 413 over 5 MiB, validation errors that do not name the field and
   byte-based limits missing from the README, `typescript`/`vue-tsc` missing from
   slip-landing devDependencies (CI cannot typecheck), and a new section reusing a
   deleted section's id (old deep links move).

Defaults from the proposal, not contested: Thai only; the existing admin accounts
write and publish; publishing is immediate (no schedule); slug is editable while
draft and locked once published; one featured article at a time; the module lives in
slip-api next to packages.

## Facts checked by the conductor (2026-11-02, read-only)

- slip-landing origin/main ebdf16d: `app/data/articles.ts` holds 7 slugs
  (`fake-slip-signs`, `close-chat-orders-faster`, `duplicate-slips`, `api-quickstart`,
  `bank-slip-redesign`, `multi-branch-accounts`, `auto-cutoff-flow`) and
  `featuredSlug = 'fake-slip-signs'`; `app/pages/blog/[slug].vue` calls `findArticle`
  and throws a fatal 404 on a miss.
- slip-api origin/main 55260b8: no AWS SDK in `go.mod`, no S3 settings in
  `configs/config.go`. Production deploy is `.github/workflows/deploy-production.yml`
  → ECS `upslip-production-ecs` / `slip-api-production`; the repo also carries
  `ecs/task-definition.json` and `k3s/`.
- Production runtime (`aws`, profile vestearth): `slip-api-production` runs td :127
  with 3 tasks, `taskRoleArn` = `ecsTaskRole`, and no S3/AWS env or secrets.
  `slip-system`, `slip-admin` and `slip-landing` production use the **same**
  `ecsTaskRole`. Its only attached managed policy is AmazonSSMManagedInstanceCore;
  inline policies are unreadable (vestearth lacks `iam:ListRolePolicies`), so
  creating the role probably needs an admin account, as in TASK-VS-057.
- Staging (checked 2026-11-02): `slip-api-staging` runs td :169 on the same
  `ecsTaskRole`. ECS Exec is enabled on both slip-api services, and neither cluster
  sets an `executeCommandConfiguration` (logging DEFAULT).

From Tommy's review, not re-verified here (`upslip-infra` and `casperacc-api` are not
cloned on the conductor machine):
- Buckets `upslip-assets-prod` / `upslip-assets-staging`; prefix `public/` is served
  by CloudFront (prod `https://d1emyocrm9dw73.cloudfront.net`, origin path `/public`,
  so public URLs drop `public/`), per `upslip-infra/lib/storage-stack.ts:92-119`.
  `slips/` is not on the CDN and has a 90-day lifecycle; never write there.
- The casperacc popup upload (`casperacc-api/internal/handler/http/upload.go:48-59`)
  trusts the extension and the multipart `Content-Type`, and
  `ParseMultipartForm(5 MiB)` is not a request cap. Reuse the idea, not the code.

Operator-provided S3 env set (2026-11-02; values are held outside git, names only here):
- Buckets confirmed: `upslip-assets-staging` and `upslip-assets-prod`, region
  `ap-southeast-1`. CDN hosts: staging `d8nuh3zcuo9fd.cloudfront.net`, production
  `d1emyocrm9dw73.cloudfront.net` (matches Tommy).
- `S3_PUBLIC_BASE_URL` is a bare host with no scheme. slip-api must build
  `https://<host>/blog/{uuid}.{ext}` itself, or the slip-api config must carry the
  scheme; pick one and test it.
- The existing set also has `S3_ACCESS_KEY` / `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE=true`
  and an empty `S3_ENDPOINT`. **The same access key pair is used for staging and
  production**, so that IAM user can write both buckets. slip-api takes none of these
  three: it uses the task role (decision 6) and the default AWS endpoint.

## Field model (from fake-slip-signs)

| Page shows | Field |
| --- | --- |
| URL `/blog/fake-slip-signs` | `slug` |
| last breadcrumb «วิธีดูสลิปปลอม» | `crumb` (may differ from the category) |
| two-line title | `title` as a list of lines |
| `ทีม Up-Slip` + avatar letter | `author` (avatar = first letter) |
| อ่าน 6 นาที | `read_minutes` |
| อัปเดตล่าสุด 1 ต.ค. 2569 | `content_updated_at`, formatted as a Thai date by landing |
| table of contents, paragraphs, checklist | `sections[] {heading, body, checks[]}` (checks may be empty) |
| 3 related cards | `related` (slugs) |
| category label | `category`, one of the 4 existing ones |
| list card blurb / featured blurb + share text | `summary` / `excerpt` (falls back to `summary`) |
| card and banner image | `cover_url`, falling back to `thumb_preset` (always set; detail banner falls back to today's placeholder box) |
| live or not / featured | `status` draft or published, `featured` (one at a time) |

Dates (Tommy): `content_updated_at` is what the site shows and moves only when a new
published content revision is saved. `updated_at` is the row audit time and
`published_at` the first publish. A draft save, status change or image change must not
move the shown date. Today the source holds a display string (`updated`), so landing
must format real timestamps.

Author: the list card hard-codes «ทีม Up-Slip» while the detail page reads `author`.
Both must read `author`. Seed `ทีม Up-Slip` for `fake-slip-signs`; the source holds
the placeholder `[ชื่อผู้เขียน] · ทีม Up-Slip`, which must not be published.

## Work per repo, in deploy order

1. **IAM (storage_role gate).** Create the slip-api task role for staging and
   production with `s3:PutObject` on `public/blog/*` of that environment's bucket
   only (no List/Get/Delete, nothing on `slips/*`), plus the ECS Exec
   `ssmmessages` actions (decisions 6 and 8). Point the slip-api task
   definitions at it. The other UpSlip services keep `ecsTaskRole`. Needs an admin
   account; record who applied it.
2. **slip-api.**
   - Migration `069_*` for the article table(s); new empty tables, so the goose
     boot window is not a concern. Seed the 7 articles (decision 5).
   - Public read, published only, no login: `GET /v1/web/blog/posts` and
     `GET /v1/web/blog/posts/{slug}`; follow `/v1/web/packages`
     (`internal/handler/web/package.go`, `internal/handler/router/router.go`).
   - Admin CRUD under `/v1/admin/blog/posts` with the existing admin auth.
   - Cover upload under the admin group: cap the request body (`MaxBytesReader`),
     5 MiB per file, jpg/jpeg/png/gif/webp only, detect the type from the bytes and
     decode the image (webp decoding needs `golang.org/x/image/webp`), generate the
     key `public/blog/{uuid}.{ext}` on the server from the detected type, and build
     the URL from server config. Never accept a URL or key from the client.
   - Config: AWS SDK v2 with `S3_REGION`, `S3_BUCKET`, `S3_PUBLIC_BASE_URL`;
     credentials come from the task role (no access keys).
   - Old S3 objects are kept on replace or remove (bucket versioning is on).
3. **slip-admin.** A blog view in the admin shell: list; form with title lines,
   category (4 values), reorderable sections with heading, body and checklist lines,
   related picker, preset picker, cover upload and remove, draft/published, featured
   switch. Check the same file rules before upload.
4. **slip-landing.** Fetch from `apiBase` at SSR. API 404 → 404; API unreachable →
   503 notice page (decision 4). Stop reading article data from `articles.ts`; keep
   the SVG presets in `public/landing/blog`. `cover_url` uses `object-cover` in the
   existing frames (list 220px, featured 620×400, detail 220px / 380px).

Ship landing on an environment only after slip-api serves the endpoints there.
Rollback: revert landing first. Reverting it brings back `articles.ts`, which shows the
6 drafts again, so that is an emergency path only. Then revert slip-api, and drop the
069 tables only after landing no longer calls the API.

## Acceptance (staging, then production)

- `fake-slip-signs` renders as before (visual compare against the current page), now
  from the API, with the author shown from `author`.
- The 6 drafts and a random slug answer 404; `/blog` lists only published articles;
  only one article can be featured; the 4 category tabs still match.
- With the API unreachable, `/blog` and `/blog/[slug]` answer 503 with the notice
  page: not an empty page, not `articles.ts` content.
- Admin blog routes reject a non-admin (401/403).
- Upload: a file over 5 MiB, a disallowed type and a renamed non-image are rejected.
  An accepted file lands under `public/blog/` and is served from the CDN. The slip-api
  role cannot write outside `public/blog/*`.
- On the new role, `aws ecs execute-command` into a slip-api task still opens a
  shell. If the session fails on logging (cluster logging is DEFAULT, which uses the
  task's awslogs group), add `logs:` write on `/ecs/slip-api-<env>` only, and record
  it here.
- With the API hung, `/blog/[slug]` and `/blog` answer 503 within the bound set
  for F3 (decision 9).
- Removing the image returns the cards to the preset and the detail banner to the
  placeholder.
- Saving a draft, changing status or changing the image does not move the shown
  «อัปเดตล่าสุด».
- `/v1/web/packages` and the slip verify paths are unchanged.
- CORS (decision 7): GET and OPTIONS on `/v1/web/blog/posts` with each landing
  origin return that exact `Access-Control-Allow-Origin` and `Vary: Origin`; the
  existing app and admin origins still get it; a random origin gets none. In a real
  browser, client navigation (`router.push`/`NuxtLink`) from `/blog` to an article
  renders without a CORS error.

## Traps

- Trevor's SPAR-55 comment says the latest slip-api migration is `038`. It is `068`
  on 55260b8; check again before numbering.
- `ecsTaskRole` is shared by at least the four UpSlip production services. Any policy
  added there reaches all of them.
- Multica agents run in place in `/Users/earth/Documents/GitHub`. Touch only the
  slip-* repos (and infra by operator hand); `Games-Lab-Android/` is read-only.
- slip-api main → staging → prod is sometimes promoted directly by a teammate. Before
  claiming "on prod", check `origin/prod` ancestry and the running ECS image.
