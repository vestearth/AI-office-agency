# TASK-VS-039: slip-system deploys cut in-flight verify calls: drain before GracefulStop (502 upstream connect error)

- Type: reliability / bugfix (slip-system; ECS task definition)
- Created: 2026-10-17 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: preset `production`.
- Found by the dashboard's Production signals (deploy windows, ai-dev-office 962e8d4b).
- Related: TASK-VS-028 (one KBank call per request; Service Connect retry), TASK-VS-026
  (reliability baseline; the signal first read as "recurs after VS-026").

## Incident (read-only investigation, 2026-10-16)

Every slip-system rolling deploy on 2026-10-16 produced customer-facing 502s on
`POST /v1/slips/verify` in slip-api:

| slip-system deploy (ICT) | ECS events | slip-api 502s |
|---|---|---|
| 14:57:53 – 15:01:24 | old tasks stopped 14:58:52, 14:59:02, 14:59:22; deployment completed 15:01:24 | `upstream connect error or disconnect/reset before headers. reset reason: remote connection failure` at 14:59 |
| 21:17 – 21:21 | (second deploy the same evening) | the same upstream-connect error, and one `no healthy upstream` |

Total in the 24 h window: 6 upstream-connect + 1 no-healthy-upstream, all inside the two
deploy windows (dashboard Production signals: "all during 2 deploys"). slip-api's own
deploy (14:38 – 14:47, behind the ALB) shows none.

## Cause (from source and ECS config)

- slip-system is reached only through ECS Service Connect (port name `grpc`, no load
  balancer); slip-api's Envoy sidecar picks the endpoint.
- On SIGTERM, slip-system (`cmd/main.go`, origin/prod 3fd91f0, ~lines 157-183) sets gRPC
  health to NOT_SERVING and **immediately** calls `GracefulStop()`, which stops accepting new
  connections at once (10 s timeout, then `Stop()`). Envoy keeps routing new requests to the
  stopping task until Service Connect removes the endpoint, so those requests fail before
  headers: `upstream connect error … remote connection failure`, or `no healthy upstream`
  when every endpoint it knows is gone.
- Task definition `slip-system-production:24`: no `stopTimeout` (ECS default 30 s); the
  container health check is TCP only (`nc -z 127.0.0.1 50050`), so it never sees
  NOT_SERVING. Deployment config: rolling, minimumHealthyPercent 100, maximumPercent 200.

## Scope

1. **Drain before stopping** in slip-system: on SIGTERM, mark health NOT_SERVING, keep
   serving new and in-flight RPCs for a configurable drain delay (default long enough for
   Service Connect to drop the endpoint — measure it; start around 15-20 s), then
   `GracefulStop()` with its existing timeout.
2. **Make ECS wait for it**: set `stopTimeout` on the slip-system container so it exceeds
   drain delay + graceful timeout (task definition in the slip-system deploy config).
3. **Check the siblings** (defect-class): slip-api (behind the ALB: deregistration delay vs
   its own shutdown) and any other Service Connect callee in `upslip-production-ecs`
   (slip-admin, slip-front-end, slip-landing) for the same immediate-stop pattern.
4. Do **not** add client retries for these errors in slip-api (TASK-VS-028 keeps one KBank
   call per request); a request rejected before it reached slip-system is the only case a
   transparent retry could be safe, and that needs its own decision in review.

## Acceptance

- A regression test for the shutdown order (health NOT_SERVING → drain delay → GracefulStop),
  seen failing first.
- Staging evidence: a slip-system deploy under steady synthetic verify traffic produces zero
  502 `upstream connect error` / `no healthy upstream` lines in slip-api (count from
  CloudWatch over the deploy window, every page read).
- Production evidence after release: the next slip-system deploy shows zero such 502s
  (the dashboard's Production signals show no group "during a deploy").
- Public status mapping, credit policy (502 stays free) and idempotency unchanged.

## Evidence handling

Counts, timestamps and request ids only; no raw log lines with slip or person data in this
run (see TASK-VS-029).
