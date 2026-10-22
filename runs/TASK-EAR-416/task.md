# TASK-EAR-416: Propagate X-Request-ID from slip-api to slip-system

SPAR-33 item 4. Draft PRs only: send X-Request-ID on the bank gRPC call and log it on KBank 8500 and duplicate-persist failure. No slip or PII in those logs. Do not merge or deploy.

## Result

- slip-api draft PR https://github.com/SparqLab/slip-api/pull/81 (`a8e5aa3`, base `main`): gRPC metadata `x-request-id` on `VerifyBankSlip`; duplicate-persist failure logs `request_id` and no longer logs `trans_ref`.
- slip-system draft PR https://github.com/SparqLab/slip-system/pull/14 (`3218e5b`, base `main`): `VerifyBankSlip` copies `x-request-id` onto the KBank 8500 log. Slip reference is not logged.
- New tests failed before the change and passed after. `GOWORK=off go test -count=1 ./...` and `GOWORK=off go build -mod=readonly ./...` passed in both repos.
- Not merged. Not deployed. Proto unchanged.
