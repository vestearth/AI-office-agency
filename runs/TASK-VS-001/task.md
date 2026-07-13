# TASK-VS-001 — Scaffold slipNext-api + slipNext-system with mock bank flow

## Goal

First code in both (currently empty) VerifySlip Go repos: lay down the
ADR-VS-0001 / STRUCTURE.md v3.2 shape and prove the verify flow end-to-end
against a mock bank provider.

## Architecture of record

- `VerifySlip/STRUCTURE.md` (v3.2 — repo topology FINAL per ADR-VS-0001)
- `knowledge-base/Knowledge Base/30 ADR/ADR-VS-0001 Two Backend Repos Three Ownership Units.md`
- Repo rules: `slipNext-api/AGENTS.md`, `slipNext-system/AGENTS.md`

## Scope

1. `slipNext-api`: single `cmd/api` binary; packages
   `internal/{partner,verification,billing,audit,webhook,bankclient,repository}`
   (create only what the mock flow exercises — no empty placeholder packages);
   config loading; migrations for the verification-owned tables actually used.
2. `slipNext-system`: `cmd/server`; `internal/provider/mock` (adapter
   interface + mock bank); `internal/router`; stateless; internal API consumed
   by `slipNext-api`'s `bankclient`.
3. Mock end-to-end flow: submit slip -> partner auth stub -> verification
   workflow (`state` lifecycle + `outcome` decided from returned evidence) ->
   bankclient -> system -> mock provider -> evidence back -> stored result ->
   response.
4. Basic tests around the workflow state/outcome transitions and the mock
   adapter contract.

## Out of scope (evidence gate open — bank docs do not exist yet)

Real bank adapter, callbacks, Redis, circuit breaker, queue/outbox topology,
api↔system transport upgrade (plain HTTP internal call is fine for the mock),
`slipNext-web`, deploy config.

## Acceptance

- Both repos build (`go build ./...`) and tests pass (`go test ./...`).
- The mock verify flow runs end-to-end locally.
- No cross-package direct table access; `slipNext-system` holds no state and
  no knowledge of partners/billing/outcome rules.
- `ruby ai-dev-office/validate-yaml.rb TASK-VS-001` passes on the run record.
