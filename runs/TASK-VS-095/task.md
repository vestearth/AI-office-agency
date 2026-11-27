# TASK-VS-095: Portal single-slip 8404 retry

slip-api and slip-front-end. Single slip on /verification only: retain key for same image and branch after 8404, expose wait countdown, and verify staging quota ledger. Implementation PR targets main in both repos; promotion PR targets staging.

## Delivery and acceptance

- API implementation [#187](https://github.com/SparqLab/slip-api/pull/187), included in [Staging #188](https://github.com/SparqLab/slip-api/pull/188) alongside TASK-VS-094 with Earth’s approval.
- Portal implementation [#50](https://github.com/SparqLab/slip-front-end/pull/50), promoted via [Staging #51](https://github.com/SparqLab/slip-front-end/pull/51).
- API test and build evidence `ev-001`. Portal focused lint, typecheck and 12 tests `ev-002`. The global Portal lint failures predate the change and are in the package management views.
- Local PostgreSQL integration with a stubbed 8404 response verified one bank call, one verification row, one `quota_history` deduction of −1 across two requests with the same key.
- Pending Staging acceptance. QA supplies the request IDs or exact time for two same-file, same-branch submissions within 30 seconds. The conductor joins those requests to verification records and `quota_history`.

- Both Staging workflows succeeded and ECS reached steady state on slip-api-staging:226 (image 2ee65aa) and slip-front-end-staging:152 (image 4b72c84). Evidence `ev-004`.

## Staging acceptance — 2026-11-24

- Signed-in Portal test produced HTTP 422 for requests `d0c86295` at 12:21:12.785 ICT and `c5d03274` at 12:21:21.062 ICT, 8.28 seconds apart.
- The first request persisted an 8404 with a bound client key and logged `charged=false`. The second returned 422 with the same response envelope size class, no bank quota decision, no new verification row, and no linked quota deduction. The deployed replay code accounts for this same-key behavior. Raw keys are absent from audit logs.
- Across the five HTTP requests for this test, the four persisted 8404 verifications identify the same slip. The only ledger row was `938688e5` (−1) for `ed1ad604`, the initial check.
