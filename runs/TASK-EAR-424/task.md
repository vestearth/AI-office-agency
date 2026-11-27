# TASK-EAR-424: Order ConfirmPayment: require proof of payment before package fulfilment

Opened 2026-11-13 by the Claude conductor, from the knowledge-base Review Queue
item "Games Labs Order: a player may be able to confirm their own unpaid
packaged order" (code-vs-KB review, knowledge-base `523db3c`, 2026-11-12).

**Publication hold:** this repository is public. Do not commit or push this run
folder until the fix is on staging and the prod release branch carries it.
Request-level reproduction detail stays in `security-findings.local.md`
(gitignored by `runs/*/*`) and in the private knowledge base; this file cites it
as S-A/S-B/S-C. No user IDs, tokens or secrets belong here.

**No prod contact.** Games Labs prod (`sparqlab-production-ecs`) is parked at
desired 0 and cost-gated. Every runtime check below is read-only AWS metadata or
staging logs. No request has been sent to any staging or prod service yet.

Office default for new TASK-EAR runs is open-and-stop: implementation and the
staging reproduction wait for Earth's approval (see "Decisions for Earth").

## Prior work this builds on

- TASK-EAR-185 added the owner check on the public confirm route.
- TASK-EAR-257 audited money paths and rated that route OK
  (`runs/TASK-EAR-257/findings.md:110`).
- TASK-EAR-267 removed the unauthenticated payment callback and left the note
  "do not reintroduce a confirm-by-request endpoint here".
- None of them considered the owner confirming their own **unpaid** order.

## Verdict (source, 2026-11-13): CONFIRMED in code on staging, prod and the prod train

Refs: Order `origin/staging` `c244578`, `origin/prod` `aedf982`,
`origin/release/TASK-EAR-402-prod` `059d148`; Wallet `origin/prod` `14de7d1`
and `origin/staging` `b6eb662`; Missions `origin/staging` (image `4139416`) and
`origin/prod`; api-gateway `origin/staging` `f0f5baa`, `origin/prod` `9900c87`.

F1. **Settlement without proof of payment.** The public confirm route reaches
`orderhdl/grpc.go:351-397`, which checks only that the caller owns the order,
then `ordersvc/service.go:612-654` moves `pending` → `payment_confirmed` using
the caller's `payment_reference` and calls `fulfillOrder` (`:656-748`), which
credits the package through Wallet `reward-package`. Neither Order nor Wallet
checks for a settled payment on this path. The `pending` branch is identical on
all three Order refs.

F2. **The route is public.** api-gateway registers the Order grpc-gateway
handlers (`gateway/grpc.go:144`) and forwards every `/api/v1/*` path after
player auth (`gateway/http.go:119`); `RequireAdminAPIAccess` acts only under
`/api/v1/admin` and `/admin` (`middleware/auth.go:184-194`). Same on the
staging and prod gateway branches and all pinned shared-lib versions.

F3. **A player can obtain a confirmable pending order three ways** (detail in
the local file):
- S-B: the Missions store purchase route creates a pending package order through
  Order `from-package` and returns its id. No Stripe and no coupon are needed,
  and a fresh idempotency key gives a fresh order. Staging runs this
  (`USE_ORDERS_CATALOG=true`, td `games-labs-missions-staging:161`).
- S-A: a Wallet Stripe checkout for a package creates a pending order and
  returns its id before anything is paid (the original lead).
- S-C: the public CreateOrder with a coupon code builds a pending package order
  (`service.go:84-96`); it needs a coupon the package accepts.
- Edge: an exchange order left `pending` with `coupon_reward_failed` after
  Wallet already moved currency would be credited a second time.

F4. **Guards looked for, none found:** no status gate on the public handler, no
payment or provider check in Order or Wallet, no gateway deny-list. The S2S
settle path (`PrepareCheckoutOrder` / `ConfirmCheckoutOrder` /
`FailCheckoutOrder`) has no gateway annotation, so that part is not public.

F5. **No known legitimate caller of the public confirm route.** The Android
client (HEAD 2026-10-18) uses the Wallet transaction and status routes, not
confirm-payment and not the store purchase route. Missions no longer calls
Order's confirm route on staging or prod. The backoffice and gamelabsFrontend
have no reference. Only Postman collections in api-gateway `docs/` use it.

F6. **Runtime (read-only):** staging ECS runs exactly the staging refs above
(Order `staging-sha-c244578`, Wallet `staging-sha-b6eb662`, Missions
`staging-sha-4139416`, gateway `staging-sha-f0f5baa`). CloudWatch Logs Insights
is denied for the `vestearth` user, so a paginated `filter-log-events` scan was
used. Staging gateway scan: see "Log scan".

## Log scan

- 2026-11-13, first pass: a 60-day paginated `filter-log-events` scan of
  `/ecs/api-gateway-staging` for the confirm and store-purchase paths hit its
  200-page cap with zero matches on both patterns. **That is inconclusive, not
  "no calls"**: the scan stopped before covering the window. A positive control
  (`{ $.path = "/api/v1/*" }`) matched, so the filter syntax works.
- Second pass: a per-day inventory of every `/api/v1/*` path from
  2026-10-29T19:29Z to 2026-11-12T19:29Z. All 14 daily windows were read to the
  last page (10–12 pages each). Result: **0** `confirm-payment` requests and
  **0** `store/purchase` requests through the staging gateway. The checkout
  traffic that did arrive is the Android Stripe flow: 12 `POST /api/v1/transaction`,
  74 transaction-status polls, 5 cancels, 7 order reads. So in that window
  nobody used either route, legitimately or otherwise. This says nothing about
  older staging traffic or about prod. Evidence: `evidence/ev-002` (local).

## Proposed fix (Order only; no contract change, no migration)

Recommended (option A): the player-facing entry points must never move a
`pending` order to `payment_confirmed`. Only Wallet's S2S
`ConfirmCheckoutOrder`, which runs after Wallet verifies the Stripe webhook
signature, may do that.

- `orderhdl/grpc.go` `ConfirmPayment` (public): after the owner check, refuse
  when the stored order is `pending` with the existing
  `OrderNotEligibleForPayment` status, before the service is called. Orders
  already settled by the S2S path keep today's replay and retry behaviour
  (`fulfilled`, `fulfilling`, `payment_confirmed` + failed fulfilment), which
  never needs a new payment.
- `orderhdl/http.go` `ConfirmPaymentHTTP` (internal mux, no known caller):
  same refusal, so an in-VPC caller cannot do what a player cannot.
- `ConfirmCheckoutOrder` and the service are unchanged, so the Stripe flow
  and Wallet's reconciliation keep working.
- Regression tests, each seen failing on `c244578` first:
  - handler: the owner of a `pending` order is refused and the service's
    `ConfirmPayment` is never called;
  - internal HTTP: same for `ConfirmPaymentHTTP`;
  - service: `ConfirmCheckoutOrder` on a `pending` order still settles and
    rewards (guards against over-fixing).
  Existing tests stay as they are. `TestConfirmPayment_AllowsOwner` uses an
  order with no status, so it still passes; its comment will say that the
  owner may re-drive an already-settled order, not settle an unpaid one.

Rejected:
- B. Refuse the public route outright, as TASK-EAR-423 did for turnover. It is
  simpler, but it also removes the harmless owner retry, and it leaves the
  service-level hole for any future entry point. It can follow later if
  Earth wants the route gone.
- C. Make Order look up a settled Wallet payment for the order. Wallet's
  verified webhook is already the authority, so this adds a cross-service call
  for nothing.

Follow-ups, out of scope here: retire or redirect the order creators that
nobody can now settle (Missions store purchase, public CreateOrder with a
coupon), and check whether their pending orders hold coupon reservations
against quota.

## Staging reproduction plan (needs Earth's approval; staging only)

Target: `api-test-gateway.gameslabs.app` (staging ECS
`sparqlab-development-ecs`). A dedicated staging test player account, provided
or approved by Earth. One order only, then stop.

1. Read-only: list active packages and record the test player's wallet balance.
2. Create one pending order through S-B (fresh idempotency key tagged
   `ear424-repro`). Record the order id; read it back and expect `pending`.
3. Negative control: confirm the same order with a *second* test player and
   expect a refusal (TASK-EAR-185 still holds).
4. Confirm it as the owner with a made-up payment reference.
   Defect reproduced if the order becomes fulfilled and the balance rises by
   the package reward, with a Wallet ledger row whose reference is the order id.
5. Evidence: request and response bodies with tokens redacted, Order and
   Wallet staging log lines for the order id, and balances before and after.
6. Cleanup (Earth's choice): leave the staging credit, or reverse it through
   the backoffice wallet adjustment.

Optional S-A check (Stripe test mode): create a package checkout, do not pay,
confirm as the owner, then cancel the checkout and confirm the order is not
reverted. Any Stripe test-card payment is Earth's to run.

After the fix reaches staging: repeat steps 2–4 and expect step 4 refused with
the balance unchanged. Earth then runs one Stripe test-mode purchase to show the
verified-webhook path still fulfils.

## Prod train (TASK-EAR-402)

- Prod source `aedf982` and the train head `059d148` carry the defect
  unchanged, and Wallet prod creates pending checkout orders (S-A), so prod is
  exposed the moment it boots, whatever the Missions catalog setting.
- Prod is parked at desired 0 (last boot 2026-09-30). Nothing is live now.
- The fix must be on `release/TASK-EAR-402-prod` before any prod boot: by
  cherry-pick, or by re-cutting the release branches from `staging` (which the
  2026-11-12 Review Queue item already recommends for the missing Missions and
  Wallet fixes). After it merges to staging, add TASK-EAR-424 to TASK-EAR-402
  `carries` (`scripts/update-train-carries.rb`). That edits another run, so it
  needs Earth's yes.

## Decisions for Earth

1. Approve the staging reproduction (S-B, one order) and name the test player
   account(s) to use.
2. Approve fix option A (Order handlers refuse `pending`; S2S path unchanged).
3. Prod train: cherry-pick into `release/TASK-EAR-402-prod`, or re-cut it
   from `staging`.
