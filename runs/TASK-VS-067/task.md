# TASK-VS-067: UpSlip: log topup slip rejection reasons by request_id

When `POST /v1/payments/slips` rejects a top-up slip, the production access log shows only
`Unprocessable Entity`, and `inspect` writes no `payment_transactions` row. The SPAR-62 case
(TASK-VS-062) had to be replayed against the provider to learn the receiver, and other 422s
cannot be explained after the fact. Make every rejection in `inspect` explainable from one
`request_id`, without replaying the provider and without logging personal data.

- Type: observability in `slip-api` only. No schema change, no API contract change.
- Source: Multica SPAR-63 (follow-up of SPAR-62 / TASK-VS-062). Opened 2026-11-09 by the Claude
  conductor lane at Earth's request ("เปิด VS-067"). Claude opens the run only; implementation
  goes to another lane (SPAR-63 is assigned to the squad).
- Gates: `production` preset + `knowledge_closeout`. UpSlip prod is live, not cost-gated.
  Promote main → staging → prod through PRs (`verifyslip-promote` skill).
- Out of scope: the slip-front-end message that shows every non-duplicate 422 as
  "ธนาคารไม่พบรายการ / บัญชีปลายทางไม่ตรง". That fix is **TASK-VS-046** (another developer,
  decisions D1/D2 already made). Do not change front-end copy here; this run is not blocked by
  VS-046 and VS-046 is not blocked by this run.

## Code map (slip-api `origin/main` `5a8eb87`, 2026-11-09)

- `internal/core/service/payment.go:205` `inspect` — shared by `Submit` (`/v1/payments/slips`,
  line 154) and `Confirm` (`/v1/payments/confirm`, line 159). Rejection exits, in order:
  - inactive/missing user (`requireActiveUser`)
  - `sending_bank and trans_ref are required` (validation)
  - no active setting bank account (`ErrNoSettingBankAccount`)
  - duplicate slip, before and after the provider call (`ErrDuplicateSlip`)
  - provider/verify error (`verifyErr`)
  - not verified (`ErrPaymentNotVerified`)
  - slip age rule (`paymentSlipAgeReason`, line 632)
  - receiver mismatch (`matchPlatformReceiver`, line 492, `ErrReceiverMismatch`)
  - `slip amount unavailable`
- `internal/handler/http/payment.go:136` `submit`: when `result.Status == rejected` it writes
  **422 with the PaymentCheck JSON** (`status`, `rejection_reason`, plus slip fields). Other
  errors go through `writePaymentError` (line 299) as `{"message": …}`.
- `internal/models/reports.go:511` `ErrorReason` reads only `message`, else `outcome_reason`.
  The rejected-slip body has neither, so `internal/handler/middleware/audit.go:248`
  `errorMessageFromBody` falls back to `http.StatusText(422)`. That is the "Unprocessable
  Entity" in the log.
- Route labels for `/v1/payments/slips` and `/v1/payments/confirm` already exist in
  `internal/handler/middleware/metrics.go:120-125`.

## Scope

1. **Access log carries the real reason.** `ErrorReason` also reads `rejection_reason` (after
   `message`, before `outcome_reason` or wherever keeps existing callers' results unchanged).
   `rejection_reason` values are fixed server strings, so this stays allowlisted. Keep the
   "never keep the body" rule in the function comment.
2. **One Warn log per rejection inside `inspect`**, so `/slips` and `/confirm` are both covered
   by one place. Fields:
   - `request_id`, `user_id`, `reason` as a **stable code** (e.g. `not_verified`,
     `slip_too_old`, `transfer_date_unavailable`, `receiver_mismatch`, `amount_unavailable`,
     `duplicate`, `no_platform_account`, `verify_error`, `validation`) — a fixed set defined
     once, not the free-text message
   - `provider_status`, `sending_bank`, `receiving_bank`
   - `receiver_bank_code`, `receiver_account_type`, `receiver_account_masked`, `proxy_present`
   - `trans_ref_sha256` truncated (short prefix of the hash, never the value)
   - `slip_age_seconds`
   Fields not known at the exit point are omitted, not invented.
3. **Count rejections by `reason` and `sending_bank`.** Alerting is decided later from the
   counts, not in this run. `reason` is the fixed code set from item 2. `sending_bank` is
   **not** bounded today: `inspect` (`payment.go:210`) only trims it and checks it is non-empty,
   and some exits reject before the provider is called, so a client-supplied string can reach
   the label. `models.ValidBankCode` (`bank_account.go:107`, `^[0-9]{3}$`) is used only for
   saved bank accounts, and alone still allows 1000 values. So the metric label is:
   - the request's `sending_bank` after `models.NormalizeBankCode`, not the provider's value
     (`payment.go:652` overwrites `SendingBank` from the provider response);
   - kept only if it is in an explicit list of known sending-bank codes defined once in code;
     anything else (empty, malformed, unknown) becomes `unknown`;
   - covered by a test: a known code keeps its value, and a malformed or unlisted value is
     counted as `unknown`.
   The Warn log may still carry the normalized request value; only the metric label is folded.

### Never log

Sender and receiver names, the sender account number, the raw provider/response body, the full
`trans_ref`, and the full receiver account number when the provider sends it unmasked
(`receiver_account_masked` must be masked by our code, not passed through).

## Acceptance

- Every rejection exit in `inspect` emits a log line whose `reason` code tells the exits apart;
  a table test drives each exit and asserts the code and `request_id`.
- **RED before the fix, from current behaviour only** (no simulated bug): on `origin/main`,
  `ErrorReason` returns `""` for a rejected-slip body (`{"status":"rejected","rejection_reason":…}`),
  and an `inspect` rejection exit emits no rejection log line. Record both failing runs.
- `ErrorReason` test: a rejected-slip body yields its `rejection_reason`; existing `message` /
  `outcome_reason` cases keep their results.
- Privacy test against the real implementation (does not need to be RED first): feed a provider
  response containing real-looking names, a full sender account, a full unmasked receiver
  account and a `trans_ref`, drive a rejection, capture the log output, then
  1. assert the rejection line **was emitted** with its safe fields (`request_id`, `reason`,
     `receiver_account_masked`, truncated `trans_ref_sha256`) — otherwise "nothing leaked" is
     vacuous;
  2. assert none of the sensitive values appear anywhere in the output.
- Metric label test as in Scope item 3 (known code kept, anything else `unknown`).
- One `request_id` is enough to find the reason and the receiver shape in CloudWatch, without a
  provider replay.
- **Production check:** one real 422 on prod after the deploy, found by its `request_id`, shows
  the reason code and receiver shape. "No log lines" is not evidence (see
  `cloudwatch-log-evidence`). Tests passing alone do not close the run.

## Notes for the implementer

- This repo is synced publicly. Do not paste real account masks, bank codes of the platform
  account, customer names or `trans_ref` values into this run's synced files; keep raw evidence
  under `evidence/` (local only).
- Logging lives in the service; keep the handler unchanged apart from what item 1 needs.
- Top-up rejections are a small share of traffic (the high-volume `/v1/slips/verify` path is not
  touched), so one Warn line per rejection is acceptable; check the actual top-up 422 rate in
  CloudWatch before adding any sampling.

## Runtime reconciliation — 2026-11-10

Earth requested updating this run and SPAR-63 to the observed runtime while keeping
unproven acceptance pending. Snapshot: **09:09 UTC / 16:09 ICT**, TASK-VS-067 `ev-033`.

| Environment | Current task definition | Image | Running / desired | PRIMARY rollout at snapshot |
| --- | --- | --- | --- | --- |
| staging | `slip-api-staging:194` | `staging-sha-fc67804` | 1 / 1 | `IN_PROGRESS`; revision 193 draining |
| production | `slip-api-production:148` | `production-sha-d567be9` | 3 / 3 | `IN_PROGRESS`; revision 147 draining |

Both deployment sources contain SPAR-63. The logging helper and `reports.go` are identical
to reviewed head `0c5b3476`; the `inspect` function is identical as well. This source check
does not re-review unrelated changes in the newer images. Original implementation PR
[#131](https://github.com/SparqLab/slip-api/pull/131) and staging promotion PR
[#132](https://github.com/SparqLab/slip-api/pull/132) are merged. Earlier staging:188 and
production:142 statements are dated observations, superseded for current-runtime purposes.

The independent code audit found no new blocking issue. Race tests (`GOWORK=off go test
-race ./... -count=1`), readonly build and `go vet ./...` were rerun successfully on reviewed
head `0c5b3476`. The two regression checks were rerun on baseline `5a8eb87` and failed for
the real missing reason/log behavior. Original recorded evidence `ev-018` through `ev-022`
was also hash-checked. Infrastructure-dependent tests retain their existing environment
gates; this is not an end-to-end acceptance claim for the newer deployment images.

The fully paginated log audit covers **2026-11-09 08:30 through 2026-11-10 08:55 UTC**
(15:30 through 15:55 ICT). Staging Warn/access reads consumed 4/4 pages, production 10/11
pages; no top-up 422/request-ID join was found. Public metric snapshots had no payment
rejection series. This window spans rollouts; a zero without top-up traffic is not an
acceptance pass. The audit remains **PARTIAL**, with no controlled counter delta (`ev-034`).

`staging_acceptance` and `production_acceptance` remain **pending**. Next evidence needed:
an approved staging account/token and rejected-slip fixture for a real authenticated
422, a request-ID join to Warn/access reason and receiver shape, a counter delta on stable
tasks, and a real post-deploy production 422. The run remains `in_review`.

The existing `deploy_production` gate remains pending under its ordering and authorization
contract: `staging_acceptance` is unresolved and only the original staging grant is recorded.
Production inclusion is observed separately; this record update neither performs a deploy
nor invents a retrospective production grant. Preserve the acceptance gates and reconcile
release records through the governed writer once the requirements are met.
