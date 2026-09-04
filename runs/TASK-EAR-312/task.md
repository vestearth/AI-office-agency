# TASK-EAR-312 — Exchange without turnover progression

## Approved scope

User decision 2026-09-03: Diamond-to-Coin exchange must stop earning turnover.
Keep all previously earned EXP, levels, progress and rewards; no historical
clawback. Preserve Mission Boost packages, owned passes, benefits, configuration
and claim flow. New exchanges no longer contribute turnover to that flow.

Implementation is limited to Games-Labs-Order and Games-Labs-Missions.
No Wallet, User, gateway, shared-lib, Android, schema or dependency changes.
No direct AddTurnover API hardening. On 2026-09-03 the user approved staging
deployment, including the normal commit/push/PR release workflow, superseding
the original local-only boundary. Production is excluded. Team Tester owns
authenticated real-system business acceptance; do not execute live exchanges.

## Acceptance criteria

- Tier/custom exchange, retries and failed-order recovery still move the same
  authoritative amounts and preserve fulfillment and idempotency.
- Order emits no exchange turnover forward or reversal events.
- Missions ignores queued/replayed legacy Order turnover forward/reversal events
  before EXP, daily/weekly progress and turnover-application ledger writes.
- Gameplay forward/reversal events and Order purchase/spend events remain eligible.
- No historical data is deleted/recomputed; Mission Boost/pass behavior is unchanged
  apart from the removal of new exchange turnover input.
- Regression tests demonstrate failures before the fix and pass after it;
  run tests/build/vet in both owning repositories.

## Implementation / rollout boundary

Preserve exchange settlement metadata while retiring its event publishers.
Reuse the existing Missions player-activity skip guard at MQ and direct matcher
entry points. Deploy Missions before Order when separately authorized so queued
legacy events cannot accrue new progression. Existing credited ledger entries
remain untouched, including today's Mission Boost eligibility.

## Verification

Evidence is recorded with scripts/record-evidence.sh under this task.
Local code verification is not staging/production runtime acceptance.
