# TASK-EAR-247 — Wire backoffice Special Item (Pass) benefits into real enforcement

Epic scope run. Today the Store special-item pipeline sells passes and tracks
ownership/expiry correctly, but **no benefit configured from the backoffice is
enforced anywhere**. Scoped by the Claude advisory lane on 2026-08-10 from
source reads across Order, Missions, Game, and Backoffice.

## Evidence (why nothing works today)

- Backoffice saves `pass_type` as the literal Figma label — `"Level Access
  Pass"` or `"Point Multiplier"` (`app/utils/passDetail.ts:3-10`), with the
  multiplier value in `detail_from` and the VIP range in
  `detail_from`/`detail_to`.
- Every backend benefit check matches hardcoded legacy slugs only:
  - Game: `HasActivePass(userID, "golden_pass")`
    (`gamesvc/service.go:520`, `level_access.go`)
  - Missions: `"bonus_2x"` (`level_service.go:256`), `"xp_boost"` (`:290`),
    `"club_membership"` (`:293`), `"mission_boost"`
    (`mission_service.go:498`), `"coin_booster"` (`store_service.go:1626`)
- Grep across Order/Missions/Game/api-gateway: zero references to the Figma
  labels; nothing reads `detail_from`, `level_id`, or `game_ids` at
  benefit-application time. Multiplier values are hardcoded (×2, +50%, +10%);
  golden-pass unlock range comes from the global `mission_config`
  golden-pass columns (offset 11 / max 16), never from the item.
- Order accepts any `pass_type` string (`ordersvc/service.go:2018` only
  trims), so a purchasable no-op benefit is the default outcome.
- Save-trap: the backoffice edit page normalizes stored slug → label on load
  (`store/pass/edit/[id].vue:503`) and saves the label back, so opening a
  legacy `golden_pass` item and pressing save silently destroys a working
  benefit.

Operator direction 2026-08-10: legacy seeded pass types are considered
retired; the only items that must work are the ones created from
`admin/manage/store/items`. Current staging catalog: 2 custom items
("Pass test" Point x 1.5, "Golden Pass" VIP1-VIP5 / game 59).

## Decisions locked

- Canonical `pass_type` slugs going forward: **`level_access`** and
  **`point_multiplier`**. Figma labels remain display-only in the FE.
- Benefit parameters are **snapshotted into Missions at purchase time**
  (columns on `user_passes`), not fetched from Order in hot paths — EXP
  accrual and game-list rendering must not add a cross-service call.
- Legacy slugs get a one-time normalization in Order data + read-side
  aliasing; the six legacy benefit switches in Missions/Game are replaced,
  not extended.

## Decision gates (operator/PM before the affected ticket starts)

- **D1 — Level Access semantics.** The item carries both a VIP range
  (`detail_from`-`detail_to`) and `game_ids` ("ทั้งหมด" = empty = all).
  Proposal: pass unlocks games whose required level falls inside the VIP
  range; if `game_ids` is non-empty it further restricts to those games; the
  global golden-pass config columns are retired from the unlock path.
  Blocks T3 only.
- **D2 — Multiplier stacking.** If a user holds two active
  `point_multiplier` passes, proposal: apply `max(multiplier)`, never the
  product. Blocks T2 only.

## Tickets (sequenced)

### T1 — Canonical pass_type contract (Order + Backoffice) — unblocker, first

- Order: validate `pass_type` ∈ {`level_access`, `point_multiplier`} for
  `item_type=pass` on upsert (typed error, not silent trim); reject empty.
- Order migration (idempotent): backfill existing `special_items.pass_type` —
  `"Level Access Pass"`/`golden_pass`/`club_membership` → `level_access`;
  `"Point Multiplier"`/`bonus_2x`/`xp_boost`/`mission_boost`/`coin_booster` →
  `point_multiplier`. States deploy order + rollback per
  schema-change-needs-migration.
- Point Multiplier items: persist the multiplier as structured data
  (decision: reuse `detail_from` normalized to `1.5|2|2.5|3`, validated
  server-side — no new proto field needed; gateway wire format untouched).
- Backoffice: send slugs on create/save; `passDetail.ts` maps slug → label
  for display only. **This also closes the save-trap (old T4):** saving any
  item must never persist a label into `pass_type`. Keep
  preserve-ux-design-wire-data-only — no visual changes.
- No Missions change yet; purchases keep writing `pass_type` verbatim into
  `user_passes` (now guaranteed to be a canonical slug).

### T2 — Point Multiplier benefit engine (Missions) — after T1, gated on D2

- Missions migration (idempotent — Missions replays all migrations every
  boot): add benefit snapshot columns to `user_passes` (multiplier NUMERIC,
  nullable) + backfill nothing (legacy rows carry no benefit by operator
  decision).
- Purchase path (`BuyPass`/`executeStorePurchase`): snapshot the item's
  multiplier into the new column.
- `level_service.AddTurnover`: replace the `bonus_2x`/`xp_boost`/
  `club_membership` hardcoded block with "resolve active `point_multiplier`
  passes → apply per D2". Delete the dead legacy branches.
- Regression tests seen failing first (test-integrity): buy a 1.5× item →
  turnover 100 yields 150 exp; expired pass yields 100; stacking per D2.

### T3 — Level Access enforcement (Missions + Game) — after T1, gated on D1

- Missions: snapshot level-access params into `user_passes` (VIP range,
  game_ids) at purchase; extend the Missions↔Game gRPC surface (new RPC or
  extended `HasActivePass` response in shared-lib `missionspb`) to return
  active level-access grants.
- shared-lib proto change ⇒ staging-lane shared-lib bump for **both** Game
  and api-gateway (gateway owns the wire format — proven 5x; prove with a raw
  response body, never a green build), even though the RPC is internal.
- Game: `level_access.go` computes `maxPlayLevel`/playability from the
  per-item grant per D1; global golden-pass config path retired (admin
  endpoints can stay but stop feeding the unlock).
- Tests: game list playability with/without an active pass, range edges,
  `game_ids` restriction, expiry.

### T4 — folded into T1 (save-trap). Listed for traceability only.

## Explicitly not in scope

- Reviving the six legacy seeded passes or `store_passes`-era behavior.
- Avatar benefits (cosmetic-by-design), mission_boost daily reward redesign,
  coin_booster exchange bonus — no new benefit types beyond the two slugs.
- Mobile FE changes (client already renders catalog fields; contract fields
  unchanged at the gateway edge for T1/T2).
- Production deploy — staging only; rides the consolidated prod patch train.
- Backfilling benefits onto already-sold passes.

## Acceptance criteria (epic)

1. Order rejects a pass upsert whose `pass_type` is not a canonical slug;
   existing rows are normalized by migration.
2. Saving any pass from the backoffice (create or edit, including legacy
   rows) persists only canonical slugs — the label round-trip trap is dead.
3. Buying a backoffice-created Point Multiplier 1.5 item on staging: turnover
   100 → 150 exp while active, 100 after expiry (proved via API/DB evidence,
   devtest QA player f737e6f3).
4. Buying a backoffice-created Level Access item on staging changes the
   game-list playability exactly per D1, and reverts on expiry — proved by
   grepping the raw gateway response body.
5. All migrations idempotent under boot replay (Missions/Game constraint).
6. Each ticket lands with regression tests seen failing pre-change.

## Verification

Per-ticket Go tests + staging E2E per acceptance 3-4 on
api-test-gateway / admin-dev.gameslabs.app with the devtest login. Route
availability proved via unauthenticated `/{svc}/swagger/doc.json` where a
route is added.

## Deploy order

T1 (Order first — catalog + migration, then Backoffice) → T2 (Missions) →
T3 (shared-lib bump → Missions → Game + gateway bump). Staging only.

## Scope

- Included: Games-Labs-Order, Games-Labs-Missions, Games-Labs-Game,
  Games-Labs-backoffice, shared-lib (T3 proto only).
- Excluded: everything under "Explicitly not in scope".
