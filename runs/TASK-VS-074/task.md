# TASK-VS-074: slip-api S3 uploads via an ECS task role; drop plaintext static S3 keys from ECS task definitions

- Type: security hardening, `slip-api` deploy workflows + README; IAM change by an
  IAM admin (vestearth cannot read or write IAM, Secrets Manager or the buckets).
- Created: 2026-11-17 by the Claude conductor lane, side session started from the
  SPAR-71 / TASK-VS-073 review, where the issue was noticed. It predates that change.
- Gates: `production` preset + `knowledge_closeout`. UpSlip prod is live, not
  cost-gated. Promote main → staging → prod each through its own PR
  (`verifyslip-promote`). Prod deploy and rotating/revoking the exposed key need
  Earth's explicit yes.
- Never write key values, key hashes or key ids in this run (public repo).

## Findings (read-only, 2026-11-17)

1. Running task definitions `slip-api-staging:201` (image `staging-sha-46f32b0`) and
   `slip-api-production:154` (image `production-sha-ba44240`, 3/3) carry
   `S3_ACCESS_KEY` and `S3_SECRET_KEY` as plain `containerDefinitions[0].environment`
   entries. Their only ECS secret is `POSTGRES_PASSWORD`. Anyone with
   `ecs:DescribeTaskDefinition` can read the secret key.
2. Staging and prod hold the **same** access key (compared by hash, values never
   printed) against different buckets (`upslip-assets-staging`,
   `upslip-assets-prod`). TASK-VS-058 records it as the shared `upslip-assets` IAM
   user's key, IAM scope unverified.
3. Source: `.github/workflows/deploy.yml` and `deploy-production.yml` (identical on
   `origin/main`, `origin/staging` and `origin/prod`) render both keys from the
   GitHub environment secrets. The jq step starts from the family's latest revision
   and keeps every env entry it does not re-inject, so deleting the two inject
   lines alone would carry the keys forward forever. The fix must strip them.
4. Both services run task role `ecsTaskRole`. It is shared by **28 ECS services**:
   9 `sparqlab-development-ecs`, 9 `sparqlab-production-ecs` (Games Labs), 5
   `upslip-staging-ecs`, 5 `upslip-production-ecs`. Its only attached managed policy
   is `AmazonSSMManagedInstanceCore`; inline policies are unreadable for vestearth.
   `agent-slip-task-role` (6 services) is the precedent for a dedicated role.
5. S3 writers in slip-api, all through the same config (the brief named only the
   first two):
   - `public/blog/*` blog covers (`internal/blog/upload.go`)
   - `public/manual/*` manual images + `HeadObject` on save (`cmd/main.go:133`,
     `internal/manual/handler.go:318`)
   - `public/profile/<user>/*` profile images (`internal/core/service/profile.go:51`)
   - `public/kyc/...` KYC documents (`internal/models/kyc.go:299-310`)
6. With both keys empty the uploaders use the AWS default credential chain, i.e. the
   task role (`internal/contentimage/image.go`, `internal/storage/s3.go`).
7. Manual save maps `NotFound`/`NoSuchKey` to 422 and anything else to 503. Without
   `s3:ListBucket`, S3 answers `HeadObject` on a missing key with 403, so a role
   lacking it turns that 422 into 503.
8. History: `7d21801` (2026-11-02) removed the keys from staging for a dedicated
   role (TASK-VS-058 decision 6: "a new ECS task role for slip-api only … Do not add
   it to the shared `ecsTaskRole`"). Decision 10 the same day chose the key pair
   instead so nothing waited on an IAM admin (`23c9cd5`).

## Code change (branch `task/TASK-VS-074-s3-task-role`)

- Both workflows: stop mapping the two GitHub secrets, drop the pair check, and
  strip `S3_ACCESS_KEY`/`S3_SECRET_KEY` from the carried-over env (`$retired`).
- README "Storage operator handoff": task-role model and the permission list.
- Go code unchanged: the key pair stays supported for local runs.
- Regression check `check-s3-env-strip.rb` runs each workflow's real jq program on a
  fixture whose previous revision carries the keys. RED on `3ea510f` (both workflows
  leak when the GitHub secrets are set), GREEN after the change.

## Operator decision (Earth, 2026-11-17): parked

Earth chose **D: "คงตาม decision 10 ไว้ก่อน"** (keep TASK-VS-058 decision 10 for now),
relayed by the SPAR-71 review session. Decision 10 (2026-11-02) chose the static key
pair and accepted that the keys sit as plain task-definition env, readable with
`ecs:DescribeTaskDefinition`; its follow-ups (rotate/split per environment, move to
ECS `secrets`) were left for later. So: no IAM route, no Secrets Manager work, no
prod or key change. Draft SparqLab/slip-api#148 stays open and unmerged; do not close
it unless Earth says so. The admin-staging session request is withdrawn. Resume only
on a new operator decision; the options below and the ordering still apply then.
Correction to this run's first draft: decision 6 had been superseded by decision 10
on 2026-11-02, so option A was not a standing operator decision.

Options laid out before the decision (every route needs an IAM admin):

- **A (recommended, = TASK-VS-058 decision 6/8):** two dedicated roles,
  `slip-api-staging-task-role` / `slip-api-production-task-role`, each scoped to its
  own bucket; `ecsTaskRole` untouched. Needs `iam:PassRole` on them for the GitHub
  deploy user.
- **B (brief's preference):** inline policy on the shared `ecsTaskRole`. 28 services
  (18 Games Labs) gain write on both UpSlip buckets; contradicts decision 6.
- **C:** keep the key pair but deliver it as ECS `secrets` (Secrets Manager); needs
  an execution-role grant, and the key is still shared across environments.

The exposed key must be rotated or revoked whichever route is chosen (Earth's yes).

## Ordering (no half-finished credential change on main)

1. IAM admin applies the chosen IAM change for **both** environments.
2. Merge the code PR to `main` only after step 1. A teammate may promote main to
   prod directly, so prod must already have the permissions.
3. PR `main` → `staging`, deploy, verify (below).
4. STOP: ask Earth for the prod promotion and for key rotation/revocation and
   removal of the unused GitHub secrets `S3_ACCESS_KEY`/`S3_SECRET_KEY`.

## Staging acceptance

- New `slip-api-staging` revision: no `S3_ACCESS_KEY`/`S3_SECRET_KEY` in env or
  secrets, expected task role, image `staging-sha-<merge>`, 1/1, clean boot.
- Blog cover upload and manual image upload through the admin API both 200; each
  key lands under `public/blog/` / `public/manual/` and loads through the staging
  CDN. Saving a manual block with that key passes `HeadObject`. A missing
  `public/manual/` key answers 422, not 503.
- Needs an admin session on staging; no lane has had staging admin credentials so
  far (TASK-VS-058 frontend handoff).
