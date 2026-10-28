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

## 2026-10-28 re-check: partial front-end fix on prod, bug still live (Claude)

Operator asked whether the new slip-age rule closed this task. It does not.

- **What runs on prod (ev-005):**
  - slip-api `slip-api-production:117` = `production-sha-1dd7ab3` = `origin/prod`.
  - slip-front-end `slip-front-end-production:70` = `production-sha-8b9906f` = `origin/prod`, registered 2026-10-28 11:44 +07.
- **Backend message changed again.** slip-api `20bbd6f` (watcharapol-spl, 2026-10-26, on prod) split `paymentSlipAgeReason`:
  - older than 24h → `เกิดข้อผิดพลาด เนื่องจากสลิปเกินเวลา โปรดติดต่อแอดมิน`
  - future-dated → `slip must be transferred within 24 hours`
  - The 422 body is still the bare `PaymentTransactionResponse` with `rejection_reason`.
- **Front-end change (Thanwa, `8b9906f`, no PR, no TASK id):**
  - Adds reject kind `'expired'` with copy (`branchTopupExpired*`), `slipRejectKindFromText`, `paymentLooksTooOld`, `paymentLooksNotVerified`.
  - Both composables now call `slipRejectKindFromText(payment.message) ?? 'destination'`.
  - `mapPayment` gained `message: paymentNote(record, root)`, but `paymentNote` reads only `statusMessage`, `status_message`, `outcome_reason`, `outcomeReason`, `reason`, `message`, `error`. **It never reads `rejection_reason`.**
  - So on the 422-with-payment path (`usePaymentService.submitSlip` → `mapPayment(body, 422)`), `message` is `null` and every rejection still becomes `'mismatch'` → `'destination'`.
  - Even if the reason were read, `paymentLooksTooOld` does not match the new Thai >24h text (`เกินเวลา`), nor the legacy `slip must be transferred today`.
  - The thrown-error path (`handleSubmitError`) now checks the message via `ApiError` (`readBackendMessage` does read `rejection_reason`), but it only runs when the 422 body has no payment id. Not tested here.
- **ev-004 (RED on the prod export):** scratch `node:test` on `origin/prod` `8b9906f`, Node 24 with a resolve hook for `~/` and extensionless imports. Each body is `{ id, status: 'rejected', rejection_reason, amount }` with HTTP 422:

  | rejection_reason | `status` | `message` | shown kind |
  |---|---|---|---|
  | `เกิดข้อผิดพลาด เนื่องจากสลิปเกินเวลา โปรดติดต่อแอดมิน` | mismatch | null | destination ✖ |
  | `slip must be transferred within 24 hours` | mismatch | null | destination ✖ |
  | `slip transfer date unavailable` | mismatch | null | destination ✖ |
  | `slip not verified` | mismatch | null | destination ✖ |
  | `slip amount unavailable` | mismatch | null | destination ✖ |
  | `receiver does not match configured accounts` | mismatch | null | destination ✔ |

  The "shown kind" column applies the composable rule from `useCreditTopup.ts` / `useBranchPurchase.ts:1094`, not the Vue composable itself.

### What is left for the developer

- Read `rejection_reason` in `paymentNote` (record and root), or classify `rejection_reason` directly.
- Match the backend's real strings in `paymentLooksTooOld`: the Thai >24h text and the legacy `slip must be transferred today`. Matching the exact backend strings beats keyword guesses that drift whenever the backend copy changes.
- Map `slip amount unavailable` to `'unreadable'` (acceptance table above).
- Add the ev-004 cases as a committed regression test. CI still runs only lint and typecheck.

## Developer handoff spec (2026-10-28, supersedes the acceptance table above)

Traced on prod code: slip-api `1dd7ab3` (`Submit` in `internal/core/service/payment.go`, `writeRejectedPayment` / `writePaymentError` in `internal/handler/http/payment.go`) and slip-front-end `8b9906f`.

### Root cause, one line

The backend answers a rejected slip with HTTP 422 and the payment body `{ "id": "...", "status": "rejected", "rejection_reason": "<reason>", ... }`. `submitSlip` passes it to `mapPayment(body, 422)`, and `paymentNote()` never reads `rejection_reason`. So `payment.message` is `null`, `slipRejectKindFromText(null)` returns `null`, and the composables fall back to `'destination'`.

### Condition table

The backend checks in this order and stops at the first failure: bank verify → slip age → receiver → amount. A slip that is both too old and sent to the wrong account therefore gets only the age reason.

**A. 422 with a payment body (classify `rejection_reason`):**

| `rejection_reason` (exact) | When | Should show | Prod `8b9906f` |
|---|---|---|---|
| `slip not verified` | bank did not confirm the transfer | `not_found` | destination ✖ |
| `เกิดข้อผิดพลาด เนื่องจากสลิปเกินเวลา โปรดติดต่อแอดมิน` | transferred more than 24h ago (`20bbd6f`) | `expired` | destination ✖ |
| `slip must be transferred within 24 hours` | transfer time in the future (clock skew, rare) | `expired` or a generic rejected message | destination ✖ |
| `slip transfer date unavailable` | bank response has no transfer time | `unreadable`, with transfer-time copy (D2) | destination ✖ |
| `receiver does not match configured accounts` | wrong destination account | `destination` | destination ✔ |
| `slip amount unavailable` | amount unreadable | `unreadable` | destination ✖ |
| `slip must be transferred today` | legacy rows before `1fd81a9`, seen in `GET /v1/payments` history only | `expired` | n/a |
| any other or empty reason | — | `not_found` or a generic rejected message | **never `destination`** |

**B. Errors without a payment body (`handleSubmitError`, mostly correct already):**

- `duplicate slip` (409) → `duplicate` ✔
- QR/file errors (400 `no QR code found in image`, `invalid or unsupported image`, `failed to decode image`, `slip QR missing sendingBank/transRef`; 413 `image too large`) → `unreadable` with a toast ✔
- `no receiving accounts configured` (422, platform config) → currently `'destination'`. Optional: a generic system message instead.

### Files to change

1. `app/features/payments/map.ts`: read `rejection_reason` from both record and root. Preferred: add `rejectionReason: string | null` to `IPayment` (`app/features/payments/type.ts`) and classify it first; adding it to `paymentNote()` also works.
2. `app/features/payments/utils.ts`: make `slipRejectKindFromText` match the exact backend strings in table A first, then fall back to keywords. The backend copy changed three times in a month (`b5d519f` → `1fd81a9` → `20bbd6f`), and `paymentLooksTooOld` already misses `เกินเวลา` and `must be transferred today`. Add `slip amount unavailable` → `'unreadable'`.
3. `app/features/payments/composables/useCreditTopup.ts` (`applyPaymentResult`) and `app/features/branches/composables/useBranchPurchase.ts` (~1079–1100): both duplicate the same logic, so keep them in step (one shared helper preferred). An `'unreadable'` result must also set the unreadable flag.
4. No backend or API contract change.

### Acceptance

- A committed regression test covers every row of table A: feed the body above with HTTP 422 and assert the resulting reject kind.
- The test is seen **failing on the unfixed code** first, then passing. ev-004 shows 5 of 6 cases failing on `8b9906f`.
- The expired screen has a working contact admin/CS action (D1). `slip transfer date unavailable` shows transfer-time copy, not the amount copy (D2). Both credit top-up and branch purchase top-up are checked.
- slip-front-end CI runs only lint and typecheck, so the PR includes the test run output. Use the same runner as the existing `tests/*.test.ts` (`node:test`; there is no `test` script in `package.json`).
- PR into `main` first. No direct push to prod (`8b9906f` went to prod without a PR).

### Decisions (Earth, 2026-10-28)

- **D1, decided: the expired screen gets a contact admin/CS action.**
  - Why: the chip says `เกินกำหนด 24 ชม. · ต้องแนบสลิปใบใหม่`, but a customer who paid more than 24h ago has no newer slip. The backend text already says to contact admin, and admin can credit the money through Users → Top-up.
  - Change the chip so it no longer tells the customer only to attach a new slip.
  - **Trap:** the existing `contactSupport()` in `useCreditTopup.ts:717` and `useBranchPurchase.ts:1331` only shows the toast `เปิดเคสพร้อมแนบข้อมูลรายการนี้แล้ว`. It opens no case, so wiring the new button to it would tell the customer a case exists when none does.
  - The button must reach a real channel. The repo already has one pattern: `useSuspended.ts` builds `mailto:${authSupportEmail}` (`support@up-slip.com`, `app/features/auth/constants.ts`) with the reference in the subject. Reuse it with the payment reference (`paymentDisplayId`) unless Earth names another channel (for example LINE OA).
- **D2, decided: `slip transfer date unavailable` → `'unreadable'`, with copy that says the transfer date and time could not be read.**
  - The current unreadable copy is amount-specific: `branchTopupUnreadableTitle` `อ่านยอดจากสลิปไม่ได้`, and the body talks about the amount. This case needs its own title/body (for example `อ่านวันเวลาโอนจากสลิปไม่ได้`), either as a copy variant on the unreadable kind or a separate constant.
  - Not `'expired'`, because `สลิปมีอายุเกิน 24 ชั่วโมง` would be false.
- **D3, open, later and outside this task:** ask slip-api for a stable `rejection_code` beside the text, so a copy change no longer breaks the front end. This is a contract change.
