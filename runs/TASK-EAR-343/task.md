# TASK-EAR-343 — Logs drops nested mission.progressed monitoring events

## Runtime acceptance update (2026-09-16)

The staging runtime gate is now satisfied. A read-only query against the
staging ClickHouse `gameslabs.monitoring_player_events` table found 41
`mission.progressed` rows after the migration-006 boot; all 41 event ids were
longer than the former 128-character cap, with a maximum length of 159
(`ev-005`).

Production ClickHouse is explicitly configured on Logs. The required full
Monitoring dependency train merged to `prod` in PR #34 (`cd056505`) and Deploy
PROD run `35053685057` succeeded. ECS now has task definition `:12`, image
`prod-sha-cd05650`, rollout `COMPLETED`, and desired/running `0`. That is a
registered parked release: under the cost gate, no production task or RDS was
started, so migration 006's first prod boot remains intentionally unobserved.

## Symptom

`Games-Labs-Logs` silently loses Monitoring Daily progress rows for
game-turnover-sourced and wallet-spend-sourced missions. The events are nacked
without requeue, so nothing retries and nothing alerts.

Staging `/ecs/games-labs-logs-staging`, 14-day census (10 drops), longest 159
chars, all `missions:progress`:

```
player-activity:missions:progress:player-activity:game-turnover:31fe9bec-e649-4455-b588-b835df1dd5cb:turnover.settled:weekly-sched-2026-09-07-category_turnover
player-activity:missions:progress:player-activity:wallet:e755ff7d-d6e3-4db4-af38-f60bba8b3da5:spend.settled:weekly-sched-2026-09-07-spend_prop
```

## Mechanism

- `Games-Labs-Missions/internal/services/player_activity.go:86`
  `missionProgressEventID` builds its id by nesting the **entire** source event
  id, which is itself namespaced (`player-activity:game-turnover:<uuid>:<type>`).
- `Games-Labs-Logs/internal/monitoring/postgres_admissions.go:13`
  `AdmissionEventIDMaxLen = 128` matched
  `monitoring_event_admissions.event_id VARCHAR(128)` (migration 005).
- `Games-Labs-Logs/infrastructures/player_activity_consumer.go:72` drops any id
  past that cap with `Nack(false, false)`.

The cap was added to stop a SQLSTATE 22001 requeue spin. It stopped the spin and
converted it into silent data loss.

## Decision — widen the admission column, do not hash the Missions id

Chosen: widen `monitoring_event_admissions.event_id` to `VARCHAR(512)` and raise
`AdmissionEventIDMaxLen` to match.

- ClickHouse `monitoring_player_events.event_id` is an unbounded `String`
  (`infrastructures/monitoring_clickhouse.go:66`). PostgreSQL was the **only**
  limit, so widening needs no downstream or contract change.
- One repo, one idempotent migration, no shared-lib bump, no gateway bump.
- The readable id stays readable. It is the correlation key the TASK-EAR-342
  staging audit relied on, and it feeds `reverse_of_event_id`.

Rejected: hashing or shortening the id in Missions.

- It is a contract change on a **dedupe key**. Already-published events keep the
  long form, so an in-flight redelivery after deploy would hash to a new key,
  clear admission, and re-project a duplicate ClickHouse row.
- It needs a shared-lib note and a Missions deploy, and still leaves Logs
  narrow for any other producer that ever nests an id.
- It destroys operator-readable correlation for no gain.

The fail-closed drop stays: an id past the column width still nacks without
requeue, because 22001 cannot succeed on retry.

## Scope

`Games-Labs-Logs` only. Branch `fix/TASK-EAR-343-admission-event-id-width` off
`origin/staging`. The read-only Android reference repo is untouched.

## Acceptance

1. RED first: the verbatim 159-char staging id is dropped before the fix.
2. After the fix that id is admitted and projected exactly once.
3. Migration 006 is idempotent across repeated boots and burns no
   `pg_attribute` slots (Logs replays every migration on every boot).
4. On staging, a fresh turnover event yields `mission.progressed` rows in
   ClickHouse `monitoring_player_events`.

## Replay decision and closure (2026-09-16)

The corrected paginated census found 339 (not the earlier first-page count of
10) staging-only Monitoring projections dropped before the widening. Operator
decision: **do not replay**. The messages were nacked without requeue, Missions
has no republish path, and reconstructing them from current mission state would
fabricate a historical progress snapshot. The loss affects the monitoring read
model only; it does not change wallet balances or mission state.

TASK-EAR-343 is closed with source/tests, staging runtime acceptance, the prod
release, and this no-replay decision. A future operator-approved first prod boot
should independently confirm migration 006 applied; it is outside this closeout
because production compute and RDS remain cost-gated.
