# TASK-EAR-288 — Publish Wallet and Order monitoring events

## Origin

Multica issue SPAR-21 — Monitoring: publish Wallet and Order financial events.

## Type

feature

## Workstream

backend

## Shape of this work — EXTEND

**Both services already publish `player.activity` today** —
`Games-Labs-Wallet/internal/core/services/walletsvc/player_activity_publish.go` and
`Games-Labs-Order/internal/core/services/ordersvc/service.go`. This task adds event
types and fields to publishers that already work, which makes it the smaller half of
the publisher work alongside TASK-EAR-289.

## Goal

Publish committed financial and commerce events from Wallet and Order for monitoring
and reports.

## Scope

- `Games-Labs-Wallet` and `Games-Labs-Order` only.
- Cover committed wallet / free-coin, package purchase, and redemption activity.

## Gaps the pages need that today's events do not carry

Read from the Player Log pages themselves — the UI is design-approved, so the contract
serves it:

- **wallet**: `spend.settled` covers debits only. The page also needs **credits** and a
  **`balance`** snapshot, which no event carries today. Decide whether balance is
  published on the event or derived by the projection — publishing it is simpler to
  read but is a point-in-time value that must come from the same committed transaction.
- **store**: Order publishes `spend.settled`, but the page needs the commercial detail —
  `packageName`, `paymentGateway`, `assets[]`, `promotionCode`, `discountType`,
  `discountLines[]`, `complimentary`, `purchaseId`, `originalPrice`, `totalDiscount`,
  `amountPaid`.
- **free-coin** and **redemption** have no `player.activity` representation at all today;
  `/api/v1/admin/wallet/free-coin/audit` and `AdminActionEvent`
  `order.redemption_item.grant` cover parts of the admin-driven case only.

## Contract notes that bind every publisher task

- **Extend `PlayerActivityEvent`; do not invent a new envelope** (TASK-EAR-284 D1).
  Add event types and fields **additively**, following the file's own `game_category`
  precedent: optional, omitted when unknown, fail-open, and harmless to existing
  consumers.
- **Do NOT add `actor_id` to `PlayerActivityEvent`** to make the two streams uniform.
  Player activity has no actor; the projection gets actor identity from
  `AdminActionEvent` instead. A field that is empty on every row from its main producer
  will be misread later.
- **Model corrections as explicit reverse events** — `*.reversed` pointing at the
  original via `reverse_of_event_id`. Never encode a reversal as a negative amount; the
  contract forbids it and every Report aggregate depends on it.
- **Never publish credentials, tokens, or session values.** `AdminActionEvent.ActorAccess`
  was removed in TASK-EAR-217/225 because it persisted a live bearer token into a
  long-retention store that staff could read back. Tag 5 is `reserved` by number and
  name. The same rule binds every field added here.
- **Publish only after the authoritative state transition commits**, and carry a unique
  `event_id` per attempt so the projection can dedupe a retry at ingest.

## Acceptance criteria

1. Financial activity represents only successful committed mutations.
2. Events preserve currency, amount and direction, target, event ID, and
   operation/correlation identity where available.
3. Duplicate publish or retry cannot double-count the projection.
4. Reversals are published as explicit `*.reversed` events, never as negative amounts.
5. Focused service tests pass.

## Dependencies

Blocked on TASK-EAR-284 shared-lib publication and version bump.
