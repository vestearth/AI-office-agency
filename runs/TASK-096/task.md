# TASK-096: Add Check-In Day Reward Claim Endpoint

## Short name
`check-in-day-claim`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-067`
- Epic: Check-In Calendar and Consecutive Bonus

## Status

Done. Closed on 2026-06-15 after shared-lib publish, downstream bump, typed
gRPC wiring, docs update, and fresh verification.

## Background

Mobile can now distinguish restored check-in dates through `days[].is_restored`,
but the API surface still has no way to claim the daily reward for a restored
date. The current check-in contract only supports:

- `POST /api/v1/missions/streak/restore` to restore a missed date and debit the
  restore price.
- `POST /api/v1/missions/check-in/milestones/{day}/claim` to claim milestone
  rewards such as D3/D7/D15/D31.

The restored date's daily reward is shown in `days[].reward`, but there is no
daily check-in day claim endpoint, no daily check-in claim ledger, and no
calendar claim state for Mobile to decide whether to show the claim button.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `shared-lib` | Owns the Missions proto HTTP contract and generated gateway/swagger artifacts. |
| `Games-Labs-Missions` | Owns daily check-in day reward claim behavior, persistence, wallet credit, and runtime tests. |
| `api-gateway` | Exposes updated generated contract/docs and Postman examples for Mobile. |
| `ai-dev-office` | Stores task status, handoff, and verification evidence. |

### Affected files

- `shared-lib/proto/missionspb/missions.proto`
- `shared-lib/proto/missionspb/missions.pb.go`
- `shared-lib/proto/missionspb/missions.pb.gw.go`
- `shared-lib/proto/missionspb/missions_grpc.pb.go`
- `shared-lib/proto/missionspb/missions.swagger.json`
- `Games-Labs-Missions/migrations/024_check_in_day_claims.sql`
- `Games-Labs-Missions/internal/models/models.go`
- `Games-Labs-Missions/internal/repositories/mission_repo.go`
- `Games-Labs-Missions/internal/repositories/mission_repo_test.go`
- `Games-Labs-Missions/internal/services/check_in_calendar_service.go`
- `Games-Labs-Missions/internal/services/check_in_calendar_service_test.go`
- `Games-Labs-Missions/internal/handlers/mission/http/mission.go`
- `Games-Labs-Missions/internal/handlers/mission/http/mission_test.go`
- `Games-Labs-Missions/internal/handlers/mission/grpc/server.go`
- `Games-Labs-Missions/internal/handlers/mission/grpc/server_test.go`
- `Games-Labs-Missions/internal/routes/apiv1.go`
- `Games-Labs-Missions/README.md`
- `api-gateway/docs/Games-Labs-APIs.postman_collection.json`
- `ai-dev-office/runs/TASK-096/status.yaml`
- `ai-dev-office/runs/TASK-096/dev-2-output.yaml`
- `ai-dev-office/runs/TASK-096/verification-evidence.md`

### Explicitly out of scope

- Do not auto-credit the daily reward during restore.
- Do not change milestone claim behavior.
- Do not change restore pricing or eligibility.
- Do not change Mobile code in this task.
- Do not add local `replace github.com/SparqLab/shared-lib => ../shared-lib`
  directives to consumer `go.mod` files.

## Acceptance criteria

- [x] Shared Missions proto defines a new backward-compatible RPC for claiming a
  check-in day reward, exposed as
  `POST /api/v1/missions/check-in/days/{day}/claim`.
- [x] The response returns `day`, `date`, `day_status`, `reward`,
  `claimed_at`, and `claim_status`.
- [x] Calendar `days[]` includes claim state so Mobile can decide whether the
  daily reward button is claimable, claimed, or inactive.
- [x] A user can claim the daily reward for a completed restored day exactly
  once.
- [x] A user can claim the daily reward for a normal completed check-in day
  exactly once.
- [x] Missed, broken, today, upcoming, and invalid days are not claimable.
- [x] Claiming a day credits the wallet with the day reward and rolls back the
  claim ledger if wallet credit fails.
- [x] Claim idempotency is enforced by durable database uniqueness and request
  idempotency keys.
- [x] Focused service, HTTP, gRPC, and repository tests cover restored-day claim,
  duplicate claim, and unclaimable day behavior.
- [x] README and Postman documentation describe the new endpoint and day claim
  fields.
- [x] Generated protobuf, gRPC gateway, and swagger files are regenerated from
  `.proto`; generated files are not manually edited.

## Technical plan

1. Add `CheckInDayClaim` model fields and a `check_in_day_claims` migration with
   unique constraints on `(user_id, campaign_id, checkin_date)` and
   `idempotency_key`.
2. Add repository methods to list, insert, and delete check-in day claims.
3. Extend calendar loading to include daily day claims and expose `claim_status`
   plus `claimed_at` per day.
4. Implement `ClaimCheckInDay(ctx, userID, day, idempotencyKey)` in Missions:
   resolve the day within the active/current month, require an existing
   completed day ledger, reject non-completed days, insert claim ledger, credit
   wallet using the ledger reward, and roll back on wallet credit failure.
5. Add HTTP handler and route:
   `POST /api/v1/missions/check-in/days/{day}/claim`.
6. Add shared-lib proto request/response/RPC and regenerate shared artifacts.
7. Add gRPC server mapping for the new typed RPC.
8. Update README and Postman examples for Mobile handoff.
9. Run focused and module-level verification, then record evidence.

## Subtasks

| Order | ID | Agent | Description | Owned files | Parallel safe |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared-lib-contract` | `dev-2` | Add typed day-claim RPC/messages and day claim calendar fields to shared Missions proto, then regenerate shared artifacts. | `shared-lib/proto/missionspb/*` | false |
| 2 | `missions-persistence` | `dev-2` | Add durable day-claim migration and repository methods/tests. | `Games-Labs-Missions/migrations/024_check_in_day_claims.sql`, `Games-Labs-Missions/internal/repositories/mission_repo.go`, `Games-Labs-Missions/internal/repositories/mission_repo_test.go` | false |
| 3 | `missions-runtime` | `dev-2` | Implement claim service behavior and calendar day claim state with TDD. | `Games-Labs-Missions/internal/models/models.go`, `Games-Labs-Missions/internal/services/check_in_calendar_service.go`, `Games-Labs-Missions/internal/services/check_in_calendar_service_test.go` | false |
| 4 | `http-grpc-routing` | `dev-2` | Add HTTP route/handler and gRPC mapping/tests. | `Games-Labs-Missions/internal/handlers/mission/http/mission.go`, `Games-Labs-Missions/internal/handlers/mission/http/mission_test.go`, `Games-Labs-Missions/internal/handlers/mission/grpc/server.go`, `Games-Labs-Missions/internal/handlers/mission/grpc/server_test.go`, `Games-Labs-Missions/internal/routes/apiv1.go` | false |
| 5 | `docs-verification` | `dev-2` | Update Mobile-facing README/Postman docs and write verification outputs. | `Games-Labs-Missions/README.md`, `api-gateway/docs/Games-Labs-APIs.postman_collection.json`, `ai-dev-office/runs/TASK-096/*` | false |

## Risks

| Risk | Mitigation |
| --- | --- |
| Contract and downstream code drift if shared-lib is not regenerated first. | Start from `.proto`, regenerate shared-lib artifacts, then wire Missions code to the generated type names. |
| Duplicate reward credit on retries. | Use durable uniqueness for `(user_id, campaign_id, checkin_date)` and idempotency keys; return already-claimed as conflict/idempotent error without a second credit. |
| Restore becomes coupled to reward grant unintentionally. | Keep restore flow unchanged; only the new day-claim endpoint credits daily reward. |
| Mobile cannot render button state. | Add explicit calendar day `claim_status` and `claimed_at` fields. |

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: this is a cross-service contract and persistence change touching
shared-lib, Missions runtime, gateway docs, database schema, and wallet credit
behavior. The work must stay ordered.

## Next action

Done. No open task action remains.
