# TASK-EAR-383 — Exact Mission Weekly Report summary

## Origin

On 2026-10-01 the operator asked to populate the three Mission Weekly Report
header cards. The operator defined Completed / Participants as distinct people:
within a plan Completed means every activity complete; across selected plans a
person counts once as Participant and once as Completed if they completed at
least one plan. TASK-EAR-291 records this definition but has Backoffice-only
scope. The previous shared-lib publication covers plan-player detail, not this
summary.

## Scope

- `shared-lib`: additive, staff-only weekly report summary contract and generated
  Go, grpc-gateway, and OpenAPI artifacts.
- `Games-Labs-Missions`: query exact plan and cross-plan distinct counts from
  progress/claim data; sum claimed reward and bonus snapshots by currency,
  recording plan attribution at claim time where needed.
- `api-gateway`: adopt the published contract and expose the read route.
- `Games-Labs-backoffice`: bind the three cards and per-plan Completed /
  Participants cells to returned figures, preserving the existing UI and
  unavailable/partial-data behavior.
- `ai-dev-office`: task evidence and closeout.

Logs and Android are out of scope. Production compute/RDS remains parked.

## Acceptance

1. The summary accepts the full set of selected weekly plan IDs, not just the
   current frontend page. Duplicate IDs do not duplicate people or claims.
2. Per-plan Participants are distinct players with progress or claim on any
   member activity. Per-plan Completed are those who completed every member.
   Across plans, each participant counts once, and a person who completed at
   least one selected plan counts once as Completed.
3. Reward and bonus claimed totals use actual claim snapshots, grouped by
   currency. Configured reward multiplied by people is never used. Missing or
   ambiguous historical plan attribution makes the affected total unavailable
   or explicitly partial, never a fabricated zero.
4. Cards and plan rows show `-` when data is unavailable, and do not label
   COIN as POINT. Empty, known complete data may show zero.
5. Focused tests cover overlapping people, all-activity completion, duplicate
   plan IDs, partial claim coverage, currencies, and empty plans. Staging API
   and authenticated Backoffice reads reconcile with claim ledgers before
   runtime acceptance.

## Dependency gate

Prepare and verify `shared-lib` contract first. Per root AGENTS.md, stop
downstream service and gateway edits until the new contract is published and
the consumers can bump it. The previously published `4066910` plan-player
contract does not satisfy this summary API.

## Contract checkpoint — 2026-10-01

The additive contract was committed in shared-lib as `4bcb80c` and merged as
[PR #85](https://github.com/SparqLab/shared-lib/pull/85) into verified target
`main` at `8868d5e35cff2d15a7efd51d8f88d63525dff6f5`. The new staff-only
GET route accepts repeated `planIds` query values
for the complete selected plan set. It returns per-plan people counts,
distinct people across the selection, and claimed reward/bonus amounts by
currency. People and claim totals have separate completeness flags so an
ambiguous historical claim cannot be displayed as a known zero.

Generated Go, grpc-gateway, OpenAPI JSON, and Swagger Go artifacts are included.
The Buf FILE breaking check against `main`, `GOWORK=off GOFLAGS=-mod=readonly
go test ./...`, and `git diff --check` passed in shared-lib. PR #85 was OPEN
and MERGEABLE when first checked, then merged at 2026-10-01T03:50:32Z. No
downstream implementation or staging runtime check is claimed. Missions and
api-gateway still pin the earlier `v0.0.0-20260930091000-4066910ded9d` when
checked after the merge. Publish the merged shared-lib version and bump both
consumers before implementation, then wire Backoffice.

The merged commit resolves through Go modules as
`v0.0.0-20261001035032-8868d5e35cff`. The operator authorized completing
the consumer bumps. Missions and gateway now pin this version in both
`go.mod` and `go.sum`, without a local replacement.

## Implementation checkpoint — 2026-10-01

- [Missions PR #134](https://github.com/SparqLab/Games-Labs-Missions/pull/134)
  targets verified `staging` at `ed029fc`. It adds distinct plan/cross-plan
  people counts, currency-preserving claim sums, and additive, idempotent
  `056_weekly_claim_plan_attribution.sql`. New claims stamp an active plan;
  historical rows remain unattributed and cause an incomplete claim total.
- [gateway PR #81](https://github.com/SparqLab/api-gateway/pull/81) targets
  verified `staging` at `54d25e9`. Generated grpc-gateway registration
  exposes the route, and a test covers repeated `planIds` query values.
- [Backoffice PR #163](https://github.com/SparqLab/Games-Labs-backoffice/pull/163)
  targets verified `main` at `1fdcd19`. The Weekly tab requests the selected
  plan set, shows exact people counts and currency-aware claim totals, and
  leaves incomplete figures as `-` with a reason.

Missions and gateway passed full `GOWORK=off GOFLAGS=-mod=readonly go test ./...`
and readonly builds. Backoffice passed `npm test` (712 tests) and `npm run build`.
The task evidence ledger records the repeated post-commit full tests as
`ev-001` (Missions), `ev-002` (gateway), and `ev-003` (Backoffice); each exited 0
against the PR commit.
The migration replay integration test passed on temporary PostgreSQL 16.
The actual people query returned the expected three plan/person rows for
overlapping players across two plans, including a claim-completed activity.
Fresh-schema drift testing applied migration 056, then failed on the existing
`mission_plan_players.go` CTE extraction (`relation "scores" does not exist`);
this is a harness limitation, not proof of a migration defect. Nuxt typecheck
could not run because fetched `vue-tsc` failed to resolve TypeScript's
`./lib/tsc` export. These checks are not claimed green.

All three PRs are open and mergeable. Merge/deploy Missions before gateway,
then Backoffice. The Backoffice `main` workflow builds and deploys on merge.
Authenticated staging API/UI and claim-ledger reconciliation remain required
for runtime acceptance. Production ECS and RDS remain parked.
