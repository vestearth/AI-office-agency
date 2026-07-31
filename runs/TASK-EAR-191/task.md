# TASK-EAR-191 — Store payment webhook is unauthenticated: any player can credit their own wallet

## Type

bugfix

## Workstream

backend

## Priority

critical

## Created

2026-08-01

## Epic

Order/payment authorization hardening. Found during TASK-EAR-185's live staging
verification — **by the exploit being executed, not by code review.**

## The defect

`POST /api/v1/webhooks/store-payment`
(`Games-Labs-Missions/internal/handlers/mission/http/store.go:387-413`,
route `internal/routes/apiv1.go:71`) performs **no authentication of the
caller whatsoever**: no PSP signature check, no shared secret, no service
credential, no ownership check. It decodes `{order_id, payment_reference,
status}` from the body and, if `status` is empty or `"success"`, calls
`ConfirmOrderPayment` directly.

It **has a grpc-gateway binding** (`shared-lib/proto/missionspb/missions.pb.gw.go:2622`,
`StorePaymentWebhook`), so it is reachable from the internet. api-gateway
requires only a valid token on `/api/*` — `RequireAdminAPIAccess()` guards only
the `/api/v1/admin` prefix — so **any authenticated player token is accepted**.

**Result: a player can credit their own wallet without paying.**

## Proven by execution on staging, 2026-07-31

The operator ran the whole flow with an ordinary player JWT:

1. `POST /api/v1/store/purchase` → pending order created
2. `POST /api/v1/webhooks/store-payment` with that order id → order reached
   `ORDER_STATUS_FULFILLED`
3. Wallet moved by exactly the package amount: Coin `224800 → 228550` (+3750),
   Diamonds `4865 → 4915` (+50)

No payment provider was involved at any point. This is not a theoretical
finding.

## Why TASK-EAR-185 does not cover it

TASK-EAR-185 scoped Order's **gRPC** `ConfirmPayment` to the order's owner, on
the reasoning that external traffic reaches the gRPC handler while
`ConfirmPaymentHTTP` on Order's own mux is internal-only and therefore did not
need the check.

**That reasoning was incomplete, and this is the counter-example.** The
internal mux is reachable indirectly:

```
player JWT -> api-gateway -> Missions /api/v1/webhooks/store-payment  (no auth at all)
           -> Missions ConfirmOrderPayment
           -> Order ConfirmPaymentHTTP        (the "internal-only" handler)
           -> fulfillOrder -> wallet credit
```

TASK-EAR-185's fix is still correct and still worth having — it closes the
direct path — but it is **not sufficient**, and its findings.md records the
unauthenticated internal mux as "not an active exposure", which this disproves.
Correct that note as part of this task.

## What has to be decided before implementing

This is a payment-integrity question, not only an authorization one:

1. **Who is legitimately allowed to call this webhook?** A real PSP, or
   Missions' own internal flow, or both? Establish the real payment provider
   integration (if any) before choosing a mechanism — a signature scheme
   invented without knowing the provider is guesswork.
2. **Mechanism:** PSP signature/HMAC verification is the correct answer for a
   genuine provider callback. If the current staging flow has no PSP at all and
   the webhook exists only to simulate one, then the endpoint should not carry
   a public gateway binding in the first place.
3. **Is the gateway binding needed at all?** Removing
   `StorePaymentWebhook`'s `google.api.http` binding would take it off the
   internet immediately. That is a shared-lib + gateway change and would break
   any real PSP that posts to the public URL — hence question 1 first.

Write the decision down before coding, as TASK-EAR-185 did.

## Interim containment to consider

Because this is exploitable today on staging and would ship to prod with the
consolidated patch, consider a containment step ahead of the full design:
reject the callback unless it carries a configured shared secret header, with
the secret set for Missions' internal caller. Cruder than PSP signatures, but
it closes self-crediting in one change. Confirm with the operator whether to
ship containment first or wait for the full design.

## Scope

- Included: authenticating `/api/v1/webhooks/store-payment`; correcting
  TASK-EAR-185's findings.md note about the internal mux; deciding the fate of
  the public gateway binding.
- Excluded: TASK-EAR-182's three remaining endpoints; the broader
  service-to-service credential platform decision (this task may inform it).

## Acceptance Criteria

- A player JWT can no longer confirm a store payment — verified live on
  staging by repeating the exact exploit above and seeing it refused, with the
  wallet unchanged.
- The legitimate purchase flow still completes end to end on staging.
- The decision on caller identity and the gateway binding is written down.
- Regression test seen RED before the fix.
- TASK-EAR-185's findings.md corrected so the "internal-only, not an active
  exposure" claim does not mislead the next reader.
