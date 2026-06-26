# TASK-112: Fix staging store-exchange SQL `id` ambiguity in Wallet

## Short name
`wallet-exchange-id-ambiguous`

## Type
bugfix

## Priority
high

## Parent / Related
- Related: TASK-111 (Missions/Order store-exchange error mapping). TASK-111
  changed how the error surfaced; this task fixes the underlying functional bug.

## Request

Tester reported staging `POST /api/v1/store/exchange` returning:

```json
{
  "code": 6,
  "message": "{\"code\":1004,\"credited_coin\":0,\"error\":\"ERROR: column reference \\\"id\\\" is ambiguous (SQLSTATE 42702)\",\"message\":\"ERROR: column reference \\\"id\\\" is ambiguous (SQLSTATE 42702)\",\"spent_diamonds\":0,\"status\":\"\"}",
  "details": []
}
```

## Root Cause

`Games-Labs-Wallet/internal/repositories/wallet.go` `getExistingExchange` runs on
every `ExchangeDiamondsToCoins` call (idempotency pre-check). Its query:

```sql
SELECT
    COALESCE(MAX(CASE WHEN type = $3 THEN id::text END), ''),
    COALESCE(MAX(CASE WHEN type = $4 THEN id::text END), ''),
    ...
 FROM wallet_transactions wt
 JOIN wallets w ON w.user_id = wt.user_id
```

joins `wallet_transactions` and `wallets` — both have an `id UUID PRIMARY KEY`
(see `migrations/001_create_wallets_table.sql`) — while selecting a bare `id`.
Postgres raises `42702 column reference "id" is ambiguous` at plan time, so the
query never executes and every staging exchange fails.

Error propagation: Wallet error → Order wraps as `ExchangeOrderError` → Order
HTTP 409 → Missions order-client mapping (TASK-111) → `DuplicateKeyError` (1004)
→ gRPC `ALREADY_EXISTS` (6). This reproduces the tester payload exactly.

## Fix

Qualify the `wallet_transactions` columns in the JOIN
(`wt.id` / `wt.type` / `wt.coin_after` / `wt.metadata`); `w.diamonds` was already
qualified. Committed as `462308a` on `Games-Labs-Wallet` branch `staging`.

## Acceptance Criteria

- [x] `getExistingExchange` no longer references an unqualified `id` under the
      `wallet_transactions`/`wallets` JOIN.
- [x] `go build` and `go vet` pass for `./internal/repositories`.
- [ ] Staging exchange smoke after deploy: `POST /api/v1/store/exchange` with a
      fresh `rate_id` returns a credited result (not 42702).
- [ ] Reviewer sign-off.

## Verification

- `cd Games-Labs-Wallet && GOWORK=off GOCACHE=<tmp> go build ./internal/repositories && go vet ./internal/repositories`
- `ruby ai-dev-office/validate-yaml.rb TASK-112`
- Post-deploy staging smoke (token-authenticated exchange).

## Notes

- No repo-level DB test harness (testcontainers/dockertest/sqlmock) exists, so
  the SQL plan error can only be caught against a real Postgres — hence the
  post-deploy smoke is the authoritative check.
- Secondary (deferred): Order surfacing a downstream wallet failure as 409, and
  the Missions 409→DuplicateKeyError mapping, make the client message
  misleading. Not changed here; harmless once the exchange succeeds.

## Assignment

- Primary: Claude advisory lane (recorded as `free-roam` for enum compliance)
- Parallel: `false`
