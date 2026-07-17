# TASK-EAR-127: Correct Spend Prop categories and category-scoped progress

## Type

bugfix

## Workstream

full-stack

## Priority

high

## Created

2026-07-17

## Goal

Correct Daily and Weekly `spend_prop` so the product has exactly two concrete
special-item categories:

- `Special Item/Limited Avatar` (`avatar`)
- `Special Pass` (`pass`)

`Randomly by System` remains a selection mode, not a third category. Progress
must accrue only from a settled Diamond store purchase whose item type matches
the configured or per-user resolved category.

## Verified current defects

- Backoffice exposes three concrete peer values: `Special Item`, `Special Pass`,
  and `Limited Avatar`.
- Missions expands the random sentinel to the same three values even though the
  Order catalog has only canonical item types `avatar` and `pass`.
- Daily/Weekly generated plans drop `specialItemCategory`; plan-edit
  serialization also does not emit the selected category.
- Wallet publishes every settled Diamond debit as generic `consumption` with
  `source_reference_type=wallet_ledger`.
- Missions therefore counts generic Diamond consumption for
  `SPEND_DIAMOND_AMOUNT`, without checking the configured special-item category.

## Approved implementation

1. Backoffice exposes `Randomly by System` plus the two corrected concrete
  labels. Daily/Weekly plan-edit payloads persist the selected value as a
   `special_item` pool entry.
2. Missions default-template parsing and schedule generation carry
   `specialItemCategory` into Daily/Weekly activity pools.
3. Wallet reuses the existing optional `source_reference_type` field on
   `player.activity.v1` to distinguish `store_purchase_avatar` and
   `store_purchase_pass`, derived only from trusted internal debit metadata
   (`reference_type=STORE_PURCHASE`, `reason=buy_avatar|buy_pass`). No shared-lib
   event schema or dependency bump is required.
4. Missions hydrates the `special_item` pool for Diamond-spend rules, normalizes
   legacy values (`Special Item` and `Limited Avatar` both map to `avatar`),
   resolves `Randomly by System` independently per user and cadence using the
   existing immutable selection ledger, and matches only the corresponding
   Wallet store-purchase event type.
5. Existing reverse/idempotency behavior remains unchanged: reverse processing
   uses recorded forward deltas rather than re-evaluating the category.
6. The Event plan table reads Spend Prop `special_item_category` for its Random
   Selection Pool cell instead of applying the game-id formatter; legacy rows
   without the field display the runtime-compatible `Randomly by System` mode.
7. Daily and Weekly board rows with legacy Spend Prop activities whose persisted
   pool is empty display `Randomly by System`, matching the edit form and runtime
   resolution instead of rendering an empty cell.

## Scope

### Repositories

- `Games-Labs-backoffice`
- `Games-Labs-Wallet`
- `Games-Labs-Missions`
- `ai-dev-office`

### Explicitly excluded

- No database migration; existing pool and selection-ledger columns are opaque
  strings and already support these values.
- No protobuf, grpc-gateway, `shared-lib`, `api-gateway`, or Order contract
  change.
- No merge, deployment, staging DB mutation, or use of operator tokens.
- Event-mission progress wiring remains out of scope; only its shared category
  candidate list is corrected to the two-value product contract.

## Acceptance criteria

- Backoffice concrete categories are exactly the two approved labels; the
  random sentinel is still available as a mode.
- Daily and Weekly generated/edited `spend_prop` activities persist one
  `special_item` pool entry.
- Legacy configured labels normalize without breaking existing plans.
- An avatar purchase advances only an avatar-scoped Daily/Weekly rule; a pass
  purchase advances only a pass-scoped rule.
- Generic Diamond debits, exchanges, and mismatched store item types do not
  advance `spend_prop`.
- Random mode resolves to exactly one of `avatar` or `pass`, remains stable for
  the user/activity/surface, and Daily/Weekly selections are independent.
- Focused tests, full affected-repo tests/builds, Backoffice typecheck/tests,
  and `ruby ai-dev-office/validate-yaml.rb TASK-EAR-127` pass or any environment
  limitation is documented precisely.
