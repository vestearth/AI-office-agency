# TASK-EAR-014 — Monthly check-in bar: consecutive metric (Option 2), single-source from ledgers

## Why

The Quest → Monthly "Consecutive Check-In Bonus" screen stacks two values that
are computed from **different counters**, which reads as a bug:

- **Milestone markers D3/D7/D15/D31** — from
  `GET /api/v1/missions/check-in/calendar` → `milestones[].status`. After
  TASK-EAR-013 these use a **rolling streak** (best streak this month via
  `maxCheckInStreak` over ledgers).
- **The "X/30" bar + "Collect Bonus Reward"** — from
  `GET /api/v1/quest/overview` → `bonus_reward { current, total }`, where
  `current = MonthlyChallenge.LoginsCount` is a **cumulative** count of distinct
  check-in days (`internal/services/quest_overview_service.go:185`,
  `internal/services/mission_service.go:620`).

So the bar can sit past the D7 marker (11 cumulative) while D7 is unlit (best
streak 6) — the "11/30 looks wrong" report. PO decision: **Option 2 —
consecutive metric everywhere**.

## Key finding: this is display-only, NOT an economy change

`MonthlyChallenge.IsCompleted = LoginsCount >= TotalDays`
(`mission_service.go:628`) and past days cannot be backfilled except via Restore.
Therefore `LoginsCount` reaches `TotalDays` **iff** the user checked in every day,
which is exactly a full consecutive month. The point at which "Collect Bonus
Reward" becomes claimable is **identical** under cumulative and consecutive
models; only the **mid-month bar value** changes (cumulative count → streak).
No change to the monthly-bonus payout, claim gating, or diamond/coin economy.

## Decision / approach (to confirm before build)

Make `quest/overview` `bonus_reward.current` show the **best rolling streak**,
derived from the **same source as the milestone markers (the day ledgers)**, so
the bar and markers can never drift. Concretely:

- `bonus_reward.current = maxCheckInStreak(ledgers, month, totalDays)`
  (reuse the EAR-013 helper; do NOT use `UserStreak.CurrentStreak`, which is the
  *current* streak and would still mismatch the best-streak markers).
- `bonus_reward.total = totalDays` (unchanged).
- `bonus_reward.claimable` unchanged (still `IsCompleted && !RewardClaimed`,
  i.e. full consecutive month).

Open architectural point: the overview path (`QuestOverviewService.GetOverview`
→ `progressSource.GetProgress`) is built from in-memory/persisted
`MonthlyChallenge` + `UserStreak`, **not** ledgers. Deriving best streak there
needs the ledgers loaded into the overview path (or a `BestStreak` maintained on
`MonthlyChallenge`). Prefer ledger-derivation (single source of truth) over a new
incrementally-maintained counter, which would risk drifting from the calendar.
Also review `buildMonthlyTab` (`quest_overview_service.go:389,397`) which renders
`LoginsCount` as `Current`/`TodayIndex` for the same consistency.

## Scope

- IN: `Games-Labs-Missions` quest-overview `bonus_reward` (and monthly tab)
  progress value → best streak from ledgers.
- OUT: monthly-bonus claim/payout (unchanged); mobile (binds the same
  `bonus_reward` fields — no client change); milestone calendar logic (done in
  EAR-013).

## Acceptance criteria (draft)

- AC1: For a user with best streak 6 but 11 cumulative check-ins, the bar shows
  `6/30` (consistent with the markers — D7 unlit), not `11/30`.
- AC2: "Collect Bonus Reward" claimability is unchanged vs current behavior
  (claimable only at a full consecutive month).
- AC3: Bar value and `milestones[].status` are derived from the same ledger
  source and cannot disagree.
- AC4: Mobile requires no code change (same `bonus_reward.current/total` fields).
- AC5: `GOWORK=off go test ./...` green.

## Risk / notes

- Perception: after deploy the mid-month bar value drops (e.g. 11 → 6). Comms
  note for product; the value is now correct/consistent, not a regression.
- Best aligned with the upcoming **mission backoffice** discussion (check-in
  config + data model) — confirm the ledger-derivation approach there before
  building to avoid reworking the overview data path twice.

## Provenance

Claude advisory lane (pm role). Draft / not implemented. Awaiting product +
backoffice alignment. Draft until a human operator normalizes state and runs
`ruby ai-dev-office/validate-yaml.rb TASK-EAR-014`.
