# TASK-EAR-365 — Wallet drops Provider's `source`, so gameplay rows are unclassifiable

- Short name: `wallet-accept-source-field`
- Type: fix / backend
- Workstream: backend
- Priority: high
- Created: 2026-09-18
- Repo: `Games-Labs-Wallet` (base: `staging` @ `7b866f6`)

## Defect

`Credit` and `Debit` decode the request body into an anonymous struct with
`user_id`, `amount`, `currency`, `provider_id`, `reason`, `reference_id`,
`reference_type`, `idempotency_key` — and **no `source`**
(`internal/core/handlers/wallethdl/wallet_handler.go:156` and the Debit twin).
`encoding/json` discards unknown fields silently, so Provider's `source` never
arrives.

Provider sends only `source` — `models.TransactionPayload` has no `Reason` and
no `ReferenceID` at all (`internal/core/models/transaction.go:3`):

| provider | value built | file |
| --- | --- | --- |
| VP | `vp_<action>_<transferID>` | `internal/core/services/vp/seamless.go:249` |
| AFB | `afb_round_<roundID>` | `internal/core/services/afb/service.go:451` |

The `source` **column** is populated from the service's `source` parameter,
which the handler feeds from `ReferenceID` (see the comment at
`wallet_handler.go:201`). Provider sends no `reference_id`, so the column is
empty too. Result: empty `source`, empty `metadata.reason`.

## Impact (staging census, 2026-09-18)

| bucket | rows | coin |
| --- | ---: | ---: |
| gameplay-like COIN debit, no source and no reason | 7,433 | 64,335,158 |
| └ has `provider_id` | 3,000 | 21,637,996 |
| └ no `provider_id` | 4,433 | 42,697,162 |

For scale, every deliberately-labelled bucket is small by comparison:
package purchase 77 rows, diamond exchange 81, restore streak 85, buy pass 24,
buy avatar 7, buy VIP level 5, admin deduction 22.

This is not a legacy-data problem. It is a live defect writing unclassifiable
rows on every spin.

## Scope

1. Accept `source` on both `Credit` and `Debit`.
2. Persist it so it lands in the `source` column.
3. Precedence, explicit and deterministic: **`reference_id` wins when both are
   present**; `source` is the fallback. Today no caller sends both, so this
   preserves every existing behaviour — but write it down and test it rather
   than leaving it to field order.
4. Regression test, observed failing before the fix: a Provider-shaped body
   (`source` set, no `reason`, no `reference_id`) must produce a row whose
   `source` column is non-empty.

## Out of scope — do not do these here

- **Bucket definitions.** How `source` maps to Purchased / Free / Played /
  Used is a PM decision that is still open. Capture the data; classify later.
- **Backfilling the 7,433 existing rows.** They keep needing a guessed rule;
  that rule belongs to the aggregate run.
- **Normalising the value.** VP's `vp_bet_<uuid>` and AFB's
  `afb_round_<uuid>` are high-cardinality, so a later `GROUP BY source` will
  not bucket cleanly — it will need a prefix or a derived column. Note it for
  the aggregate run; do not design it here.
- Changing `models.TransactionPayload` in Provider. The contract is fine; the
  receiver is what is broken.

## Callers checked (why the blast radius is narrow)

| caller | sends | currency | effect |
| --- | --- | --- | --- |
| Provider AFB + VP | `source` only | COIN | **fixed by this change** |
| Missions | `Reason` + `ReferenceType` + `ReferenceID` | COIN | unaffected, already classifiable |
| User `walletadt` | `reason` only | DIAMOND | unaffected |
| Order `walletadt` | `reason` only | DIAMOND | unaffected |

No caller sends both `source` and `reference_id`.

## Deploy

Wallet-local. No proto, no gateway, no shared-lib bump — Provider and Missions
call Wallet's own HTTP mux. No migration: the `source` column already exists
on `wallet_transactions` (`migrations/001_create_wallets_table.sql:19`).

## Acceptance criteria

- A Provider-shaped request writes a non-empty `source` column.
- The regression test was observed failing before the fix.
- Missions, User and Order request shapes produce byte-identical rows to
  before — cover at least the Missions COIN debit shape with a test.
- `go build`, `go vet`, `go test ./...` pass.
- On staging after deploy: new COIN debit rows from live play carry a
  non-empty `source`; re-run the census query and confirm the unclassifiable
  count has stopped growing.
