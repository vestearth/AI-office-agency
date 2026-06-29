# TASK-EAR-013 — Missions: Consecutive Check-In should be a rolling streak (+ fix D31-in-short-month)

## Symptom (operator/QA, from screenshot)

Monthly "Consecutive Check-In Bonus" with milestone rewards D3 / D7 / D15 / D31.
UI progress bar shows `11/30`, yet milestones D7 / D15 / D31 stay locked and D31
never moves. Operator suspects the counting logic is wrong.

## Root cause (confirmed in code)

`Games-Labs-Missions/internal/services/check_in_calendar_service.go`

1. **Permanent-break model, not a rolling streak.** `GetCheckInCalendar`
   (lines 124-193) counts an unbroken run from day 1 via `consecutive` +
   `brokenStarted`. The first missed day sets `brokenStarted = true`, which
   never resets, so no later check-in increments the counter for the rest of
   the month. Milestones unlock via `consecutive >= ms.Day` (line 184).
   Result: one missed day permanently locks D7/D15/D31 for the whole month
   (unless Restore is purchased).
2. **Claim guard mirrors the bug.** `ClaimCheckInMilestone` (line 257) calls
   `consecutiveCheckInDays` (line 570), which `break`s at the first gap — same
   from-day-1 semantics. Must stay consistent with the display.
3. **Duplicate logic.** `deriveCalendarDaysForQuote` (lines 621-654) carries a
   second copy of the `broken` walk for restore quotes.
4. **Progress bar mismatch (frontend, separate repo).** Backend returns no
   progress integer; the `11/30` bar is computed client-side from `days[]` and
   appears to count TOTAL completed days, diverging from the consecutive value
   the milestones use — the visible inconsistency.
5. **D31 unreachable in short months.** `defaultCheckInConfig` (lines 27-41)
   hardcodes `Day: 31`. June has 30 days, so even perfect attendance caps the
   streak at 30 < 31 and D31 can never unlock (worse in February). Independent
   of the streak model.

## Decision (PO)

Counting model = **rolling streak**: a missed day resets the running streak to
zero and it rebuilds; a milestone D_N unlocks when the best streak achieved in
the month reaches N. Top milestone is clamped to the month length so D31 is
reachable in 30/29/28-day months.

## Scope

- IN: `Games-Labs-Missions` check-in calendar service — streak computation,
  milestone eligibility, claim guard, restore-quote day walk, D31 clamp, tests.
- OUT (separate tickets): mobile/frontend `X/30` progress bar alignment;
  restore-economy review (every gap is now a `missed` restorable day — see
  Impact); any data migration (none required — values are computed, not stored).

## Plan

1. Add pure helper `maxCheckInStreak(ledgers, month, totalDays)` = longest run
   of consecutive checked-in dates (missed day → run resets to 0, track max).
2. Add pure helper `effectiveMilestoneThreshold(day, totalDays)` =
   `min(day, totalDays)` so D31 clamps to the month length.
3. `GetCheckInCalendar`: drop `consecutive`/`brokenStarted`; compute
   `maxStreak` once; milestone claimable when
   `maxStreak >= effectiveMilestoneThreshold(ms.Day, totalDays)`. Every past
   un-checked day becomes `missed` (restorable) — `broken` status retired.
4. `ClaimCheckInMilestone` guard: use the same two helpers instead of
   `consecutiveCheckInDays` (which is removed).
5. `deriveCalendarDaysForQuote`: drop the `broken` walk; past gaps → `missed`.

## Acceptance criteria

- AC1: With days 1-7 checked, day 8 missed, days 9-12 checked (today=12), D7 is
  `claimable` (best streak 7) even though the current run is 4.
- AC2: A milestone above the month length (D31 in a 30-day month) becomes
  claimable at a full-month streak (30), not impossible.
- AC3: `ClaimCheckInMilestone` accepts a claim exactly when the display marks it
  claimable (guard and display agree).
- AC4: Every missed past day exposes `canRestore` (no permanently `broken`
  cells); restore quote still offers the earliest missed day.
- AC5: `GOWORK=off go test ./...` green across the module.
- AC6: Restore still targets the earliest missed day first; only that day is
  flagged `canRestore` (calendar never advertises a restore the backend won't
  honor). Later gaps are `missed` but not individually restorable.

## Impact / risk

- Restore sink grows: under the old model only the first gap was restorable;
  now every gap is. Consistent with TASK-EAR-012 (unlimited restores) but flag
  to PO for diamond-economy awareness.
- No DB migration: streak is derived at read time.
- Mobile must switch the `X/30` bar to the current/best streak — filed
  separately; backend change alone leaves the bar cosmetically wrong until then.

## Provenance

Claude advisory lane (dev role). Draft until a human operator normalizes state
and runs `ruby ai-dev-office/validate-yaml.rb TASK-EAR-013`.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: `Games-Labs-Missions/internal/services/check_in_calendar_service.go`
  and `internal/services/check_in_streak_test.go`.
- Verdict: approved; no blocking findings.
- Verification: `GOWORK=off go test ./...`, `go vet ./internal/...`, and
  `GOWORK=off go build -mod=readonly ./...` passed in `Games-Labs-Missions`.
