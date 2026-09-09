# TASK-EAR-342: Gameplay Player Log W/L — pending vs final outcome contract across Provider → Game → Logs → Backoffice

## Type
bug (data truthfulness on an admin surface) — not a money-movement defect

## Priority
high

## Origin
Continuation of `_workspace/handoff/2026-09-09-games-labs-gameplay-wl-monitoring.md`
(codex diagnosis, re-audited by Claude on 2026-09-09: VERIFIED — every claim
re-observed in source and staging CloudWatch, see Evidence).

## Scope
### Target services (deploy order matters — see Sequence)
- `shared-lib` — `events/player_activity.go` (additive), `proto/admin/monitoringpb/monitoring.proto`
- `Games-Labs-Game` — `internal/core/services/gamesvc/{service.go,player_activity.go}`, repo upsert
- `Games-Labs-Logs` — consumer, ClickHouse projection + read queries, `monitoringhdl/grpc.go`
- `api-gateway` — shared-lib bump only (it owns the wire format; a Logs-only bump does NOT change JSON)
- `Games-Labs-backoffice` — tests only (renderer already maps absent → `-`)
- `Games-Labs-Missions` — NO code change; a regression test that the new event type is ACK-dropped

### Explicitly out of scope
- `Turnover` and `THB W/L` columns on this page (still unwired, separate decision)
- Provider callback contracts (AFB/IDG/VP/1UP/GGSoft) — no Provider change
- `Games-Lab-Android` (read-only repo)
- Production deploy (staging only; prod train is a separate release task)

## Problem (verified 2026-09-09, staging)
`/admin/monitoring/player-log/gameplay` W/L is computed correctly
(`WinAmount - SettledAmount`) but the lifecycle is wrong for split-callback
providers:

1. **Unknown collapses to `+0`.** IDG settles at bet time with `WinAmount` nil.
   Game omits `WinLossAmount`; `PlayerActivityEvent.win_loss_amount` is a plain
   `float64,omitempty` and `GameplayLogDetail.win_loss_amount` a non-optional
   `double`, so the gateway (grpc-gateway v2 default `EmitUnpopulated`) emits
   `0` and Backoffice renders `+0`. Same for every Sigma round (Sigma is not in
   `WIN_CAPTURE_PROVIDERS`).
2. **Correction rejected as redelivery.** The later `idg:win` / AFB enrichment
   re-settles the same round; Game's upsert takes the monotonic win
   (`GREATEST(COALESCE...)`) and republishes `round.settled` under the SAME
   stable event id `player-activity:round:<round>:round.settled`. Logs'
   Postgres admission gate (`monitoring_event_admissions`, completed = forever)
   ACKs it as `redelivery ignored`. The projection keeps the provisional
   snapshot forever.

Runtime proof (staging, 2026-09-09 08:41 UTC, round
`50843b2e-b351-4300-a6f7-cdf8ad12f456`): Game logged two `SettleRound`
(`inserted=true` then `inserted=false ... republished player.activity`); Logs
logged `redelivery ignored event_id=player-activity:round:50843b2e-...:round.settled`.
UI shows `+0`; truth is `-20000`.

## Provider compatibility matrix (rows that must keep working)
| Provider | First settle carries | Later re-settle | Expected UI |
| --- | --- | --- | --- |
| VP `betNSettle` | bet + win (incl. 0) | none | final at first row |
| 1UP `bets/result` | bet + win (incl. 0) | none | final at first row |
| GGSoft `EndRound` | bet + cumulative win (incl. 0) | none | final at first row |
| AFB `payout` | bet + win-of-this-batch (incl. 0) | later batch with higher cumulative win | provisional → corrected |
| IDG `bet` → `win` | bet only (win nil) | `win` with cumulative total (incl. 0) | `-` (pending) → final |
| Sigma | bet only, never captured | none | `-` forever (today `+0`) |

## Design (D1–D4 CONFIRMED by operator 2026-09-09 as proposed; backfill window = since 2026-08-01 on staging)

**D1. Keep `round.settled` and `turnover.settled` exactly as they are.**
Timing, ids, and payload of both stay untouched. Missions' round-count and
turnover rails do not change. Do NOT delay `round.settled` until the outcome is
final: finality differs per provider and IDG round-count progress would be
delayed or lost.

**D2. Additive presence on the event.** Add `WinAmount *float64
json:"win_amount,omitempty"` to `events.PlayerActivityEvent` (same pattern as
`BalanceAfter`). Game sets it whenever `lifecycle.WinAmount != nil`. W/L is
present ⇔ `WinAmount != nil`. Legacy rows without the field: treat
`win_loss_amount != 0` as present, `0` as unknown (a legacy true draw becomes
`-`; accepted, truthful).

**D3. New corrective event type `round.outcome_updated`** (name final at
api-contract-review). Published by Game ONLY when the upsert returned
`inserted=false` AND the stored `win_amount` changed (nil→value or
value→higher). Event id is value-deterministic so redelivery is a no-op:
`player-activity:round:<round>:round.outcome_updated:<win %.4f>`. Payload:
`BetAmount`, `WinAmount` (D2), `WinLossAmount`, `RoundCount=0`,
`SourceReferenceID=<round>`. No Game schema change. Game must publish it AFTER
the existing turnover/round publishes so a failure cannot regress today's flow.
- Missions: `validateSupportedPlayerActivityEvent` returns
  `ErrNonRetryablePlayerActivity` for unknown types → consumer ACKs and drops.
  Verified in source; needs a regression test so nobody later "fixes" it into a
  requeue loop. Missions gets NO progress from this event (RoundCount 0 anyway).
- Old Logs receiving the new type before its deploy: inserts a raw row of an
  unlisted type; gameplay list and the daily MV filter on `round.*` so it is
  invisible and harmless.

**D4. Logs projection = per-round latest state (absolute values), not deltas.**
Recommended over a Game-supplied delta because (a) the admission gate is
per-event-id, not per-round, so Logs-computed deltas can race, and (b) a
delta contract cannot backfill the already-wrong historical rows. Shape:
- Keep the raw `monitoring_player_events` insert for every event (audit).
- Add a `monitoring_round_outcomes` `ReplacingMergeTree(version)` keyed by
  `(source_reference_id)` with `user_id, game_id, game_type, currency,
  occurred_at, bet_amount, win_amount Nullable, win_loss Nullable, reversed
  UInt8`; version = `win_amount` for outcome rows (monotonic by construction),
  reversal sets `reversed=1` with a version above any win.
- Gameplay list: still one row per `round.settled`, but `win_loss_amount` is
  read from `monitoring_round_outcomes` (FINAL / argMax) by round id; absent
  win → field unset.
- Game report: sum `turnover / win_amount / win_loss / round_count` from
  `monitoring_round_outcomes` where `reversed=0` instead of the
  `monitoring_game_player_daily` SummingMergeTree. Keep the old table+MV in
  place (do not drop) until the new numbers are reconciled on staging; remove
  in a follow-up.
- Backfill: a one-off Game admin/CLI that republishes `round.outcome_updated`
  for `round_lifecycles` with `win_amount IS NOT NULL` since a date. Because
  D4 is absolute + versioned, replaying is idempotent. Operator decides the
  window (default: since 2026-08-01, when win capture went live on staging).
  Alternative if D4 is rejected: Game adds `previous_win_amount` via a CTE in
  the upsert and Logs extends the summing MV with a `win_loss_delta` column;
  this needs a DROP+CREATE of the MV in a boot-idempotent way and cannot
  backfill.

**D5. Proto presence.** `GameplayLogDetail.win_loss_amount` → `optional double
win_loss_amount = 6` (same field number; proto3 optional is wire-compatible).
Logs sets it only when W/L is present. grpc-gateway/protojson omits unset
explicit-presence fields even with `EmitUnpopulated`, so Backoffice's
`parseFiniteNumber(undefined)` already yields `-`. Gateway needs the shared-lib
bump for the JSON to change — prove by grepping the raw response body.

## Sequence (staging)
1. shared-lib PR: D2 field + D5 proto; publish; note the tag/sha.
2. Logs PR: consume `round.outcome_updated`, `monitoring_round_outcomes`,
   read-side override, DTO presence, tests (see Acceptance). Deploy first so it
   is ready before corrections flow.
3. api-gateway PR: shared-lib bump only. Deploy. Grep raw JSON: pending row has
   no `winLossAmount` key.
4. Game PR: D2 + D3 publish, tests. Deploy last.
5. Missions PR: regression test only (ACK-drop of unknown type). No deploy
   needed if the test passes on current code.
6. Backfill decision + run (D4).
Rollback: each step is additive; revert the PR. Old Logs ignores the new type;
old Game never emits it. No Postgres migration expected in any service. The
ClickHouse table is `CREATE IF NOT EXISTS` (idempotent, matches existing
pattern).

## Acceptance (staging, authenticated API payload + visible Backoffice row)
- [ ] AFB bet 240 / win 0 (single callback) → one row, `-240`
- [ ] AFB bet 200 / win 0 then win 100 → one row, `-100`; `total_rounds` 1
- [ ] IDG bet 20000 before result → one row, W/L `-` (no `winLossAmount` key in JSON), never `+0`
- [ ] IDG then win 0 → same row `-20000`
- [ ] Bet 240 / final win 720 → `+480`
- [ ] Sigma round → `-`, not `+0`
- [ ] Redelivery of `round.settled`, `round.outcome_updated`, `round.reversed` (each ×2) → no duplicate row, `total_rounds`, turnover, win, W/L, or RTP change
- [ ] `round.reversed` after a correction → report nets to 0 for that round
- [ ] Missions: new event type ACKed, no `daily_activity_progress` row, no requeue (test + staging log line)
- [ ] `turnover.settled` id/payload/timing byte-identical (golden test in Game)
- [ ] VP / 1UP / GGSoft focused tests unchanged and green
- [ ] Game report totals before/after on staging reconciled and explained
- [ ] Backfill run (if approved) corrects rounds `654b35c9…`, `fa48e575…`, `50843b2e…`, and the tester rounds of 2026-09-09 16:12 Bangkok: `31fe9bec…` (AFB bet 450, win 2925 in the second payout callback, UI stuck at `-450`, truth `+2475`) and `e72d068b…` (bet 500, win 125, truth `-375`); Logs logged `redelivery ignored` for both

## Gates before editing
`api-contract-review`, `change-impact-analysis`, `minimal-change-review`,
`verification-loop`; test-integrity rule (RED before GREEN for every acceptance
row that is unit-testable).

## Evidence (audit 2026-09-09)
- Branches: Provider `task/TASK-EAR-266` (unrelated, do NOT use), Game
  `staging` @ 61d1c4a, Logs `staging` @ c304b31 (PR #25 one-row-per-round),
  shared-lib `main` @ 133a4ff, backoffice `main` @ cc4352e. All clean.
- Staging CloudWatch re-read for round `50843b2e-…` in
  `/ecs/games-labs-{provider,game,logs}-staging` — see Problem.
- Source anchors: `gamesvc/player_activity.go:136` (stable id),
  `repositories/game.go:1620-1628` (monotonic upsert), `service.go:~407`
  (republish on duplicate), `monitoring/ingest.go:42-50` + `postgres_admissions.go:29-33`
  (completed = permanent), `monitoring_clickhouse.go:143-155` (MV filters
  `round.*`), `monitoringhdl/grpc.go:235` (DTO), `mission_service.go:2429`
  (unknown type → non-retryable), `api-gateway/gateway/grpc.go:67` (default
  marshaler).

## Side finding (not in scope — chip raised)
Logs drops every `mission.progressed` monitoring event whose id exceeds 128
chars (`player-activity:missions:progress:<source event id>:<mission id>` is
~150). Staging 08:41 UTC shows 6 drops for this one round. Monitoring Daily
therefore misses progress rows for game-turnover-sourced missions.
