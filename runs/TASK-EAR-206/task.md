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

## Open decision (blocks implementation)

Product must choose before any code is written:

1. **Implement it** — accumulate spend progress for joined users on
   `spend.settled` events scoped to the resolved item, mirroring the Daily path.
2. **Hide it** — stop offering `SPEND_PROP` in the Event admin dropdown and stop
   returning `resolved_special_item`, until someone wants the feature.

3. **Stop offering it, keep the field.** Remove `SPEND_PROP` from the Event admin
   dropdown so no new broken mission can be configured, and leave
   `resolved_special_item` in the response untouched. Nothing breaks for mobile,
   nothing ships broken, and option 1 stays open whenever Product wants the
   feature. Recommended as the cheapest safe move if the answer to "do we want
   this feature" is "not now" rather than "no".

Option 2 removes a live response field, so it is an API change mobile must be
told about — option 3 exists to avoid paying that cost for a feature nobody has
used. Option 1 must also decide whether the Event surface keeps the per-user roll
at all, given that TASK-EAR-205 retired it on Daily/Weekly precisely because a
rolled `avatar` can be unsatisfiable for a player who owns the active catalog
(`internal/services/store_service.go:933`).

Worth stating to Product plainly: because no progress has ever accrued, **no
player has ever completed an Event spend-prop mission**, so there is no live
behavior to preserve and no migration to worry about whichever option wins.

## Constraints

- TASK-EAR-205 must not be widened to cover this. Its acceptance criteria
  require every Event-surface test to pass unmodified.
- Whichever option is chosen, `wallet_ledger` events (Diamond→Coin exchange)
  must never credit progress, on any surface.

## Suggested ownership

`pm` to obtain the product decision first. Implementation sizing is not
meaningful until that answer exists.
