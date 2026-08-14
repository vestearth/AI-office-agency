# TASK-EAR-257 — Cross-service money-path authorization audit

**Priority:** high · **Lane:** reviewer (audit-only, no fixes)
**Deliverable:** `runs/TASK-EAR-257/findings.md`

## Why this run exists

The same defect class has now been found in **three** services, and **every
instance was found by accident** while doing unrelated work:

| Task | Service | How it was found |
|---|---|---|
| EAR-180/182 | Order | A sweep of one handler file |
| EAR-191 | Missions | An operator verifying that a *different* fix hadn't broken purchases |
| EAR-254 | Wallet | Tracing which endpoints to hand the mobile team |

The sweep that produced EAR-180/182/185 read the neighbours of the Missions
webhook and missed it, because it was scoped to Order's handler file. Money
paths cross service boundaries; a per-repo sweep will keep missing them.

## The class — one question to ask everywhere

**Does this money path trust a client-controlled field?**

Three shapes seen so far:

- **(a) Identity from the request** — body or path instead of gateway-set
  metadata. EAR-180/182 (Order `CreateOrder`, `ValidateCoupon`, `GetOrder`);
  EAR-254 (Wallet `resolveUserID` preferring body `user_id`).
- **(b) Unauthenticated "this was paid" assertion** — no PSP signature, no
  caller check. EAR-191 (Missions `store-payment` webhook: any player JWT
  could confirm an order and credit a wallet).
- **(c) A client-settable flag that skips payment and still pays out.**
  EAR-254 (Wallet `is_demo`: +2,400 Coin for 0.00 THB).

## Scope

Every path that can move value, across **Games-Labs-Wallet**,
**Games-Labs-Order**, **Games-Labs-Missions**, **Games-Labs-Game** and
**Games-Labs-Provider**:

- wallet credit / debit / redeem / refund / transfer
- order creation and status transitions
- payment, deposit, callback and webhook endpoints
- package and coupon fulfillment
- reward and bonus grants
- VIP and point mutations
- provider balance callbacks

Include **admin surfaces**, not only player-facing ones.

## What to record per endpoint

| Column | Note |
|---|---|
| Transport | gRPC / HTTP mux / both |
| Gateway-reachable? | Check the generated `*.pb.gw.go` or the gin routes — **not** just the service mux. A mux-only path is a different risk profile, not automatically safe |
| Identity source | Gateway metadata / body / path / header / none |
| Authorization | Owner check, staff check, none |
| Client-controlled fields influencing payout | The heart of the audit |
| Verdict | With severity |

Rank findings by who can exploit them **today**: an ordinary player, staff
only, or only from inside the cluster.

## Method

**Read the source. Do not trust prior notes — in either direction.**

- EAR-182 found one of its four listed holes had *already been fixed* by
  unrelated work after the findings were written.
- EAR-179 found a header comment claiming fields were unbacked when two of
  them had been wired months earlier.
- EAR-191's own task notes contained a claim about tester behaviour that
  turned out to be wrong.

Assume any existing finding may be stale in either direction, and re-verify.

**Confirm exploitability by execution before reporting anything as
critical.** EAR-191's provenance note is explicit that executing the flow
found what reading the neighbours missed; EAR-254 was source-traced first
and only then reproduced (+2,400 Coin / 0.00 THB), and the reproduction is
what tied the trace to what QA had actually been seeing on BlueStacks.

## Explicitly out of scope

**This run fixes nothing.** Each real finding becomes its own task with its
own regression test seen RED first.

The three known instances each needed a distinct decision — remove the
endpoint entirely (EAR-191), staff-gate the capability rather than delete it
because QA depended on it (EAR-254), staff-vs-owner on status transitions
(EAR-182). Folding a sweep's findings into one change would bury exactly the
decisions that need attention, and produce an unreviewable PR.

## Known context worth carrying in

- The gateway strips client-supplied `userid`/`role`/`permissions` and
  re-injects them from the verified token
  (`api-gateway/middleware/identity_headers.go:12-45`), then
  `MapMetadataInterceptor` (`interceptor/metadata.go:16-48`) maps them into
  gRPC metadata. **That is the only trustworthy identity source** on the
  gRPC path.
- `RequireAdminAPIAccess` is mounted on the whole `/api` group but only
  gates paths under `/api/v1/admin` or `/admin`
  (`middleware/auth.go:189-193`) — it is a no-op everywhere else, so its
  presence in the middleware chain proves nothing about a given route.
- Wallet's HTTP mux is not gateway-routed, so its `role` header is whatever
  the caller sends. This is true of every existing admin HTTP route in that
  repo and its security currently rests on network isolation — worth a
  finding of its own if the audit agrees it should change.
- `USE_ORDERS_CATALOG=true` on staging and prod: every store money path is
  supposed to delegate to Orders, and a direct-wallet path is a no-ship.
