# TASK-VS-046: Show real topup slip rejection reason in slip-front-end

Merchant credit top-up rejected a real 40,000 THB slip and told the user "สลิปที่แนบมาบัญชีปลายทางไม่ตรง" (destination account mismatch). The destination account was correct. The slip failed the backend's same-day rule, and slip-front-end shows every 422 rejection as a destination mismatch.

**Scope split (Earth, 2026-10-25):** Claude did the investigation only and recorded it here. Another developer implements the slip-front-end fix. No code, branch, or PR exists for this task yet.

## 2026-10-25 investigation (Claude)

### Symptom

- Payment `f9795cd2-9827-4f4a-81c5-04703c7f6d72` was submitted three times via `POST /v1/payments/slips`, at 05:01:05Z, 05:02:07Z and 05:03:11Z on 2026-10-25 (12:01–12:03 Bangkok). Every attempt returned 422 with a 527-byte body (ev-002).
- The top-up modal shows "บัญชีปลายทางไม่ตรง · ต้องแนบสลิปใบใหม่". The slip shows a KTB transfer to KBank `XXX-X-XX299-3`, the company's name, 40,000.00 THB, dated 24 Oct 2026 17:47. The platform account is KBank `1063762993`, the same company.

### Evidence

- **Production DB row**, queried by Earth in DBeaver on 2026-10-25:

  | status | rejection_reason | trans_datetime | receiver_account | amount |
  |---|---|---|---|---|
  | `rejected` | `slip must be transferred today` | `20261024 17:47:27` | `XXX-X-XX299-3` | 40,000 |

- **ev-001:** a scratch test was run on an export of slip-api `origin/prod` `dbd70b9`. Production runs image `production-sha-dbd70b9` (`slip-api-production:106`), checked 2026-10-25. Results:
  - Submitted the next day, `paymentSlipTodayReason` returns `"slip must be transferred today"`.
  - Submitted the same day at 23:59, it returns `""`.
  - `matchPlatformReceiver` with KBank `1063762993` matches both `XXX-X-XX299-3` and a KBank-style `xxx-x-x6299-x`. The account would have passed.
- **ev-002:** the production `slip-api` access log for the three 422s. The log has no rejection reason, because the reason is only in the response body and the DB row.

### Root cause

1. **The backend rejects as designed.** In `slip-api` `internal/core/service/payment.go` `Submit`, the order is:
   - bank verify (`slip not verified`)
   - same-day rule (`slip must be transferred today` / `slip transfer date unavailable`), added in `b5d519f` on 2026-09-25
   - receiver match (`receiver does not match configured accounts`)
   - amount (`slip amount unavailable`)

   This slip stopped at the same-day rule, so the receiver check never ran. `writeRejectedPayment` (`internal/handler/http/payment.go`) returns **422 with the PaymentTransaction JSON**: `status: "rejected"` and `rejection_reason: "<reason>"`.

2. **slip-front-end discards the reason.** Line numbers are on `origin/main` `c3dc067`. These files are identical on `origin/prod` `e44d302`.
   - `app/features/payments/map.ts` `mapPayment` never reads `rejection_reason`. `resolvePaymentStatus` hints (line 175) are status, statusMessage, outcome, and message only. At line 195, any 422 that is not a duplicate or mismatch text returns `'mismatch'`, even when the body says `status: "rejected"`. The backend never sends a status of `mismatch`; its statuses are `pending`, `credited`, `rejected` and `duplicate`.
   - `app/features/payments/composables/useCreditTopup.ts:459` and `app/features/branches/composables/useBranchPurchase.ts:1065`: `status === 'mismatch'` with `creditedAmount === 0` becomes reject kind `'destination'`. So every 422 rejection shows as a destination mismatch:
     - `slip not verified`
     - `slip must be transferred today`
     - `slip transfer date unavailable`
     - `slip amount unavailable`
   - The thrown-error path does the same:
     - `useCreditTopup.ts:502` maps a bare `statusCode === 422` to `'destination'`.
     - `useBranchPurchase.ts:1101` maps `isReceiverMismatchPaymentError(error) || statusCode === 422` to `'destination'`.

     Thrown 422s without a payment body come from `ErrNoSettingBankAccount`, `ErrReceiverMismatch`, `ErrPaymentNotVerified`, or a slip-system gRPC `InvalidArgument` (`mapVerifyError`).
   - `ITopupRejectKind` (`app/features/branches/type.ts:181`) has no kind for the same-day rule. The copy lives in `app/features/branches/topup.ts`. `app/features/branches/ui/BranchTopupReview.vue` switches on the kind in five computeds: title, body, chip, display and hint.

## Implementation handoff (for the developer)

### Acceptance criteria

- Map each 422 rejection reason from the backend to its own message:

  | `rejection_reason` | Reject kind / message |
  |---|---|
  | `slip must be transferred within 24 hours` (current, since slip-api `1fd81a9`); `slip must be transferred today` (older rejected rows still listed by `GET /v1/payments`); `slip transfer date unavailable` | New slip-age kind (suggested `'stale'`, matching the verification flag name). Copy: only slips transferred within the last 24 hours are accepted. If money was already sent but the slip is older, contact CS with the slip. Re-attaching the same slip cannot pass, so do not offer only "attach again". |
  | `receiver does not match configured accounts` | `'destination'`, unchanged |
  | `slip not verified` | `'not_found'` |
  | `slip amount unavailable` | `'unreadable'` |
  | any other or empty reason on a 422 rejection | not `'destination'`. Suggest `'not_found'` or a generic rejected message. |

- The fix applies to both flows: credit top-up (`useCreditTopup.ts`) and branch purchase top-up (`useBranchPurchase.ts`). Both currently duplicate the `applyPaymentResult` and `handleSubmitError` logic. One shared pure helper keeps them from drifting.
- A thrown 422 whose message is not a receiver mismatch no longer becomes `'destination'`.
- No backend or API contract change is needed. `rejection_reason` is already in the 422 body and in `GET /v1/payments` rows.

### Suggested shape

- **`IPayment` and `mapPayment`:** add `rejectionReason: string | null` to `IPayment` (`app/features/payments/type.ts`) and read `record.rejection_reason` in `mapPayment`.
- **Status:** in `resolvePaymentStatus`, an explicit `status: "rejected"` must win over the 422 → `'mismatch'` fallback.
- **Classification:** classify the reason in one pure function, for example in `app/features/payments/utils.ts` or `app/features/branches/topup.ts`. Call it from the `rejected` and fall-through branches of both composables' `applyPaymentResult` and `handleSubmitError`.
- **New kind:** add it to `ITopupRejectKind`, `topup.ts` copy, `BranchTopupReview.vue`, and any other switch on the kind (`rg "RejectKind" app`).

### Regression test (RED before the fix)

- `mapPayment({ id, status: 'rejected', rejection_reason: 'slip must be transferred within 24 hours', amount: '40000.00' }, 422)` must not produce `status: 'mismatch'`. On `c3dc067` it does: `'mismatch'`, credited 0, then `'destination'`.
- The classifier maps each reason in the table above.
- **Test runner caveat:** the repo has no test script, and CI runs only `bun run lint` and `bun run typecheck`. The one existing test, `tests/verification-idempotency.test.ts`, uses `node:test` with an extensionless import. `node --test --experimental-strip-types` (Node 24) fails it with `ERR_MODULE_NOT_FOUND`. TASK-VS-028's ev-013 shows the same failure masked by `| tail`.
- `map.ts` imports through the `~/` alias. Its import tree (bank-accounts/constants, payments/constants, payments/utils, verification/constants, utils/api-payload, utils/api-error) is plain TypeScript with no package imports. So either of these works:
  - `bun test` after `bun install` and `nuxt prepare`
  - Node 24 with a small `module.registerHooks` resolve hook mapping `~/` to `app/` and extensionless to `.ts`
- Record which runner was used, and show the failing run before the fix.

### Out of scope / decisions for Earth

- **Business rule:** decided 2026-10-25. See the update below.
- **This customer:** see the update below.

## 2026-10-25 16:40 update: backend rule changed on prod (Claude, re-checked remote refs)

- **The backend rule changed.** slip-api `1fd81a9` (watcharapol-spl, 12:46) replaced the same-Bangkok-day rule with a 24-hour window, `paymentSlipAgeReason`:
  - transfer time in the future, or more than 24h ago → reject with `slip must be transferred within 24 hours`
  - `slip transfer date unavailable` is unchanged
  - no test was added for the new rule
- **It is live on prod.** It went `main` → `staging` → `prod` directly, with no PR:
  - `450fd9a`: Deploy PRODUCTION succeeded 05:57Z
  - `1ee6fa3`: deploy finished 08:53Z
  - ECS `slip-api-production:108` runs `production-sha-1ee6fa3`, 3/3
- **The front end is unchanged.** No slip-front-end commit or branch exists since `c3dc067`, so every 422 rejection, including the new reason, still shows "บัญชีปลายทางไม่ตรง". The handoff above stands, with the reason string updated in the table.
- **This customer's slip** (trans_datetime `20261024 17:47:27`):
  - Under the new rule it passes until **2026-10-25 17:47:27 BKK** and fails after that. Checked by a scratch test on the `origin/prod` `1ee6fa3` export (ev-003).
  - The earlier attempts 2 and 3 re-verified instead of returning 409, so the rejected row does not block a retry.
  - Prod logs show two `payment_submit_slip` 200s at 06:02:21Z and 06:02:35Z (13:02 BKK), from the same browser family as the customer but a different IP.
  - Whether they credited this slip is **unverified**. Check with:
    `SELECT id, status, rejection_reason, amount, credited_at, created_at FROM payment_transactions WHERE trans_ref = (SELECT trans_ref FROM payment_transactions WHERE id = 'f9795cd2-9827-4f4a-81c5-04703c7f6d72') ORDER BY created_at;`
- **Unrelated, also on prod, not reviewed:** slip-api `3a00e07` "fix(branch): correct expiry check logic in Purchase method" removes the `ErrPackageAlreadyActive` guard in `BranchPackageRepository.Purchase`. Re-buying the currently active package is no longer rejected. It has no test. This is outside TASK-VS-046.
