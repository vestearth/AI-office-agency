# TASK-EAR-344: Player Log gameplay Turnover column = Bet (SettledAmount)

## Type
feature

## Workstream
frontend

## Priority
medium

## Created
2026-09-09

## Parent
TASK-EAR-342 (gameplay W/L overlay). Operator confirmed Bet and Turnover are
the same numeric value from `round_lifecycles.settled_amount`, copied into
different event fields (`bet_amount` on `round.settled` vs `settled_amount` on
`turnover.settled`). This page lists `round.settled` only, so the row already
carries Bet and must show Turnover as that same number.

## Goal
`/admin/monitoring/player-log/gameplay` Turnover column displays the same
formatted value as Bet. VIP Level and THB W/L stay `-`.

## Scope
In:
- `Games-Labs-backoffice` Player Log gameplay mapper + focused test

Out:
- Proto / Logs / Game / api-gateway
- VIP at settle
- THB W/L / FX
- `Games-Lab-Android/`

## Acceptance criteria
- Turnover uses `gameplay.betAmount` (dash when absent, including no fabricated 0)
- Bet and Turnover match for a present amount
- VIP Level and THB W/L remain hardcoded dash
- Focused test was RED then GREEN
