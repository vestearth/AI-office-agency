# TASK-EAR-090: Make POINT a real payable reward currency (Wallet credit + Backoffice mappers)

## Short Name

`point-reward-currency-end-to-end`

## Type

feature (money path)

## Priority

high

## Parent / Epic

- Epic: Missions admin manage / reward currency
- Sibling: TASK-EAR-088 (overview already emits `currency` incl. POINT), TASK-EAR-089
- Origin: operator review 2026-07-09 — every mission currency dropdown offers
  "Point" but it never worked end-to-end. Operator decision: make POINT a real,
  third payable currency (parallel to COIN/DIAMOND).

## Background — source-verified

- **Missions already forwards currency verbatim** to `POST /wallets/credit` on
  every claim (daily `mission_service.go:274`, bonus
  `mission_service_daily_completion.go:223`, group
  `mission_service_daily_groups.go:166`, weekly `weekly_service.go:275,312`,
  event `event_service.go:395`). No Missions change is required.
- **Wallet rejects POINT** at HTTP 400 on both the handler
  (`internal/core/handlers/wallethdl/wallet_handler.go:163`) and service
  (`internal/core/services/walletsvc/service.go:131`) —
  `currency must be coin or diamond`. Wallet's models define only
  `CurrencyCoin`/`CurrencyDiamond`/`CurrencyTHB` (`internal/models/wallet.go:6-10`);
  there is **no `CurrencyPoint`** for the credit path.
- **Wallet DOES have a `Points` balance** (`internal/models/wallet.go:18`) with a
  dedicated points subsystem: `AwardPoints`/`CreditPoints`/`AddPoints`/
  `RedeemPoints`/`RefundPoints` + point history (`service.go:446-523`,
  `ports/services.go:21-25`) — separate from the COIN/DIAMOND transaction ledger
  written by `ApplyTransaction`.
- **FE silently downgrades POINT→COIN on save**: `toApiCurrency`
  (`daily/edit/[id].vue:76`) is binary (non-DIAMOND→COIN), and `subRewardUnit`
  is `'coin' | 'diamond'` (mock.ts) so `unitFromCurrency`/`currencyFromUnit`
  (`MissionPlanPeriodEditor.vue:127-132`) can't carry POINT. Same binary
  mappers repeat across weekly/monthly/event/defaults editors.

## Scope — two lanes

### Lane A — Wallet backend (branch `feature/TASK-EAR-090-wallet-point-currency`, from staging)

Make `POST /wallets/credit` accept `currency:"POINT"` and credit the user's
**existing `Points` balance by reusing the points subsystem** (so balance +
point history stay the single source of truth for the level/EXP system) — do
NOT bolt a new points column onto `ApplyTransaction`.

- Add `CurrencyPoint = "POINT"` to `internal/models/wallet.go`.
- Allow POINT past `normalizeWalletCurrency` (`wallet_handler.go:34`) and both
  guards (`wallet_handler.go:163`, `service.go:131`).
- In `service.Credit`, when `currency == POINT`, route to the points-credit path
  (`repo.CreditPoints`/`AddPoints` with the same idempotency key + source/reason)
  instead of `ApplyTransaction`; return a result carrying the new points balance
  and publish an appropriate WalletEvent (points credited) if events are wired.
  Keep COIN/DIAMOND behavior byte-for-byte unchanged.
- Debit/spend of POINT is OUT OF SCOPE (rewards are credits; spending already
  exists via RedeemPoints).
- Surface (do not silently resolve) any ledger-coherence concern you find — e.g.
  whether a POINT credit must appear in `ListPointHistory` — and pick the option
  that keeps the points balance consistent with how it is read elsewhere.

### Lane B — Backoffice FE (branch `feature/TASK-EAR-090-point-currency-fe`, from main)

Stop the POINT→COIN downgrade so a reward set to Point round-trips as POINT
across ALL mission editors.

- Widen the internal reward-unit representation to include `point`
  (`subRewardUnit` in mock.ts and everywhere it is consumed), or carry the full
  DailyMissionCurrency through instead of the binary unit.
- Fix every currency mapper to be 3-way (COIN/DIAMOND/POINT) both directions:
  `toApiCurrency`/`toRewardUnit`/`toBonusCurrency`/`unitFromCurrency`/
  `currencyFromUnit` and any per-page equivalents in daily/weekly/monthly/event
  edit pages + their period editors + default-template forms. Grep exhaustively.
- Update `RewardBadge` (and any reward-unit display) to render a Point unit.
- No backend contract change from the FE side — the payload key stays
  `reward.currency` (now able to hold `"POINT"`).

## Out of Scope

- Missions service code (already POINT-ready).
- POINT debit/spend paths.
- The game-picker work (TASK-EAR-089).

## Acceptance Criteria

1. `POST /wallets/credit` with `currency:"POINT"` succeeds and increments the
   user's Points balance; COIN/DIAMOND behavior unchanged; idempotency honored.
2. A mission reward configured as Point is saved as `currency:"POINT"` (not
   downgraded) from every mission editor and reloads as Point.
3. Claiming a POINT reward credits points end-to-end (Missions→Wallet) with no
   400.
4. `go build/vet/test ./...` green on Wallet; backoffice `node --test` + `nuxt
   build` green.
5. Points balance stays coherent with the level/EXP system's reads (no divergent
   double-ledger).
