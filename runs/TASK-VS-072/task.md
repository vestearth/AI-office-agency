# TASK-VS-072: KYC documents stored under the public CDN prefix (slip-api)

Opened 2026-11-12 by the Claude conductor, from the knowledge-base Review Queue
item "VerifySlip KYC documents are stored under the public CDN prefix" (VerifySlip
knowledge reconciliation, 2026-11-12).

**Publication hold:** this repository is public. Do not commit this run folder
until the containment step (8) is verified on production. Exploit-level detail,
infrastructure identifiers and the read-only commands for Earth stay in
`security-findings.local.md` (gitignored by `runs/*/*`) and in the private knowledge
base; this file cites them as S1–S3. No user IDs, object keys or secrets belong here.

**No real KYC object was opened, listed or HEAD-requested during this
investigation.** Probes used keys that cannot exist (all-zero user UUID, random file
name) and public, non-KYC objects only.

## Scope

- Confirm, from the infrastructure side, whether KYC uploads (Thai ID card front,
  selfie, company affidavit, VAT certificate) are readable without authentication.
- Find where KYC document URLs are returned, shown or logged.
- Propose a fix: a private prefix outside `public/`, authenticated reads for admin
  review, migration of existing objects and stored URLs. Earth decides before any
  prod change.

Out of scope: the shared `S3_*` key pair and static keys in the task definition
(follow-up).

## Findings (2026-11-12)

Code refs are slip-api `origin/prod` `47e4245`; `origin/main` `0d64143` has the same
content in every file named here.

### F1. Uploads go under the CDN origin path — confirmed in code

- `internal/models/kyc.go:292` `KYCObjectPrefix` returns `public/kyc/<entity>/<kind>`;
  `internal/core/service/kyc.go:70` appends `/<userID>/<uuid><ext>`.
- `internal/core/service/kyc.go:74` stores `storage.PublicURL(publicBase, key)`
  (`internal/storage/s3.go:74` strips `public/`), with `publicBase` = the blog cover
  CDN base (`cmd/main.go:198`).
- History: `de5c571` (2026-11-06) wrote KYC to `kyc/…`, outside `public/`; `6af34a1`
  (2026-11-06 16:08) moved it under `public/kyc/…`. On `origin/prod` since PR #125
  (merged 2026-11-08).
- slip-front-end `origin/prod` `a43861f` (running in production) has
  `featureFlags.kycUpload: true` since `2779039` (2026-11-06), so production merchants
  upload into this prefix.

### F2. The infrastructure serves `public/*` to anyone — confirmed in IaC

`SparqLab/upslip-infra` `e05f4e5` (`scripts/setup-s3-cloudfront.sh`,
`lib/storage-stack.ts`), which created the live buckets and distributions on
2026-09-21:

- CloudFront origin path `/public`, one default cache behaviour, GET/HEAD, no trusted
  key groups (no signed URLs or cookies).
- Bucket policy: the distribution may `s3:GetObject` on `public/*`. Block Public
  Access blocks ACLs; the policy is the only grant.
- The stack's own comment: `public/` is for "marketing / non-PII assets"; `slips/` is
  API-only. KYC under `public/` contradicts the storage design.

### F3. A live edge rule on `/kyc/*` does not close it — confirmed by probe

- Both distributions (prod and staging) carry an extra edge rule for `/kyc/*` that is
  not in IaC (drift) and is not authentication. slip-admin's document preview
  (`KycDocPreview.vue`, `c219f9a`, 2026-11-09) depends on it.
- Two independent ways past the rule were confirmed on prod and staging (S1, S2).
  Both reach the S3 origin, and S3 resolves the request to the same `public/kyc/…`
  key (proven on public objects only).
- Net: anyone who has a KYC document URL can download it from anywhere, with no
  login, no expiry and no audit trail. The only protection is that the URL is
  unguessable (user UUID plus a random UUIDv4 file name; the CDN cannot list the
  bucket).

### F4. Where the URLs go — confirmed in code

| Place | What |
|---|---|
| PostgreSQL `kyc_users` | `id_card_front_url`, `selfie_url`, `company_affidavit_url`, `vat_certificate_url` hold the CDN URL |
| slip-api owner API | `GET /v1/me/kyc`, `PUT /v1/me/kyc`, `POST /v1/me/kyc/documents`, `POST /v1/me/kyc/submit` (`internal/handler/router/router.go:349-352`) |
| slip-api admin API | `ListKYC`, `GetKYC`, `ApproveKYC`, `RejectKYC` (`router.go:784-787`, handlers `internal/handler/http/admin.go:216-262`) |
| slip-admin | `UsersManage.vue` → `KycDocPreview.vue`: `<img :src>` thumbnail and open-in-new-tab link; `GetKYC` is re-fetched each time the detail opens |
| slip-front-end | never shows the document: checks "attached", shows the file name, sends the URL back on `PUT /v1/me/kyc` |
| Not found | KYC emails (`kyc_email.go`), chat notifications (`kyc_notify.go`), invoice mail, the approve/reject activity log, slip-api logs (errors only, no request-body logging), analytics SDKs in slip-admin or slip-front-end |

### F5. Related defect: client-controlled document URLs — confirmed in code (S3)

`PUT /v1/me/kyc` saves the four `*_url` fields from the request body
(`internal/models/kyc.go:367-370`) on both paths of `Upsert`: Create when no row
exists for that entity type (`internal/core/service/kyc.go:146-151`) and Update
(`:168`). The server never checks that the value is a key it issued to that user,
and slip-admin renders it as an image and a link. `ValidateKYCSubmit`
(`models/kyc.go:401-424`) only checks non-empty, so stub values written while the
upload flag was off also pass submit.

### F6. Lost-update race on the KYC row (found in review)

`UploadDocument`, `Upsert` and `Submit` read the whole row and write every column
back with no status guard (`internal/repositories/kyc.go:212-237`). An upload racing
a PUT can drop a document, and a late upload can turn a submitted or approved KYC
back into a draft.

### F7. Reported containment (2026-11-12 evening) — not provable from outside

Later on 2026-11-12 Earth relayed DevOps' report that the documents can no longer
be fetched (the objects are still under `public/`). Re-probes with keys that cannot
exist: at 23:37 and 23:39 ICT (this run, HEAD and GET, several request variants)
both ways past the edge rule reached the S3 origin on prod and staging. An earlier
23:16 reading that S1 was refused at the edge was a probe artifact (malformed
header: the shell sent it with a leading space, so the edge saw none); repeated
correctly at 23:43 it reached S3, and this run reproduced the artifact at 23:4x. No
probe has shown either bypass closed. The form a browser sends passes the edge, so a
broken admin preview (if it is broken) would come from a bucket-policy change, not
from the edge rule. S3 answers the same bare `AccessDenied` for a missing key in any
prefix, so a probe cannot show whether a bucket-policy Deny on `public/kyc/*` now
refuses real objects. Nothing is recorded in `upslip-infra` (no commit after
2026-11-11). Treat the exposure as open until DevOps shows the bucket policy or the
dummy-object test in step 8 passes. If the Deny is in place, the slip-admin preview
is broken until release 1 ships.

### Not verified

The `vestearth` profile is denied every read of the live config: bucket policy,
policy status, ACL, Block Public Access, ownership controls, `ListBucket`; CloudFront
distribution config and functions; the IAM policy of the upload user. Indirect
evidence that the live bucket policy still allows `public/kyc/*`: the admin preview
is built to load documents through the CDN. The read-only commands that close this
gap are in the local file.

The number of affected users is not counted (needs a production database read; it
is part of release 2's dry run).

## Fix plan (reviewed 2026-11-12, pending Earth's decision)

Review: independent read-only reviewer pass on this plan against the code (verdict
fix-then-ship, 11 findings, all accepted and folded in below; the conductor
re-checked the migration runner, test counts, Create path and KYC gates against
`origin/prod`).

### Release 1 — slip-api only, no schema change, no client change

1. **Private prefix.** New uploads go to
   `private/kyc/<entity>/<kind>/<userID>/<uuid><ext>`: outside `public/`, so the CDN
   origin path never reaches it, and outside `slips/`, whose 90-day expiration rule
   would delete KYC documents.
2. **Store the key, not a URL.** The existing `*_url` columns hold the object key.
   No DDL.
3. **Server-owned document references.** Remove the four document fields from
   `KYCWriteRequest` / `NormalizeKYCWrite`. `Upsert` never writes document columns, on
   Create or Update; documents change only through `POST /v1/me/kyc/documents`.
   `ValidateKYCSubmit` requires a key the server issued for that row (closes F5).
   Consequence: with `kycUpload` turned off in slip-front-end, KYC submit is
   impossible after release 1 (it is on in production).
4. **Column-scoped writes.** Upload sets one document column with a single
   `UPDATE … WHERE status IN ('draft','rejected','expired')`; Upsert's UPDATE leaves
   document columns alone (closes F6).
5. **Reads, presigned only for admins.** The presign step lives in the handler
   response builders only, never on the `KYCUser` struct inside a service (so `Submit`
   / `Upload` cannot write a presigned URL back to the database).
   - Admin `GetKYC`, `ApproveKYC`, `RejectKYC`: presigned S3 GET URLs
     (`s3.PresignClient`, TTL 10 minutes) in the same fields, so slip-admin needs no
     change (`KycDocPreview` already handles query strings; no CSP `img-src`). Log an
     activity entry when an admin opens `GetKYC` (audit trail).
   - Admin `ListKYC`: no document URLs.
   - Owner endpoints and the upload response: the file name (basename) only, never a
     working link. slip-front-end's `fileNameFromUrl` and "attached" checks keep
     working; it sends the basename back on PUT, which is ignored.
   - Ownership check before presigning: accept only
     `(private|public)/kyc/<entity>/<kind for this column>/<row user_id>/<uuid>.(jpg|png|pdf)`;
     a legacy value must be `https://<publicBase>/kyc/…` with the same constraint
     (host equal to `publicBase`). Anything else maps to `""`.
   - Why not a streaming proxy: slip-admin authenticates with a Bearer header, which
     `<img src>` / `<a href>` cannot send, so a proxy forces a slip-admin change for no
     extra protection beyond the audit log above.
6. **IAM first.** Before release 1 deploys, the upload user needs `s3:PutObject` and
   `s3:GetObject` on `private/kyc/*` and `s3:GetObject` on `public/kyc/*` (presigned
   URLs carry the signer's permissions). Without it uploads fail with 403.
7. **Tests seen failing first** (test-integrity rule), written against a fake Store
   and a fake repository so they fail on an assertion, not a compile error, on
   `47e4245`:
   - The key passed to `Store.Put` is not under `public/` and is under
     `private/kyc/<entity>/<kind>/<userID>/`.
   - `UploadDocument` and `Submit` hand the repository a key, not a URL.
   - `Upsert` with a document URL in the body stores nothing for it, on Create and
     on Update.
   - Owner GET / PUT / Submit / Upload responses carry no `https://` document URL.
   - After the presigner exists: admin Get/Approve/Reject carry presigned URLs;
     another user's key, a foreign host and stub values map to `""`.

   Promotion main → staging → prod, each through a PR (VerifySlip branch flow,
   `verifyslip-promote`).

### Containment — bucket policy, right after release 1 is live on prod

8. Add an explicit `Deny s3:GetObject` on `public/kyc/*` for the CloudFront service
   principal, on both buckets. This closes the CDN path for every legacy object,
   S1/S2 included, without moving anything; presigned reads (IAM user) are not
   affected. Retire the extra edge rule and record the change in `upslip-infra`
   (script and CDK). Needs an identity with `s3:PutBucketPolicy` (not `vestearth`).
   - Staging proof: put a dummy (non-ID) object under staging `public/kyc/` and run
     S1/S2 against it before and after the Deny; confirm a presigned URL for it still
     answers 200 after the Deny. (Probing `private/kyc/` via the CDN proves nothing:
     the CDN maps it to `public/private/…`.)
   - Variant "Deny now", before release 1: closes the exposure today, but new uploads
     still land in `public/kyc/` until release 1, so the admin preview of **every**
     document stops. Reviews stop, and unapproved merchants cannot create shops or
     branches (`merchant.go:105`, `branch.go:1164`) until release 1 is live.

### Release 2 — clean-up

9. Copy legacy objects `public/kyc/*` → `private/kyc/*` (same suffix), server side,
   in each environment **before** that environment boots release 2 (merging to
   staging runs the migration on staging). Report counts only.
10. Goose migration, data only. slip-api's goose provider records versions and runs
    each file once per database (`migrations/run.go:38-46`); it does not replay on
    boot. Still idempotent: rewrite only values matching the ownership pattern above
    (pattern built with `… || user_id::text || …`, legacy host equal to the env's
    `publicBase`), and report how many non-empty values did not match. Needs a
    `-- +goose Down` no-op and the hard-coded file count in
    `migrations/run_test.go` bumped (83 today); pick the version number at merge time
    because teammates push main directly. Test with the
    `TestManualMigrationPreservesExistingRowsAndReplays` pattern: only matching rows
    change, a second run changes nothing.
11. Before deleting, `HeadObject` every rewritten key. Then delete `public/kyc/*` and
    every noncurrent version (bucket versioning is on) — permanent deletion, needs
    Earth's explicit yes at that time. Then remove the IAM `GetObject` on
    `public/kyc/*`.

### Follow-ups (not this run)

- Narrow the upload user's policy per prefix; consider the ECS task role instead of
  static `S3_*` keys in the task definition.

## Asks for Earth

1. Decision on the fix plan: read path, containment timing, legacy objects.
2. The read-only infrastructure checks listed in the local file (an identity other
   than `vestearth`).

## Decision log

- 2026-11-12: run opened; investigation done; plan reviewed.
- 2026-11-12: Earth was asked three questions (read path, containment timing, legacy
  objects) and answered "no preference" on all three. The recommended options stand
  as the default plan: presigned admin reads (owners get file names only), the
  bucket-policy Deny right after release 1 is live on prod, and release 2
  copy + rewrite + delete. This is not approval to change production: release 1's
  promotion to prod, the IAM change, the bucket-policy Deny and the step 11 deletion
  each still need Earth's explicit yes when they come up.
- 2026-11-12 ~23:50 ICT: Earth chose to ask DevOps for both checks: the live bucket
  policy and edge-rule config (read-only), and the staging dummy-object test in
  step 8. The conductor drafted the message (local file) for Earth to forward;
  `waits_on: external` recorded. Containment status stays "open" until one of the
  two comes back.
