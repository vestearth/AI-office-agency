# TASK-EAR-185 — service-to-service identity decision (prerequisite)

Answered before writing any fix, as the run's hard prerequisite required.
Evidence with file:line; nothing here is inferred.

## The question

`confirm-payment` credits the wallet and has no caller check. Missions calls it
service-to-service, so "require caller == owner" might break real purchases.
What identity does the Missions call actually carry?

## Answer: it carries none — and it does not need to, because it is a different transport

**Missions sends no identity at all.**
`Games-Labs-Missions/internal/clients/order/client.go:355-390` builds a plain
`POST` to `fmt.Sprintf("%s/api/v1/orders/%s/confirm-payment", c.baseURL, orderID)`
with a body of `{"payment_reference": ...}` and exactly one header:
`Content-Type: application/json`. No `X-User-ID`, no `userid`, no bearer token.

**Crucially, that call does not reach the vulnerable handler.** There are two
independent paths to confirm-payment:

| Path | Entry | Handler | Reachable by |
| --- | --- | --- | --- |
| Player | api-gateway → grpc-gateway mux → gRPC | `orderhdl/grpc.go:227` `ConfirmPayment` | **any authenticated player** |
| Missions | direct HTTP to Order's own mux on the internal network | `orderhdl/http.go:278` `ConfirmPaymentHTTP` | internal network only |

The gateway terminates at the **grpc-gateway mux**, not at Order's raw HTTP
listener: `api-gateway/gateway/http.go:103` is
`api.Any("/*filepath", gin.WrapH(mux))`, where `mux` is the grpc-gateway mux.
So an external `POST /api/v1/orders/{id}/confirm-payment` is translated into
the **gRPC** `ConfirmPayment` (proto binding at
`shared-lib/proto/orderpb/order.proto:65-69`). Order's own
`mux.HandleFunc("/api/v1/orders/", oh.ConfirmPaymentHTTP)`
(`Games-Labs-Order/cmd/main.go:103`) listens on Order's service port, which the
gateway never proxies to.

## Decision

**Enforce owner-scope on the gRPC handler only. Leave `ConfirmPaymentHTTP`
functionally unchanged.**

This is not a weakening to accommodate one caller — the two handlers *are* the
trust boundary. The gRPC handler is the untrusted, internet-facing transport;
the HTTP mux is the internal service-to-service transport that the gateway
cannot route to. Putting the check where the untrusted callers arrive is the
precise fix, and it leaves the Missions purchase flow untouched by
construction rather than by exception.

The rejected alternative was threading a `CallerUserID` into
`models.ConfirmPaymentRequest` and enforcing it in the service only when
non-empty. That is a footgun: any future caller that forgets to populate it
silently gets no authorization check, and the run's own brief warns against
weakening the rule for everyone.

Mechanism in the gRPC handler:

1. `callerUUID(ctx)` — the gateway-set `userid` metadata (TASK-EAR-180's
   helper), fail-closed with `MetaDataNotFound`.
2. `h.os.GetOrder(ctx, id)` — the order carries `UserID`
   (`internal/models/order.go:42`).
3. Compare; on mismatch return `Forbidden` **without** calling
   `ConfirmPayment`, so no state transition and no wallet credit occur.
4. Order-not-found is returned as not-found before the ownership test, matching
   `GetOrder`'s existing shape.

The extra read is deliberate: correctness on a money path beats saving one
query, and it keeps the service layer — and therefore Missions' path —
untouched.

## Recorded, deliberately not fixed here

**`ConfirmPaymentHTTP` remains unauthenticated on Order's internal mux.** It is
not reachable through the gateway today, so it is not an active exposure, and
authenticating it would break Missions with no security gain at present. But it
is a defence-in-depth gap: anything that later exposes Order's HTTP port, or
any workload inside the network, can confirm payment on any order. The durable
fix is a service-to-service credential shared by Missions and Order, which is a
platform-wide decision (the same shape would apply to `PaymentCallback`, flagged
under TASK-EAR-180 for the same reason) and is out of scope for a critical
single-endpoint patch. Worth its own task.
