# TASK-EAR-205 — Spend Prop counts any purchasable Special Item (Daily/Weekly)

## Request

The Daily "Spend Prop" mission scopes progress to exactly one special-item
subtype — `avatar` or `pass` — chosen per user by a hidden deterministic roll.
A player who spends Diamonds on the other subtype earns nothing, is never told
which subtype was required, and can be locked out entirely. Replace the roll on
the Daily and Weekly surfaces with an explicit `any` scope that counts every
purchasable Special Item.

## Origin

Mobile/Dev team report, 2026-08-04, against staging:

| Field | Value |
| --- | --- |
| Mission | `daily-sched-2026-08-04-spend_prop` |
| Test user | `f737e6f3-466b-4db5-b86e-70ac4772b660` |
| Reported | bought Special Pass (10💎) and Golden Pass (499💎), exchanged 💎→Coin |
| Observed | `status: not_started`, `progress: 0/400` |

Root cause confirmed in source and by operator query, not inferred:

- The plan's configured scope is the sentinel — `daily_activity_pool_entries`
  row for this activity holds `entry_type=special_item`,
  `entry_ref='Randomly by System'` (operator-run query, 2026-08-04).
- The sentinel expands to a per-user deterministic pick,
  `candidates[sha256(surface \0 activity_id \0 user_id)[0] % 2]`
  (`internal/services/spend_prop_category.go:35`). Computed for this exact
  triple: byte`[0]`=150 → index 0 → `Special Item/Limited Avatar` → `avatar`.
- `NormalizeSpecialItemType` maps that label to `avatar`
  (`internal/models/event.go:53`), and the matcher requires an exact subtype
  match (`internal/services/activity_match.go:64`), so a `store_purchase_pass`
  event cannot contribute. `internal/services/activity_match_test.go:202` locks
  this behavior deliberately.

The player-facing result is unreachable by design: the roll is written **only on
event ingestion** (`internal/services/mission_service.go:2237`,
`internal/services/weekly_match.go:67`) and never on read, so the player must
already have spent on the correct subtype before the system records which
subtype was correct.

## Not a bug — explicitly ruled out

- **The event pipeline is intact.** Missions debits with
  `Reason: "buy_"+ItemType`, `ReferenceType: "STORE_PURCHASE"`
  (`internal/services/store_service.go:973`); Wallet maps that pair to
  `store_purchase_pass` / `store_purchase_avatar`
  (`Games-Labs-Wallet/internal/core/services/walletsvc/player_activity_publish.go:46`).
  Nothing in this run touches publishing.
- **Diamond→Coin exchange correctly does not count.** It carries an exchange
  reason, so Wallet publishes `wallet_ledger`. This must remain true after the
  change — it is the single highest-risk regression here.
- **`RegenerateDailyDue` never rewrites today** (TASK-EAR-079, locked by
  `internal/services/schedule_regenerate_test.go:18`). Today's live plan keeps
  the scope it was generated with; the fix works by re-interpreting the stored
  value at read time, not by rewriting plans.
- **The `Spend 400 Diamonds` title is already correct** after TASK-EAR-204
  (merged, `d4a43e1`). The `Spend 10 Diamonds` string in the report comes from a
  staging build predating that deploy. No display-name work belongs in this run.

## Dead-end analysis (why `any`, not a feasibility guard)

Passes are always re-purchasable — a repeat buy extends `expires_at` from the
current expiry (`internal/repositories/store_repo.go:427`), with no ownership
block. Avatars are not: an owned, still-active avatar is rejected with
`"avatar already owned"` (`internal/services/store_service.go:933`), and a
permanent avatar never frees the slot. A user rolled onto `avatar` who owns the
active catalog is therefore permanently stuck for that period, and the current
generator default puts every user on exactly that side.

Widening to `any` removes the dead end without new logic: the pass branch is
always satisfiable. Hiding the mission per user was rejected — daily plans are
global, and a per-user child count would corrupt the group bonus gate
(`AllChildrenComplete`, `internal/services/daily_completion_bonus.go:18`).
Auto-completing was rejected as paying an unearned reward.

## Goal

On Daily and Weekly, a Spend Prop mission counts Diamonds spent on **any**
Special Item the player can actually buy, so the mission is always achievable
and its title needs no hidden qualifier. Narrow subtype scopes remain available
to admins as an explicit, deliberate choice.

## Scope

Included:

- `Games-Labs-Missions` — an explicit `any` scope value on the Daily/Weekly
  spend-prop path, a surface-local legacy mapping, matcher support, and the
  generator default.
- `Games-Labs-backoffice` — split the shared special-item option list so Daily/
  Weekly and Event no longer share one dropdown, and fix the display fallback
  that is built by exclusion.

Excluded:

- **The Event surface, entirely.** Event keeps `Randomly by System`, keeps
  resolving through `mission_special_item_selections`, and keeps returning
  `resolved_special_item` (`internal/services/event_service.go:284`,
  `internal/models/event.go:218`). That field already ships to mobile; changing
  it is an API break and a separate decision.
- The `mission_special_item_selections` table — not dropped, not migrated, not
  backfilled. Event still reads it.
- Any DB migration, proto change, or `display_name` text change. The
  ` with {Special Item}` clause stays stripped
  (`internal/services/mission_display_name.go:67`).
- Wallet, Order, and the store purchase/publish path.

## Constraints

- `any` must be an **explicit value**. Empty `SpecialItemType` already means
  "unresolved" and is fail-closed at `internal/services/activity_match.go:64`;
  representing `any` as empty would silently disable the mission instead of
  widening it.
- The currency check, the spend-category exclusion, and the requirement that the
  event be a store purchase (`specialItemType != ""`) all stay. `wallet_ledger`
  must never match under any scope.
- The legacy mapping must run **before** the `NormalizeSpecialItemType` call at
  `internal/services/spend_prop_category.go:87`, or bare `Special Item` is
  converted to `avatar` before the new rule can see it.
- The mapping is Daily/Weekly-local. `NormalizeSpecialItemType` currently has no
  Event call site, but it lives in `models/event.go` behind a generic doc
  comment — if the mapping is placed there, the comment must state the surface
  restriction.
- `internal/services/activity_match_test.go:202` ("pass spend does not match
  avatar rule") is **updated, not deleted**: the narrow-scope behavior it locks
  must still hold for an explicit `avatar` scope, and the PR must state that the
  contract changed deliberately (`ai-skills/rules/test-integrity`).
- No migration is required by design: today's plans re-read the stored sentinel
  as `any` at match time, new plans stop emitting it, and stale Daily/Weekly
  ledger rows are simply never read again.

## Legacy value mapping (Daily/Weekly only)

The Backoffice dropdown binds `:value="item"`, so whatever label the option list
holds is persisted verbatim into `daily_activity_pool_entries.entry_ref`
(`app/components/mission/MissionPlanPeriodEditor.vue:517`). Every value in that
column is already a UI label, so the new option is stored as a label too and
mapped like the rest — introducing a canonical `any` for one option only would
put two conventions in one column, which is the exact ambiguity this run exists
to remove. `Any Special Item` therefore MUST be in the mapping table; without it
the resolver fail-closes and the new dropdown option silently does nothing.

| Stored value | Resolves to | Rationale |
| --- | --- | --- |
| `Any Special Item` | `any` | The new Daily/Weekly default, persisted as the dropdown label |
| `Randomly by System` | `any` | A selection mode being retired, not a chosen scope |
| `Special Item` | `any` | The umbrella category in Admin's own taxonomy |
| `Special Item/Limited Avatar` | `avatar` | Names Avatar explicitly — a deliberate narrow admin choice; widening it would silently rescope live Weekly plans |
| `Limited Avatar` | `avatar` | Already supported by the normalizer |
| `Special Pass` | `pass` | Unchanged |
| empty / no pool entry | `any` | Not the same as unrecognized. Before this run an empty scope fell into the roll and produced a working mission; fail-closing it would take legacy plans from partly working to permanently stuck. Generated plans never produce it — the generator writes the any-label explicitly |
| anything else | no match | Fail-closed, preserved from `spend_prop_category.go:91` |

## Acceptance criteria

1. A Daily spend_prop mission stored as `Randomly by System` credits progress
   for a `store_purchase_pass` event **and** for a `store_purchase_avatar`
   event, for any user, with no row written to or read from
   `mission_special_item_selections`.
2. The same holds on the Weekly surface.
3. A mission stored as `Special Item/Limited Avatar` still credits **only**
   `store_purchase_avatar`; one stored as `Special Pass` still credits only
   `store_purchase_pass`.
4. Under every scope including `any`, a `wallet_ledger` event (Diamond→Coin
   exchange) credits nothing, and the spend-category exclusion and Diamond
   currency checks still apply.
5. An unrecognized stored scope credits nothing (fail-closed), while a plan with
   no special-item pool entry at all resolves to `any` rather than to nothing —
   the two cases are distinct and both are pinned by test.
6. `SpecialItemType == ""` still credits nothing — `any` is not the empty value.
7. Newly generated plans carry the `any` scope, never the sentinel, when the
   default template names no category
   (`internal/services/schedule_defaults.go:327`).
8. Backoffice Daily/Weekly dropdown offers `Any Special Item`, `Limited Avatar`,
   `Special Pass`; the Event create/edit dropdown is unchanged and still offers
   `Randomly by System`, driven by a separate exported list
   (`app/data/mock.ts:1260`).
9. Saving `Any Special Item` from that dropdown produces a working mission
   end-to-end: the label is persisted verbatim into `entry_ref`, the resolver
   maps it to `any`, and both subtypes credit progress. A test pins the exact
   string the FE sends — a mapping that omits it fail-closes silently, which
   would ship a dropdown option that does nothing.
10. `DEFAULT_SPEND_PROP_POOL` (`app/utils/dailyPlanBoardMap.ts:8`) is an explicit
    constant, not `options.filter(!== 'Randomly by System')`, so adding a value
    to the dropdown cannot leak a phantom row into the plan table.
11. Every Event-surface test passes unmodified; `resolved_special_item` and the
    selection ledger behave exactly as before.
12. At least one regression test per criterion 1, 3, 4 and 9 was seen **failing**
    before the fix.
13. `go build ./...`, `go vet ./internal/...` and `go test ./...` green in
    `Games-Labs-Missions`; typecheck/build green in `Games-Labs-backoffice`.
14. Behavioral proof on staging before the run closes: the reported user buys a
    Special Pass and the Daily spend_prop progress increases by the price, and a
    Diamond→Coin exchange in the same day does not move it. A green pipeline
    does not close this run.

## Known gap, deliberately not closed here

On Daily and Weekly the scope is resolved only during event ingestion, never on
read — which is why a player today cannot be told which subtype was required
until after they have already spent on it. Widening to `any` makes that
harmless rather than fixing it; nothing reads the resolved value on those two
surfaces afterwards.

Event does NOT share that gap: it reads the locked selection and falls back to
resolve-on-read for a user who joined before the field existed
(`internal/services/event_service.go:168-190`). The fact worth recording about
Event is different — its `SPEND_PROP` condition is config-only and accumulates
no progress in the consumer at all
(`internal/services/mission_service.go:2250`). So an Event spend-prop mission
shows the player a resolved item it will never credit. That is a real gap, it is
out of scope here, and it needs its own run.

## Suggested ownership

Two repos, one concern, with the risky surface (the matcher) small and already
well covered by table-driven tests. Sequential `dev`, single review pass, with
explicit reviewer attention on criterion 4.
