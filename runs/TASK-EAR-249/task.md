# TASK-EAR-249 — Launch gate is skipped when a game is addressed by its provider code

Spun out of `TASK-EAR-247` T3 verification. Two findings, one defect and one
clean bill of health.

## Defect — level and status checks bypassed (fixed, PR 29)

`game_id` on `POST /api/v1/game/launch` accepts **two** forms:

- the platform UUID (`019cadd7-…`), and
- the **provider's own game code** (`ht-crazyvault`) — the provider services
  consume the value directly (`GameCode: p.GameID` for vp; ggsoft runs
  `strconv.Atoi` on it), and the public game list publishes it as
  `provider_game_id`.

The gate only ever parsed a UUID:

```go
gid, err := uuid.Parse(req.GameID)
if err == nil { /* look up, check status, set requiredLevel */ }
```

A non-UUID left `requiredLevel` at 0, and the gate is
`if !req.IsDemo && requiredLevel > 0`, so **both the level check and the
active-status check were skipped**.

Proven on staging 2026-08-11: player `13cf8635` at level 12, launching the
level-24 game *Crazy Vault* — refused with 4009 as `019cadd7-…`, reached the
provider as `ht-crazyvault`. Deterministic, unlike the read-failure fail-open
closed earlier in `Games-Labs-Game` PR 26.

### Change

- Resolution goes through `resolveGameForRound`, the resolver settle already
  uses: UUID → `GetByID`, otherwise provider code + `provider_game_id` →
  `GetByProviderGameID`. Unresolvable → `ErrNotFound`, so both addressing forms
  fail closed.
- The Level Access grant check compares the **resolved platform id**. Grants
  list platform ids, so without this a pass restricted to specific games would
  silently stop matching whenever the caller used a provider code.

### Acceptance

1. An under-level player addressing a gated game by provider code is refused,
   and the provider adapter is never called.
2. A player above the level still launches by either addressing form.
3. An unknown provider game code is refused rather than forwarded.
4. A Level Access grant restricted to a game still unlocks it when the caller
   addresses that game by provider code.

Tests for 1-4 were seen failing on pre-change code where applicable.

### Deploy note

This changes behaviour for any client that has been launching **gated** games
by provider code — those launches now respect the level requirement, which is
the point. Ungated games are unaffected.

## Not a defect — duplicate `turnover.settled` deliveries

The operator observed each `round_id` producing two
`[EXP-FLOW][game] ApplyGameplayTurnover sync` lines ~160-250ms apart
(rounds `bb6209e3`, `f4be856a`, `c8cdd820`). Traced end to end; the chain is
safe by design and needs no change:

- **Origin.** vp calls `TrySettleRound` exactly once per `betnsettle` callback
  (`vp/seamless.go:122`), so two lines mean the provider delivered the same
  callback twice — ordinary seamless retry behaviour.
- **Stable identity.** `vpBetNSettleRoundID` is derived only from callback
  fields (`RoundID`, else `BetID`), with no timestamp or randomness, so a retry
  carries the same `round_id` and therefore the same
  `turnoverSettledEventID(round_id)`.
- **Round row.** `UpsertRoundSettlement` returns `inserted=false` on the retry;
  no second row.
- **EXP.** `ApplyTurnoverExp` checks applied → `TryClaimTurnoverExpEvent`
  (`INSERT … ON CONFLICT (event_id) DO NOTHING`) → `AddTurnover` →
  `MarkTurnoverExpApplied`, and **releases the claim** if `AddTurnover` fails,
  so a crash between claim and apply does not strand the event.

Game re-runs the rail on a duplicate settle deliberately — the code says so —
because if the first attempt failed *after* the row was inserted, the retry is
what saves the EXP. The only cost is one redundant cross-service call per
retry, which is the price of that protection.

**Operator confirmation available without DB access:** the Missions log group
should show `[EXP-FLOW][missions] AddTurnover skipped duplicate event_id=…` for
the second delivery of those rounds.

## Scope

- Included: `Games-Labs-Game` — launch gate resolution plus tests.
- Excluded: provider retry behaviour (correct as-is), and any change to the
  deliberate republish-on-retry design.
