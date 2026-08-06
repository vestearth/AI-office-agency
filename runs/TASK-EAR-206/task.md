# TASK-EAR-206 — Event SPEND_PROP shows a resolved item it never credits

## Request

An Event mission configured with a `SPEND_PROP` condition resolves a concrete
special item per user, returns it to mobile as `resolved_special_item`, and
renders it to the player — but the consumer accumulates no progress for it. The
player is told what to spend on and then earns nothing for doing it. Decide the
intended product behavior and close the gap.

## Origin

Found while scoping TASK-EAR-205 (Daily/Weekly spend-prop scope widening). Not
reported by QA — no one has tested an Event spend-prop mission end to end.
Recorded as its own run rather than folded into TASK-EAR-205, whose scope is
explicitly Daily + Weekly only.

## Source evidence

- The resolved item is real and player-visible: read after join, with
  resolve-on-read as a fallback for users who joined before the field existed
  (`internal/services/event_service.go:168-190`), surfaced as
  `resolved_special_item` on the event detail response
  (`internal/models/event.go:218`).
- The consumer credits event progress for `GAME_TURNOVER` only. The other
  condition types are stored as config and never drive progress — stated
  outright in the code comment at
  `internal/services/mission_service.go:2250-2254`, and enforced by the guard
  below it, which only fires on `turnover.settled` with a non-empty `GameID`.
- Contract v1.1 named this a Phase-1 limitation
  (`internal/models/event.go:11-19`), so this is an unfinished feature rather
  than a regression.
- Backoffice already persists `min_spending_value` with
  `special_item_category` for spend_prop
  (`Games-Labs-backoffice/app/utils/eventMissionMap.ts:127-128`). Backend stores
  params opaquely today; runtime progress never reads that threshold.
- `mission_event_progress` is keyed by `(event_id, user_id, game_id)` and
  `buildCard` for config-driven events derives target from `len(Games)`
  (`event_service.go:508-537`). SPEND_PROP events typically have no games, so
  they are not on the per-game turnover path — implement must add a spend
  progress path rather than pretend spend is another game row.

## Product decision (locked 2026-08-05)

Operator chose **option 1 — Implement**.

Sub-decision (locked with Implement, PM recommendation accepted as default):

- **Keep** Event per-user resolution, `mission_special_item_selections`, and
  `resolved_special_item` (ADR-0008 / TASK-EAR-071). Do **not** migrate Event
  to Daily/Weekly `any` in this run.
- Credit Diamond spend on `spend.settled` only when the purchase matches the
  user's locked resolved special-item scope (normalized subtype / concrete
  label), for events the user has joined.
- Residual avatar-ownership lockout (player rolled `avatar` but owns the active
  catalog) remains a known Event design trade-off; fixing it via `any` is out of
  scope here.

Rejected for this run:

2. Hide it (remove `SPEND_PROP` + drop `resolved_special_item`) — API break.
3. Stop offering in admin, keep the field — safe deferral; superseded by Implement.

## Goal

A joined user on an active Event with `SPEND_PROP` earns progress when they buy
the special item they were shown, reaches claimable at `min_spending_value`, and
never earns progress from Diamond→Coin exchange (`wallet_ledger`).

## Scope

Included:

- `Games-Labs-Missions` only — consumer hook for Event spend, progress
  persistence readable by Event detail/claim, matcher against resolved
  selection, tests, and contract comment updates that Phase-1 SPEND_PROP
  progress is now live.

Excluded:

- Daily/Weekly surfaces (TASK-EAR-205 owns those; do not reopen).
- `CATEGORY_TURNOVER` / `ANY_GAME_TURNOVER` runtime progress.
- Changing or removing `resolved_special_item`.
- Migrating Event to `any` scope / retiring `Randomly by System` on Event.
- Backoffice dropdown changes (Event list stays as-is).
- Wallet / Order publishers (already emit `store_purchase_*` vs `wallet_ledger`).
- Proto / api-gateway changes unless evidence forces a new field (prefer reusing
  existing card `progress`/`target`/`claimable`).

## Constraints

- TASK-EAR-205 must not be widened; its Event-surface tests stay green for that
  run's criteria. This run may add Event spend tests of its own.
- `wallet_ledger` must never credit Event (or any surface) spend-prop progress.
- Spend match must require a real store special-item purchase (non-empty
  special-item type on the activity event), same currency/category guards as
  Daily.
- Prefer reusing Daily spend matching helpers where they already encode the
  rules; do not duplicate a second matcher with drift risk.
- Progress storage must not corrupt GAME_TURNOVER per-game rows. If
  `mission_event_progress.game_id` is reused, choose an explicit sentinel
  documented in code + tests; otherwise add a dedicated spend progress path.
- No migration that rewrites live Event history is required — no player has ever
  completed an Event spend-prop mission (progress never accrued).

## Acceptance criteria

1. Joined user on an active SPEND_PROP Event accumulates Diamond progress from
   `spend.settled` store purchases that match their locked
   `resolved_special_item` / selection ledger subtype.
2. Progress reaches claimable when accumulated spend ≥ `min_spending_value` from
   the event's SPEND_PROP params; Event detail exposes coherent
   `progress` / `target` / `claimable` for that path.
3. A purchase of the other subtype (avatar vs pass) does not credit when the
   locked selection is narrow.
4. `wallet_ledger` (Diamond→Coin) credits nothing.
5. Users who have not joined receive no Event spend progress.
6. GAME_TURNOVER Event progress behavior is unchanged (existing turnover tests
   still pass).
7. At least one regression test for criteria 1, 2, and 4 was seen failing before
   the fix.
8. `go build ./...`, `go vet ./internal/...`, and focused `go test` for the
   touched packages pass in `Games-Labs-Missions`.
9. Contract comments / mobile-facing notes that still say "SPEND_PROP does not
   drive progress" are updated in-repo where they live next to the code (and
   knowledge capture may follow after merge).

## Plan

### Approach

Wire `HandlePlayerActivityEvent` so `spend.settled` also applies Event spend
deltas for joined SPEND_PROP events, scoped to the user's immutable selection.
Teach Event card/claim read paths to use `min_spending_value` and that spend
progress instead of the per-game turnover counters. Mirror Daily's store-purchase
vs ledger exclusion.

### Subtasks

1. **Progress model** — define how Event spend progress is stored and how
   `buildCard` / claim derive progress/target for SPEND_PROP (no games).
2. **Consumer** — on `spend.settled`, resolve matching joined SPEND_PROP events
   and apply deltas; never on `wallet_ledger`.
3. **Tests** — fail-first coverage for match, threshold/claimable, ledger
   exclusion, and non-joined no-op; prove GAME_TURNOVER untouched.

## Risks

- **Schema reuse of `game_id`.** Mitigation: explicit sentinel or separate path
  with tests that GAME_TURNOVER rows are untouched.
- **SPEND_PROP events with empty Games currently sit outside IsConfigDriven.**
  Mitigation: branch card/claim on condition type, not only `len(Games)`.
- **Avatar lockout.** Accepted residual; document in run notes, do not widen to
  `any` without a new product call.
- **Overlap with TASK-EAR-205.** Stay Event-only; do not change Daily/Weekly
  mapping or Backoffice shared lists.

## Suggested ownership

`dev-2` — single service, but consumer + progress model + claim semantics are
cross-cutting inside Missions and easy to get subtly wrong.
