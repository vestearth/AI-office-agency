# TASK-EAR-009: Remove duplicate AdminWallet gateway registration

## Short name
`gateway-adminwallet-dedupe`

## Type
refactor

## Priority
low

## Parent / Epic
- Parent: `TASK-EAR-007`
- Epic: Admin Store Exchange Management
- Follow-up of: `TASK-EAR-007` review nit **N5 (duplicate gateway registration)**

## Lane
Claude manual advisory lane (no automated dev runner; see
`ai-dev-office/docs/CLAUDE.md`). Machine-readable `agent`/`current_agent` fields
use the standard enum roles; this note records that Claude executed the work in
the `dev` role.

## Background

The TASK-EAR-007 independent review flagged N5 as a non-blocking nit:

> N5 (duplicate gateway registration) tracked as follow-up.

In `api-gateway/gateway/grpc.go`, `registerGRPCEndpoints` lists the AdminWallet
grpc-gateway handler twice:

- once in the runtime/Wallet group (~line 85), and
- again in the `//Admin` group (~line 95),

both as
`{Endpoint{adminwalletpb.RegisterAdminWalletServiceHandlerFromEndpoint, cfg.WalletAPIURL}, "AdminWallet"}`.

The second registration of the same handler is idempotent/harmless at runtime
(grpc-gateway re-registers identical route patterns on the same mux), but it is
redundant and misleading — it registers the same patterns twice and groups
AdminWallet under both the runtime and the admin sections.

## Scope

### Target service

| Service | Role |
| --- | --- |
| `api-gateway` | Remove one of the two duplicate AdminWallet endpoint entries. |

In scope:
- Delete the runtime/Wallet-group AdminWallet entry (line ~85), keeping the one
  in the `//Admin` group for clarity. Exactly one AdminWallet registration
  remains.

Out of scope:
- Any other endpoint registration (Auth, Provider, Game, Order, Wallet, Payment,
  User, Missions, Admin*, Web*) — must be unchanged.
- Behavior changes or test changes.

## Acceptance criteria

1. `registerGRPCEndpoints` contains exactly one `"AdminWallet"` entry, located in
   the `//Admin` group.
2. No other endpoint entry is added, removed, reordered, or modified.
3. `GOWORK=off GOPRIVATE=github.com/SparqLab go build -mod=readonly ./...`
   succeeds in `api-gateway`.
4. `GOWORK=off go test ./...` passes, including
   `gateway/adminwallet_routes_test.go`
   (`TestAdminWalletRateCatalogRoutesExposed`).

## Verification commands

```sh
cd api-gateway
GOWORK=off GOPRIVATE=github.com/SparqLab go build -mod=readonly ./...
GOWORK=off go test ./...
```

## Provenance
Implemented via the Claude manual advisory lane acting in the `dev` role. State
is set to `done` after independent reviewer approval (the change lives in the
working tree; this root is not a git repo and nothing was committed).
See status.yaml history for the executed change + verification evidence.
