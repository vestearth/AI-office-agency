# TASK-EAR-266: Authenticate Wallet's internal HTTP mux

## Type
security hardening (internal-only today; one SG/ALB/pod mistake from Tier A)

## Priority
high

## Scope
### Target Services
- `Games-Labs-Wallet` — token middleware on the mux, env wiring
- `Games-Labs-Order`, `Games-Labs-Provider`, `Games-Labs-Missions`, `Games-Labs-User` — send `X-Internal-Token` on every Wallet HTTP call
- `api-gateway` — no change expected; it only proxies `/payments/ubit-deposit-callback`, which stays exempt

### Explicitly Out Of Scope
- walletpb gRPC guards (TASK-EAR-262, done) and RefundDiamond staff gate (EAR-329)
- mTLS / service mesh
- Production rollout (next patch train, same two-phase order)
- The Android client repo

## Problem (verified 2026-09-09 on origin/staging)
`cmd/main.go` L114-140 serves every money route on a bare `http.ServeMux` with
no authorization. Security rests on VPC isolation alone (TASK-EAR-265 confirmed
the port is not reachable from outside). The surface has grown since intake:
credit-points (EAR-271), settled-deposits (EAR-270), lifetime-topup (EAR-318),
refund-diamond (EAR-329). `paymentsvc/callback.go` (OneDay) settles a deposit
and package rewards from an unsigned payload; Ubit and Stripe both verify.

No service-to-service secret pattern exists in any repo yet; this task creates it.

## Callers of the mux
| Service | Env var | Client |
|---|---|---|
| Order | `WALLET_API_URL` | 16 call sites |
| Provider | `WALLET_API_URL` | 14 call sites |
| Missions | `WALLET_BASE_URL` | 5 call sites |
| User | `WALLET_HTTP_ADDR` | `internal/adapters/walletadt/adapter.go` |

## Default decisions (override before starting, otherwise locked)
- **D1** Static shared bearer in `X-Internal-Token`, constant-time compare, env `WALLET_INTERNAL_TOKEN` on Wallet and all four callers.
- **D2** Two-phase: `WALLET_INTERNAL_TOKEN_ENFORCE="false"` logs only; flip to `"true"` after all callers deploy and 24h of zero unauthenticated hits. Both vars are strings in `ecs/env.names` and the staging workflow env (unset → `""` → boot crash; `default:` tag does not fire on set-but-empty).
- **D3** Exempt: `/health`, `/payments/stripe-webhook`, `/payments/ubit-deposit-callback`. The OneDay `/payments/deposit-callback` is NOT exempt; it requires the token like every other route.
- **D4** OneDay (FINDING-5) = **won't do** (operator, 2026-09-09; provider not pursued). No signature work. Dropping the route registration is optional.
- **D5** gRPC guards untouched.

## Acceptance criteria
- [ ] Mux test RED first: `/wallets/credit` without header → 401 when enforce, 200+log when not
- [ ] Every D3 exempt path reachable without the token (test)
- [ ] All four callers send the header; each repo's full tests, vet, readonly build, diff check clean
- [ ] Deploy order Wallet(A) → callers → Wallet(B) written in the handoff and followed on staging
- [ ] Post-Phase-B proof: raw curl from inside the VPC path without header → 401; Store purchase, Missions payout, admin rate-catalog upsert still succeed
- [ ] No secret value in any tracked file; `.env.example` entries only

## Rollback
Flip `WALLET_INTERNAL_TOKEN_ENFORCE` back to `"false"` (no redeploy of callers needed). Full revert = revert the Wallet PR; caller header is harmless if left.
