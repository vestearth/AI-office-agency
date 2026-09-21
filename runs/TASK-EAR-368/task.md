# TASK-EAR-368 — Enforce the Wallet internal-token on PRODUCTION

## Type

devops / security hardening

## Priority

high — prod is the environment that still has the gap TASK-EAR-266 closed on staging.

## Context

TASK-EAR-266 authenticated Wallet's bare `http.ServeMux` with a static shared
bearer in `X-Internal-Token` and shipped it in two phases: Phase A logs a
missing/bad token and still serves, Phase B returns 401. **Phase B is live and
proven on staging since 2026-09-21** (`games-labs-wallet-staging:78`).

**Production has neither phase.** `Games-Labs-Wallet/.github/workflows/prod.yml`
exports *neither* `WALLET_INTERNAL_TOKEN` nor `WALLET_INTERNAL_TOKEN_ENFORCE`.
Both are listed in `ecs/env.names`, so they render as `""`, and an empty
configured token never matches — which in Phase A means every request is logged
and served. The eight money routes plus the admin rate-catalog routes are
therefore still protected by VPC isolation alone, which is exactly the residual
TASK-EAR-254 accepted and TASK-EAR-266 was opened to remove.

Note: the token value itself did reach some prod task definitions through
`release/TASK-EAR-363-prod` ("ci(prod): pass WALLET_INTERNAL_TOKEN into the prod
task definition"). Verify per service rather than assuming — the enforce flag
certainly never shipped.

## Scope

### In scope
- `Games-Labs-Wallet` — prod workflow env wiring, then the enforce flip.
- `Games-Labs-Order`, `Games-Labs-Provider`, `Games-Labs-Missions`,
  `Games-Labs-User` — confirm each prod task definition carries the SAME token.
- The GitHub `production` environment secret on all five repos.

### Out of scope
- Any Go code change. The middleware and all caller wiring are already merged
  and unchanged; this is deployment configuration only.
- Staging (done, TASK-EAR-266).
- gRPC guards (TASK-EAR-262) and the RefundDiamond staff gate (EAR-329).

## Ordered plan

1. **Set the secret.** `WALLET_INTERNAL_TOKEN` on the production environment of
   all five repos. Use a NEW value — do not reuse staging's, so a staging leak
   cannot authenticate against prod.
2. **Export it from prod.yml on all five repos**, Wallet included, alongside
   `WALLET_INTERNAL_TOKEN_ENFORCE="false"`. Both must be exported as strings;
   an unset name in `ecs/env.names` renders `""` and a non-string parse crashes
   boot (the `ecs/env.names` lesson).
3. **Deploy the four callers first**, then Wallet. A caller that sends the
   header while Wallet is still on Phase A is harmless; the reverse is not.
4. **Verify the token matches before flipping.** Compare
   `WALLET_INTERNAL_TOKEN` by hash across the *running* revisions of
   `games-labs-wallet-prod`, `-order-prod`, `-provider-prod`,
   `-missions-prod`, `-user-prod`. This, not a log census, is the real gate —
   see the trap below.
5. **Flip** `WALLET_INTERNAL_TOKEN_ENFORCE="true"` in Wallet's prod.yml and
   redeploy **Wallet only**.
6. **Prove it** (see Acceptance).

## Traps

- **A "24h of zero violation logs" gate is vacuous here.** The middleware logs
  only on violation and Wallet emits no per-request HTTP logging, so a
  successful mux call is invisible and "zero errors", "zero traffic" and
  "broken logger" are indistinguishable. On staging this was settled by the
  config/call-path audit in step 4 plus the probes in Acceptance. Do the same.
- **Prod ECS is scaled to 0 nightly and at weekends**, up 09:00–20:00 Mon–Fri.
  Deploy inside that window; a 503 outside it is the schedule, not an outage.
- **Provider's wiring is the fragile one.** Order, Missions and User attach the
  header via an `http.RoundTripper`, so no route can omit it. Provider calls
  `utils.DoWallet` at each of 12 sites — re-grep for a `DefaultClient` /
  `http.Post` / `.Do(req)` bypass in its wallet-touching files before flipping.
- **Do not add a token to the gateway.** api-gateway proxies only
  `/payments/ubit-deposit-callback` and `/payments/stripe-webhook`, both already
  exempt in the middleware along with `/health`.
- **Game is not a caller.** It reaches Wallet over gRPC
  (`internal/adapters/walletadt/adapter.go`), outside this mux.

## Acceptance criteria

- [ ] `WALLET_INTERNAL_TOKEN` present, non-empty and **identical by hash** on
      the running prod revisions of all five services; value differs from staging's
- [ ] Wallet prod running with `WALLET_INTERNAL_TOKEN_ENFORCE="true"`
- [ ] From inside the prod VPC (ECS Exec; `session-manager-plugin` is installed
      on the operator Mac as of 2026-09-21; containers are alpine so use busybox
      `wget`, not `curl`):
      - `/wallets/balance` without the header → **401**
      - `/wallets/balance` with the header → **200** with a real row
      - `/health` without the header → **200**
      - `/payments/stripe-webhook` without the header → **not 401**
      - `/wallets/credit` without the header → **401**
      - `/wallets/credit` with the header and `{}` → **400, not 401** (proves
        authorization without moving any balance — do NOT perform a real credit)
- [ ] CloudWatch `/ecs/games-labs-wallet-prod` shows one
      `reason=missing enforce=true` line per no-header probe and none for the
      exempt paths — which also proves the logger works
- [ ] A real player flow (a Store purchase or a Missions payout) observed green
      after the flip
- [ ] No token value in any tracked file

## Rollback

Set `WALLET_INTERNAL_TOKEN_ENFORCE` back to `"false"` in Wallet's prod.yml and
redeploy Wallet only. Callers need no redeploy — an unused header is harmless.

## References

- `ai-dev-office/runs/TASK-EAR-266` — the staging run, its probe transcript and
  the reasoning behind the substituted gate
- `SparqLab/Games-Labs-Wallet#57` — the staging Phase B flip
- TASK-EAR-254 (accepted the residual), TASK-EAR-257 FINDING-6 (found it),
  TASK-EAR-265 (confirmed the mux is not reachable from outside the VPC)
