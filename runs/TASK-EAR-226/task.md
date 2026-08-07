# TASK-EAR-226 — Wallet admin-action audit publisher (`manual_wallet` scope)

## Type

feature

## Priority

medium

## Context

Fifth of the six player-audit-modal scopes. Four are live (VIP Level, Grant Pass,
Missions, E-Voucher). This adds the publisher for `manual_wallet`; the FE bind is
a follow-up run, matching how TASK-EAR-219 preceded TASK-EAR-222/223.

**Backend only. No FE work in this run.**

Scoped read-only first (2026-08-07). Everything below was verified in source on
`origin/staging`, not assumed — including one earlier belief that turned out to
be wrong.

## Correction to a previously stated blocker

Earlier notes claimed Wallet "captures no staff identity at all" and that fixing
that was a large prerequisite. **That is wrong.**
`internal/core/handlers/adminwallethdl/grpc.go:262` already defines
`adminUserFromMetadata(ctx)`, reading `userid` from incoming gRPC metadata, and
the two rate-catalog RPCs use it (`:352`, `:399`). `UpdateWalletBalance` (`:85`)
simply never calls it. The metadata path is fully intact — api-gateway's
`InjectTrustedIdentityHeaders` strips client-supplied values and rewrites
`userid`/`role`/`access` from the validated token
(`api-gateway/middleware/identity_headers.go:12-33`), and
`interceptor.MapMetadataInterceptor` sets all three. This is a small fix.

Use `auth.ConvertMetaDataToUserData` (as every other publisher does), **not**
`adminUserFromMetadata` — the latter returns only the id, and the audit event
needs `ActorRole` too.

## Scope — the one endpoint that matters

| RPC | HTTP | Handler |
|---|---|---|
| `UpdateWalletBalance` | `PATCH /api/v1/admin/wallet/balance/{user_id}` | `adminwallethdl/grpc.go:85` |

That is the only money-moving admin write, and the only one the backoffice
Manual Wallet panel calls (`Games-Labs-backoffice/.../player/edit/[id].vue:629-637`
sends `{coin, points, diamonds}` as absolute target values). The two rate-catalog
RPCs are config, not player state — **out of scope**.

## Contract — locked by the operator

**One event per currency that actually changed.** Not one combined event.

Action name: `wallet.balance.update`, with the currency identified in the
payload. Rationale, decided deliberately:

- The modal's `manual_wallet` scope has a per-row `currency` column
  (`Games-Labs-backoffice/app/data/mock.ts`, `getPlayerAuditLogDefinition`:
  `updatedAt`, `currency`, `previous`, `updated`, `byAdmin`).
- **The three mutations are not atomic** — separate transactions in
  `AdminSetWalletBalances`. A mid-way failure leaves COIN moved and the rest not.
  A single combined event would record changes that never happened.
- Every prior publisher used a single before/after map per event.

So: publish **after each currency's mutation succeeds**, never up front, and only
for currencies whose value actually changed.

## The before-state problem

`UpdateWalletBalance` has no before-state today.
`walletsvc.AdminSetWalletBalances` (`service.go:322-398`) reads the stored wallet
at `:330` and re-reads at `:365`/`:380`/`:397`, but returns only the final wallet.

Two options — **prefer the second**:
1. Handler calls `GetBalance` before and uses the returned wallet after. Cheapest,
   but opens a race on a money path.
2. Service returns before/after per currency. More plumbing, no race.

Values from `repo.GetWallet` are the **stored** truth, not display-derived — good,
and that has been the trap in every prior publisher.

## ⚠️ Pre-existing defect to work around, not fix here

`service.go:335-343`:

```go
if coin == 0 { coin = w.CoinAmount }
if points == 0 { points = w.Points }
if diamonds == 0 { diamonds = w.Diamonds }
```

Zero means "unchanged", so **an admin cannot set any balance to zero** through
this endpoint. Verified in source. Consequences here:

- It is genuinely impossible to distinguish "set to 0" from "leave alone", so
  treating 0 as no-change is the only behaviour the audit can honestly reflect.
- Do **not** emit an event for a currency the service left unchanged.
- Do **not** fix the defect in this run — it changes money semantics and deserves
  its own ticket. Note it in the PR body.

## RabbitMQ — no Order-style gap, but one real trap

Wallet already has a live publisher and consumer
(`infrastructure/player_activity_publisher.go`, wired `cmd/main.go:88`/`:174`),
`RABBITMQ_URL` is in `ecs/env.names:11` and exported in `staging.yml:113` and
`prod.yml:98`. Order's silent-death failure mode does not apply.

Still needed:
- `infrastructure/admin_action_publisher.go` — port from Games-Labs-User.
- `RABBITMQ_QUEUE_ADMIN_ACTIONS` — **not currently in `ecs/env.names`**. Add it,
  **with an accessor guard**, and export it in the workflows. `build-env-json.sh`
  renders any listed-but-unexported name as `""`, and an envconfig `default:` tag
  **never fires on set-but-empty** (verified in envconfig v1.4.0,
  `envconfig.go:199`: `if def != "" && !ok`). Only an explicit `if x == ""` guard
  works — this is what User does at `configs/config.go:66-72`.
- ⚠️ **Workflow files cannot be pushed from this lane** (no `workflow` OAuth
  scope — it has blocked this epic five times). Put the exact `staging.yml` and
  `prod.yml` diffs in the PR body for the operator.
- ⚠️ Wallet's `RabbitMQURL()` (`config/config.go:163-167`) defaults to
  `amqp://guest:guest@localhost:5672/`, so it is **never empty** and
  `cmd/main.go:174`'s `!= ""` check always passes. If the staging secret were
  empty the publisher would silently target localhost. Confirm the secret is
  actually set rather than trusting the guard.

## shared-lib bump required

Wallet is on `v0.0.0-20260727085427-329df4da61a0`, which **predates
`events.AdminActionEvent`**. Bump to at least
`v0.0.0-20260807081227-876e6983d84a` (the TASK-EAR-225 retirement commit, which
the other five repos are on). AGENTS.md:282: no `replace`, `go mod tidy`, commit
`go.mod`+`go.sum` together.

Convenient side effect: at that version `ActorAccess` no longer exists, so it is
impossible to reintroduce.

## Money-path constraints

- **Ledgers already exist and are richer**: `wallet_transactions`
  (`coin_before`/`coin_after`) and `wallet_points_ledger`
  (`points_before`/`points_after`), both already admin-readable. The audit row is
  **complementary, not duplicate** — the ledger says what moved, the audit row
  says which staff member ordered it, which the ledger cannot express.
- **POINT is a separate subsystem** — `repo.AddPoints`/`DeductPoints`
  (`service.go:386`/`:390`), not `ApplyTransaction`; `Debit` explicitly rejects
  POINT (`service.go:196`). Do not assume a uniform currency loop.
- **Idempotency**: `AdminSetWalletBalances` passes `""` as the idempotency key
  (`service.go:356/358/371/373`), so a retried PATCH re-applies. Use a fresh
  `EventID` per publish attempt so the sink's `UNIQUE(event_id)` dedupe behaves.

## Non-negotiables (carried from TASK-EAR-181/188/217)

- Publishing must **never block or fail** the wallet write it describes. Async,
  fire-and-forget, errors to a log line.
- Actor from gateway-validated metadata, never the request body.
- Publish denied and failed attempts too, not only successes.
- Before-state is the **stored** value.
- No secrets or tokens in `before`/`after`, ever.
- Do not touch `.github/workflows/*` — prepare diffs in the PR body instead.

## Acceptance criteria

- One event per changed currency, published only after that currency's mutation
  succeeds; none for unchanged currencies.
- Tests following the User pattern, including: per-currency events, no event for
  an unchanged currency, partial-failure (first currency succeeds, second fails →
  exactly one event, and the handler still returns its normal error), skip when
  no actor, and the handler still succeeding with no publisher configured.
- `GOWORK=off go build -mod=readonly ./... && go vet ./... && go test ./...` green.
- PR base `staging`, do not merge.
- Verify on staging by performing a real PATCH and reading the rows back through
  `GET /api/v1/admin/audit-events`. ⚠️ `actions` must be **repeated** query params
  — comma-joined returns `total: 0` silently. If staging cannot be reached, say so
  plainly rather than fabricating.

## Out of scope

- FE binding of the `manual_wallet` scope — follow-up run.
- The zero-means-unchanged defect — its own ticket.
- Rate-catalog RPCs.
- `reset_password` (Auth), the sixth scope — no publisher, never scoped.
