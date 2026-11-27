# TASK-EAR-425: Provider BNG: send Wallet internal token (DoWallet), set round currency, enable bng win capture on staging

Staging only. No prod contact: prod is cost-gated and BNG is not on prod source yet.
Lead: knowledge-base Review Queue 2026-11-12 ("BNG wallet calls skip the Wallet internal token")
and the Provider Field Lineage note, section "Recheck 2026-11-12".

## Problem (verified 2026-11-13 against `Games-Labs-Provider@origin/staging c3f00d2`)

1. **BNG Wallet calls carry no `X-Internal-Token`.** `internal/core/services/bng/wallet.go`
   calls `http.DefaultClient.Do` at `:46` (`bngGetWalletBalance`, GET `/wallets/balance`)
   and `:99` (`bngPostWallet`, used by `bngDebitWallet` -> POST `/wallets/debit` and
   `bngCreditWallet` -> POST `/wallets/credit`). Every other vendor goes through
   `utils.DoWallet` (`utils/http.go:153`), which attaches the token (TASK-EAR-266).
   - Wallet staging enforces the token: service runs td `games-labs-wallet-staging:83`,
     `WALLET_INTERNAL_TOKEN_ENFORCE=true`. None of the three BNG paths is exempt
     (exempt list: `Games-Labs-Wallet internal/internaltoken/middleware.go:14-18`).
     So BNG balance, bet and win should all get 401 on staging (from code; no BNG
     traffic in staging logs over the 10 days to 2026-11-12).
   - Provider staging already has the token: td `games-labs-provider-staging:38`
     (image `staging-sha-c3f00d2`) sets `WALLET_INTERNAL_TOKEN` (64 chars). The fix
     needs code only, no env change.
   - Why tests missed it: `bng/callback_test.go` `stubWallet` swaps the three function
     vars, so no BNG test ever runs the real HTTP path.
2. **BNG rounds settle with a blank currency.** `bng/callback.go:318-325` builds
   `gameadt.SettleRoundInput` without `Currency`. TASK-EAR-405 (`bbf1d2a`) set it for
   every other Wallet-calling vendor, before BNG landed. The Logs game report groups by
   `currency` and its totals stay empty when an in-scope row is blank
   (`Games-Labs-Logs@3ef8fd0:infrastructures/monitoring_clickhouse.go:608-648`).
   BNG posts `walletCurrency = "COIN"` to Wallet (`bng/wallet.go:20,84`).
3. **`bng` is not in the staging `WIN_CAPTURE_PROVIDERS`.** The code gate exists
   (`callback.go:326`, `config.WinCaptureEnabled("bng")`), but the GitHub `staging`
   environment variable is `vp,1up,afb,ggsoft,idg` (td `:38` value is 21 chars, same).
   Without it, BNG rounds reach Game with no `WinAmount`, so no W/L or GGR for BNG.

## Bypass sweep (other vendors)

All `config.WalletAPIURL()` users were listed. Only BNG's two call sites skip `DoWallet`:
afb (3), vp (3), oneup (2), ggsoft (2), idg (2) all use `utils.DoWallet`. Sigma does not
call Wallet. The other `http.DefaultClient` / `http.Client{}` sites point at vendor hosts,
not Wallet: `adapters/idg/adapter.go:60`, `adapters/vp/adapter.go:98`,
`handlers/providerhdl/provider.go:145` (AFB login proxy), `handlers/bnghdl/handler.go:43`
(BNG game-runner forward), `utils/http.go` `DoJSON`/`PostJSONWithBody` (vendor adapters).

## Plan

1. RED: `bng/wallet_token_test.go` points `WALLET_API_URL` at an `httptest` stub Wallet,
   sets `WALLET_INTERNAL_TOKEN`, calls `bngGetWalletBalance`, `bngDebitWallet` and
   `bngCreditWallet`, and asserts each request's `X-Internal-Token` equals the token.
   It must fail on `c3f00d2`.
2. GREEN: replace both `http.DefaultClient.Do` calls in `bng/wallet.go` with
   `utils.DoWallet`.
3. Currency: RED test in the TASK-EAR-405 style (real wallet transaction against the stub
   Wallet, captured `trySettleRoundHook`, settle currency == posted payload currency),
   then set `Currency: walletCurrency` in `accountRound`.
4. Win capture: add `bng` to the GitHub `staging` environment variable
   `WIN_CAPTURE_PROVIDERS` (persistent config, needs operator yes). It takes effect on
   the next staging deploy, so set it before the merge. Production variable untouched.
5. PR `task/TASK-EAR-425-bng-wallet-token` -> `staging`. Review, then merge (= staging
   deploy). `go build ./...`, `go vet ./...`, `go test ./...` on the reviewed commit.

## Acceptance

- New tests fail on `c3f00d2` and pass on the fix commit; full suite green.
- Staging task definition runs the merge commit image, and its `WIN_CAPTURE_PROVIDERS`
  contains `bng` (if approved).
- Staging acceptance: a BNG balance/bet/win call returns 200 from Wallet (no 401 in
  `/ecs/games-labs-wallet-staging` for BNG), and a finished BNG round reaches Game with
  `currency=COIN`. No BNG traffic exists yet, so this gate may wait on the first real
  BNG session.

## Deploy order and rollback

Provider-only change, staging only. Wallet needs nothing (an extra header is harmless).
Rollback: revert the merge on `staging` and remove `bng` from the staging variable.

## Traps

- BNG was pushed straight to `staging` by a teammate (86faecc, 8e6fd5a, 4b7dc54), not
  through a PR. Check `origin/staging` has not moved before branching and before merge.
- `config.New()` must be re-run after changing env in tests (see the TASK-EAR-405 tests).
- Do not touch `prod.yml`, the `production` environment variables, or any `*-prod` ECS
  service.
