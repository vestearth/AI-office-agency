# TASK-VS-052: Bound sibling branch quota-history endpoint

Operator chose VS-049 cursor/date-range contract on 2026-10-26.
Scope slip-api only: GET /v1/merchants/{merchantId}/branches/{id}/quota-history,
its query/page models, handler, service, repository port/query, tests and API
docs. Preserve permission/branch ownership checks and row response fields.
Remove total/offset response, channel SQL filter and OFFSET/COUNT; accept cursor,
limit/default50/max200 and optional from/to bounds with VS-049 parsing.
Unknown legacy query keys are ignored as on VS-049; document this compatibility
change. No schema change needed: migration021 provides matching branch/time/id
and merchant/time/id indexes. Do not touch VS-049 mixed grant/deduction behavior.
Branch from latest main; implementation PR targets main. No prod promotion
before compatible contract review and staging validation.


## Review Queue follow-through status — 2026-10-26

PR102 merged main ea74b63b93329eb4ef1df964153710b0c90ec3a4; PR103 staging merged a4e246ff3564000bf74425db0dded7220eec52c2. Staging task158 is running healthy with staging-sha-a4e246f; previous task157 is draining. /health returns200. The correct /v1 quota-history route returns401 without auth; the initial wrong /api/v1 probe returned404 and is not authentication proof. Authenticated response/ownership/cursor acceptance remains pending; no credential was extracted or fabricated. Previous task157 is the rollback reference. No prod promotion performed.

Final rollout: ev-012 records workflow40293499491 success and task158 rollout COMPLETED1/1, pending0 failed0, health200. The older draining observation above is superseded. Authenticated acceptance remains pending.


## Direct authenticated acceptance client — 2026-10-26

Frontend app/features/branches/services/branch.ts quotaHistory still returns[],
so clicking its UI does not test this sibling route. Prepared an ephemeral
loopback client http://127.0.0.1:19452 at /tmp/vs052-api-check/server.py.
Fixed HTTPS staging API target only; normal issuer login; credentials/session
kept in memory only; no token extraction or repository secret. GET checks only
for merchants/branches/quota-history, cursor/date/error/scope responses; no
verification, bank call, purchase, wallet or account mutation. Page200,
unauthenticated checks401 and foreign-Origin403 were locally verified. Await
user login and actual authenticated results before passing acceptance.


## QA-client login transport correction — 2026-10-26

User reported identical credentials failing in the local client. Native UI
showedHTTP403; an empty-body POST from its urllib transport also returned403,
plain text `error code: 1010`, before API validation. The same empty-body
request with normal curl reached API400/email-and-password-required. No real
credential was used in those probes, so this does not classify the password.
Regression RED ev-013 reproduced403; GREEN ev-014 reached expected400 after
switching the ephemeral client's transport to curl. Request credentials/auth
headers travel on stdin only, never argv, files, stderr logs or chat; API target
remains fixed HTTPS staging, redirects disabled, no browser token extraction.
Client restarted and its local endpoint was checked through the same blank
validation path. Actual user login and authenticated quota-history acceptance
remain pending; no staging application/authentication policy was changed.


## Authenticated staging acceptance — 2026-10-26 18:10 ICT

User completed normal staging login in the loopback client. First observed
run passed envelope/cursor/legacy-filter/error probes but date validation was
false. Python3.9 fromisoformat rejects valid RFC3339 fractional lengths such as
5digits. RED ev-015 reproduced the helper limitation; GREEN ev-016 validates
normalization of0/1/4/5/6/9 fractional digits, offsets and exclusive upper bound.
The helper was restarted without persisting session; user logged in again.
A first artifact read ev-017 was pending (login done, checks not yet run), not
an API failure or acceptance result. Codex then clicked the read-only check
button through native Opera. No credentials or browser token were extracted.

Actual runtime artifact ev-018 at2026-10-26T11:10:27.575687Z:
- authenticated page200, limit2, items2, has_more/next_cursor; no total/offset;
- next page200/items2 and no overlapping IDs;
- legacy channel/offset parameters no longer filter/offset:200, same first IDs;
- invalid cursor400; inverted date bounds400;
- unknown/unowned all-zero merchant scope404;
- returned rows inside supplied30day bounds: parse_errors0/out_of_range0.
Visible timestamps included2026-10-26T11:00:17.47942Z (5digits), confirming the
initial helper-parser failure while the API timestamp/date bounds were valid.
UI screenshot: /tmp/vs052-staging-acceptance-passed.png.

Scope: one authenticated staging merchant/branch, two pages. The all-zero
merchant is a nonexistent-scope probe, not a real second-account authorization
exercise. Cross-merchant service-denial behavior remains backed by the focused
implementation tests; no claim of a full live RBAC matrix. No verify/bank,
purchase or wallet endpoint was called by the checks. Implementation/staging
acceptance is complete. Production promotion remains separately unapproved;
the production Review Queue boundary remains open.

## Production authorization and readiness — 2026-10-28

Operator explicitly permitted promotion alongside TASK-VS-053 if readiness passes. Reopened only to perform the authorized production release; authz-002 and production deployment/acceptance gates recorded.

Fresh readiness evidence on merged release candidate:
- ev-019 readonly build passes; ev-020 vet passes.
- ev-021 verifies candidate internal source, README and AGENTS match current staging exactly.
- ev-022 full PostgreSQL18.3-enabled test suite passes, including VS052 cursor/range/adjustment/permission tests and VS053 count regressions. No existing tests weakened.
- Current tracked frontend branchApi.quotaHistory still returns[]; its active tab uses the existing cursor-paged package-history route. Existing external users of the old sibling envelope would need migration; none is inferred absent globally. A complete read-only production log filter for sibling quota-history returned no access events in the prior24h sample at04:33:40Z; that is only a sampled observation.
- Historical authenticated staging ev-018 was read, including next-page/no-overlap, legacy ignored keys, invalid inputs400, unknown scope404 and valid date bounds. Source has not changed since that accepted staging implementation.

Promotion branch release/TASK-VS-052-production merges staging7a611b9 into existing prod742df4f as7f7f3d6aa37a9590b45553c03eaf3c52898d3b5a. Cached diff confirmed no workflow or ECS task-definition changes; prod settings preserved. The only application delta is VS052; VS053 files remain present and unchanged. Documentation authority update VS051 is included from staging.

PR107 verified baseprod, headrelease/TASK-VS-052-production; merged as52b4e99903a6dace4d51ff101e7916ea3aca0eef. Production workflow40633470223 started. Previous revision/task for rollback: production-sha-742df4f / slip-api-production:115, COMPLETED3/3. This rollback preserves VS053 and restores VS052's old sibling contract; no data rollback or migration.

Prepared a production-only copy of the prior read-only QA client at http://127.0.0.1:19453. Target is fixed https://api.up-slip.com, no redirects; credentials/auth headers passed to curl on stdin and kept only in memory, never artifacts. Page/no-session/foreign-origin checks were200/401/403. Operator logged in normally using a merchant account; selected Be shop / be-tt for eventual acceptance. No credential extraction or fabricated identity. No bank/verification/purchase/wallet operations are exposed by this client.

## Production release and scoped acceptance — 2026-10-28

- ev-023 confirms scoped production delta; no workflow/task-definition changes. Stage internal source and docs match prod after PR107, and staging7a611b9 is an ancestor of prod52b4e99. VS053 COUNT code files are identical between stage/prod.
- ev-029: Deploy PRODUCTION40633470223 succeeded. ev-030: production-sha-52b4e99 / slip-api-production:116, COMPLETED, desired/running3/3. Prior :115 / production-sha-742df4f remains rollback reference and would retain COUNT fix.
- Operator completed normal production merchant login in the fixed-target local QA client. Chosen existing owned merchant Be shop / branch be-tt had enough rows; no user change or fixtures needed.
- Pre-cutover ev-024 at04:41:44Z: old :115 still served all requests (:116 running0). The page had2 rows but old envelope/legacy behavior, so all_observed_checks_pass=false was expected. The helper's null next-cursor note is not evidence that the account lacked data; old shape prevented that probe.
- At the new-code acceptance cutover, :116 tasks a5e9afa1596b4171aaab7eed98878e25 / b8ab0417ca2049a29c8db06828c57484 / f0852db6be0f48c29354dcafd01bb138 were all RUNNING/HEALTHY and old tasks running0, while ECS finished drain.
- ev-026 at04:44:30.804888Z: authenticated bounded envelope200/items2, next cursor200/items2/no overlapping IDs, no total/offset; obsolete channel/offset ignored; invalid cursor400; inverted dates400; nonexistent merchant scope404; date parse_errors0/out_of_range0; all_observed_checks_pass=true. Archived sanitized result: evidence/production-acceptance.json. No credential/auth header/row payload exported.
- ev-027: all6 corresponding quota-history access records are from the3 new :116 streams; statuses200x3,400x2,404x1 (expected negative probes), max7ms. No500.
- ev-028: after refreshing the existing O2p/5G monthly Report on :116, COUNT-related access sample32/32 HTTP200 across all3 new tasks, max47ms. VS053 remains healthy in that sampled scenario.
- Work settings disabled local browser control before a planned final UI repeat. This was respected; no browser-cookie/token extraction, alternate browser-control bypass or fabricated session was used. Earlier authenticated probes ran on the actual new revision; final deployment completion is independently verified by AWS/GitHub. The planned post-COMPLETED browser repeat and fresh rendered COUNT screenshot were not performed.
- Acceptance scope: one real merchant/branch, two pages and named input/scope probes. Nonexistent merchant404 is not a second real account isolation test; fresh service permission tests cover the denial behavior separately. No all-consumer, all-account, large-tenant throughput or long-term claim. No bank/verification/purchase/credit mutations were performed by QA.
