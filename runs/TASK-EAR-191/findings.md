# TASK-EAR-191 — Store payment webhook: decision, fix, and live verification

Critical fix, 2026-08-13, against `Games-Labs-Missions` `staging`. Two PRs
landed in sequence — containment (#105), then full removal (#106) — plus a
docs cleanup (#107). This file records the decision trail, the collision that
happened mid-flight, and independent live verification against staging with
a freshly created player account.

## 1. Who may legitimately call this webhook? Answer: no one, today

Before writing any code, the question task.md required answering first:

- **Grep across the whole monorepo** (`store-payment` / `StorePaymentWebhook`)
  found only the route registration (`internal/routes/apiv1.go:71`), the
  gRPC bridge (`internal/handlers/mission/grpc/server.go:352-353`), and
  generated proto scaffolding. No caller anywhere.
- **No real PSP integration exists for this flow at all.** Stripe and UBIT
  live entirely in `Games-Labs-Wallet/internal/core/services/paymentsvc/`
  (`stripe_callback.go`, `ubit_callback.go`, real signature verification via
  `webhook.ConstructEventWithOptions`), wired through api-gateway's
  `/payments/stripe-webhook` and `/payments/ubit-deposit-callback` — a
  completely separate path from Missions/Order. Grepping `Games-Labs-Order`
  and `Games-Labs-Missions` for `stripe` returns nothing.
- **Store package payments are already fulfilled by a different, working
  path**: Wallet's signature-verified Stripe callback grants coin/diamonds
  directly and calls the internal-only `RecordPurchaseHistory` RPC back into
  Missions to record the purchase. This Order/Missions webhook was not part
  of that path.
- **The mobile team confirmed in writing** they neither call this endpoint
  nor want to — they use (or want to use) Wallet's Stripe checkout instead.
- **QA evidence settled the remaining doubt.** A BlueStacks run of the 29 ฿
  "First Timer" package showed no Stripe checkout, instant success, and
  +2,400 Coin — that's Wallet's `is_demo` shortcut, not this webhook. Opened
  separately as **TASK-EAR-254** (any authenticated player can trigger
  `is_demo` package grants with no payment and no guard — a related but
  distinct hole, out of scope here).

Conclusion: this endpoint has **no producer** — not a real PSP, not
Missions' own internal flow, not QA. It was reachable only by the exploit
itself.

## 2. Mechanism — containment shipped first, then superseded by removal

**First shipped (PR #105):** interim containment per task.md's explicit
fallback — reject any caller without a configured `X-Store-Webhook-Secret`
header, fail closed when `STORE_WEBHOOK_SECRET` is unset
(`crypto/subtle.ConstantTimeCompare`, `internal/handlers/mission/http/store.go`).
Regression test seen RED first (`TestPaymentCallbackRequiresWebhookSecret`,
`TestPaymentCallbackFailsClosedWhenSecretUnconfigured`), full suite GREEN
after. Merged to staging as `79a5118`, deployed successfully
(`gh run` `31693706418`, 2026-08-13T11:01:49Z).

**Superseded same day (PR #106):** once §1's answer was fully confirmed —
no producer exists and none is coming — containment was the wrong shape.
Standing up secret management (two new required GH Actions secrets on every
staging/prod deploy) for an endpoint scheduled for deletion is exactly the
kind of temporary machinery the task's own guidance warns against building
when removal is cleanly scoped. PR #106 removed:

- The REST route (`internal/routes/apiv1.go`).
- The gRPC bridge method — the embedded `UnimplementedMissionsServiceServer`
  now answers `codes.Unimplemented` for `StorePaymentWebhook` until the RPC
  itself is removed from shared-lib (see §4).
- `PaymentCallback`, `StoreService.ConfirmOrderPayment`, and the now-dead
  `internal/clients/order.Client.ConfirmPayment`.
- The containment machinery PR #105 had just added: `webhookSecret` field,
  `config.StoreWebhookSecret()`, `STORE_WEBHOOK_SECRET` in `ecs/env.names`
  and both workflows, and their tests.
- README's endpoint entry, replaced with a pointer to where payment actually
  happens.

Regression test seen RED first for the removal too:
`TestLegacyStorePaymentWebhookIsNotRegistered` (`internal/routes/apiv1_test.go`)
asserted the route must not match, which it did before the removal.
`TestStoreServiceConfirmOrderPaymentRecordsHistory` was deleted because the
method it covered no longer exists; its real assertion (a fulfilled package
purchase lands in purchase history) is now covered by the new
`TestRecordPurchaseHistoryRecordsWalletFulfilledPackage`, which the
surviving Wallet-callback path had **no** prior test for — net test count
went up, not down. Merged to staging as `0d36d74`
(`gh run` `31704470506`, 2026-08-13T13:21:06Z, success).

**PR #107** (docs-only, merged `ec84072`): PR #106 removed all the
containment code but left `STORE_WEBHOOK_SECRET=` as a stale, misleading
line in `.env.example`. Removed. The two GH Actions secrets created for the
containment approach (`STORE_WEBHOOK_SECRET`, `STORE_WEBHOOK_SECRET_STAGING`)
were deleted from the repo (`gh secret delete`) since nothing reads them
anymore.

## 3. A defect in #105's own PR description, caught before it mattered

The original #105 PR body claimed legitimate testers could keep working by
adding the shared-secret header. That was **wrong** for the path that was
actually exploited: `httpx.HeadersFromGRPC` (`internal/httpx/bridge.go:44-65`)
forwards only `Authorization`, `X-User-ID`/`userid`, and `role` from gRPC
metadata into the reconstructed HTTP request — a custom
`X-Store-Webhook-Secret` header can never cross the grpc-gateway bridge, so
any caller reaching the endpoint through the public gateway (the exact
exploited route) would have been rejected regardless of whether they knew
the secret. The claim was caught and corrected before it shipped as
documentation debt; it did not change the code's actual behavior (fail-closed
either way), only what the PR said about it. Worth keeping as a lesson: when
gating a handler that's also reached through this gRPC-to-HTTP bridge, check
`HeadersFromGRPC`'s allowlist before describing which callers a header check
will actually admit.

### Process note — a working-directory collision, corrected before deploy

Two sessions worked this task concurrently in the same non-worktree checkout.
Mid-way through proving the #105 regression test RED (a debugging comment
temporarily disabling the guard, `// TEMP-DISABLED-FOR-RED-PROOF: ...`), a
`git commit` from the other session captured that disabled state into
`2e5de59`, the commit originally pushed to
`feature/TASK-EAR-191-store-webhook-containment`. Caught by re-diffing
against `HEAD` before trusting the pushed branch; confirmed via
`git show 2e5de59:...store.go` that the guard was a no-op comment,
re-verified RED against that exact pushed state, restored the guard, and
pushed a follow-up commit (`8b91864`) with the real fix before the PR was
merged. **Verified the deployed commit is the corrected one**:
`git show 79a5118:...store.go` (the actual squash-merge commit that reached
staging) contains the working `if !h.authorizedWebhookCaller(r) { ... }`
guard, not the disabled comment — the vulnerable state was never deployed.
Flagged in a PR comment on #105 for the other session's awareness.

## 4. Gateway binding — not removed yet, tracked as follow-up

Task.md's third open question — whether to remove `StorePaymentWebhook`'s
`google.api.http` binding from `shared-lib/proto/missionspb` — is
**intentionally not resolved in this run**. That is a shared-lib + gateway
change requiring a version bump and consumer `go.mod` updates in both
Missions and api-gateway (the cross-repo release trap in
`knowledge-base/Knowledge Base/40 Lessons/Gateway Proto Bindings Need a Staging-Lane Bump — a Green main PR Ships Nothing.md`).
Removing the Missions-side implementation was sufficient to close the actual
hole today: the gateway still routes `POST /api/v1/webhooks/store-payment` to
the `StorePaymentWebhook` RPC, but that RPC now answers `Unimplemented`
(verified live, §6). Follow-up: delete the RPC and its HTTP annotation from
shared-lib, regenerate, publish, and bump the dependency in both consumers —
low urgency now that the handler itself refuses every caller, but worth
doing so the dead route stops appearing in the gateway's surface at all.

## 5. TASK-EAR-185's findings.md correction

Task.md asked this run to correct TASK-EAR-185's findings.md, which had
called Order's internal `ConfirmPaymentHTTP` mux "not an active exposure."
That correction is **already in place** — TASK-EAR-185/findings.md carries a
"⚠️ CORRECTION 2026-08-01" section (added during that run's own closure) that
retracts the claim and points here. Verified no other file in the workspace
still asserts the retracted claim (`grep -r "not an active exposure"` hits
only task.md/status.yaml's description of what needed fixing, and the
correction section itself).

## 6. Live verification on staging — fresh evidence, 2026-08-13

Independent of both PRs' own test-plan checklists, re-verified against the
deployed `staging` tip (`ec84072`) using a **freshly created guest account**
(`POST /api/v1/auth/guest`, `userId 2cd4c9bd-d67f-4bbe-9979-7a254b906ef5`) —
not the shared QA identity, so this evidence has no dependency on any
credential this run had to be handed.

**Exploit repro — refused, wallet untouched:**

1. Wallet before: `coin 1100, diamonds 0` (`GET /api/v1/wallet/{user_id}`).
2. `POST /api/v1/store/purchase` (Package I, 49 ฿, coin 3650 / diamonds 50)
   → `order_id db0b4b8b-ad70-4f21-b077-07b1edba2748`, `status pending`.
3. `POST /api/v1/webhooks/store-payment` with that order id and **only** the
   guest player's own bearer token (the exact TASK-EAR-191 exploit shape) →
   **`HTTP 501`**, body
   `{"code":12, "message":"method StorePaymentWebhook not implemented", "details":[]}`
   (gRPC `Unimplemented`).
4. Wallet after: `coin 1100, diamonds 0`, `updatedAt` byte-for-byte unchanged
   from step 1 — the row was never touched.
5. Order after: `status ORDER_STATUS_PENDING` — never transitioned.

This is the same shape of proof TASK-EAR-185 used (state before/after, not a
single 200), against a brand-new account rather than reusing the exploited
2026-07-31 evidence.

**Legitimate flow:** §1 established that no legitimate caller ever used this
webhook — the real fulfillment path is Wallet's Stripe callback (untouched
by this change; still gated by real signature verification, unaffected by
anything in Missions) and, separately, the `is_demo` shortcut QA currently
relies on (tracked as its own hole, TASK-EAR-254, not touched here). The
half of the flow that Missions does own —
`POST /api/v1/store/purchase` creating a pending order — is verified working
above (step 2). There is no regression to "a legitimate purchase flow" to
prove here beyond that, because nothing legitimate ever completed a purchase
through this endpoint; that is the whole finding.

**Repo checks:** `go build ./...`, `go vet ./...`, `go test ./...` clean on
`staging` @ `ec84072` (all packages `ok` or `no test files`, none failing).

## 7. Follow-ups opened, not fixed here

1. **Shared-lib proto binding removal** (§4) — delete `StorePaymentWebhook`'s
   `google.api.http` annotation, regenerate, publish, bump Missions +
   api-gateway. Not urgent (handler already refuses everyone) but leaves a
   dead route in the gateway surface until done.
2. **TASK-EAR-254** — Wallet's `is_demo` flag grants package rewards with no
   payment and no guard, reachable by any authenticated player. This is what
   QA currently relies on for the package-purchase flow; needs a staff-gated
   replacement before it's closed. Opened as its own run.
3. **Order's `ConfirmPaymentHTTP`** (`orderhdl/http.go:278`) now has no
   caller at all — Missions' client-side `ConfirmPayment` was deleted in
   #106. Worth a look for whether the handler itself should be removed too;
   out of scope here since Order was not touched by this run.
