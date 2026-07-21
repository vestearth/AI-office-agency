# TASK-EAR-145: Prevent turnover progression into inactive VIP levels

Bugfix/backend/high; owner `dev`. Repos: `Games-Labs-Missions` (progression
calculation) and `Games-Labs-User` (authoritative level-status guard).

This task supersedes the earlier TASK-EAR-145 draft that proposed masking raw
`GetProfile.level` with new display fields. The operator clarified the actual
acceptance on 2026-07-18: **a user must not level up into an inactive VIP
level**. Display masking alone does not satisfy that requirement.

## Reported case

### Steps

1. Mark the next VIP level inactive in Backoffice (reported case: VIP26 is
   inactive and there is no VIP27).
2. Play with a user currently below that level until turnover/EXP reaches the
   next-level threshold.

### Actual

The user is persisted at the inactive level. Its privileges are withheld, but
the raw `user_profiles.level` still advances and `GetProfile.level` exposes it.

### Expected

The user remains at the preceding active level. The inactive threshold is not
consumed, the newly earned residual EXP is retained, no inactive-level
privilege is granted, and the turnover event completes successfully.

## Root cause (verified in current source)

The progression path is status-blind:

1. `Games-Labs-User`'s internal `ListLevelProgressConfigs` handler returns every
   `level_config` as only `{level, turnover_required}`; it does not expose
   status (`internal/core/handlers/userhdl/grpc.go:233-256`).
2. `Games-Labs-Missions` caches those thresholds, then `AddTurnover` repeatedly
   evaluates `nextLevel := currentLevel + 1`, subtracts the threshold, and
   assigns `userLevel.Level = nextLevel` without checking active/inactive
   (`internal/services/level_service.go:301-317`).
3. `Games-Labs-User.UpdateLevelProgress` grants across the requested range and
   persists the requested `(level, exp)` verbatim
   (`internal/core/services/usersvc/service.go:321-349`).
4. `grantLevelPrivileges` skips rewards for an inactive level, but explicitly
   still allows the raw level to be stored (`service.go:372-389`).

`BuyVipLevel` is not this bug: it already checks the immediate next config and
rejects an inactive target.

## Locked behavior

For this task, an inactive immediate next level is a **hard progression
barrier**:

- Gameplay progression does not enter or skip over the inactive level.
- The user remains on the current active level.
- EXP earned by the event remains accumulated on that current level; do not
  subtract the inactive level's threshold.
- Higher levels remain unreachable through gameplay until the barrier level is
  active again.
- Once reactivated, the next turnover event may consume the retained EXP and
  advance through the normal loop exactly once.
- Missing next-level config has the same stop behavior as the current max-level
  case.
- A User-service/system failure while checking status is an error, not
  "inactive". Do not save partial level/EXP state; the turnover idempotency
  claim remains retryable through the existing release-on-error path.

This task prevents future inactive-level progression. It does **not**
automatically rewrite users already stored on an inactive level. A naive
demotion would corrupt residual EXP and can double-charge thresholds; any data
reconciliation requires a separately reviewed plan.

## Minimal implementation

Reuse the existing `UserService.GetVipLevel` gRPC contract and its current
inactive gate. Do not add new display fields, RPCs, dependencies, or gateway
routes.

### Games-Labs-Missions — primary progression fix

- `internal/clients/user/client.go`
  - Add an internal client method such as
    `CanProgressToLevel(ctx, level) (bool, error)` using the existing
    `userpb.UserServiceClient.GetVipLevel` RPC.
  - `status.code == 200` with data means active/allowed.
  - existing `LevelConfigNotFound` code `3032` means inactive or missing and
    returns `(false, nil)`.
  - other business/system failures return an error.
- `internal/services/level_service.go`
  - Extend `levelUserClient` with the active-level check.
  - In the `AddTurnover` loop, call the check only after EXP reaches the next
    threshold but **before** subtracting that threshold or assigning the next
    level.
  - When blocked, break successfully with the current level and all EXP
    retained. Do not continue looking for a higher active level.
  - Preserve the existing max-level and normal active-level behavior.
- Tests:
  - update the existing user-client mock/stubs;
  - add focused active, inactive-top, repeated-event, reactivation, and
    User-service-error cases.

### Games-Labs-User — authoritative defense

- `internal/core/services/usersvc/service.go`
  - In `UpdateLevelProgress`, when the request raises the level and
    `levelCfg` is configured, resolve the requested target config before any
    privilege grant or persistence.
  - Reject a missing or inactive target with the existing
    `LevelConfigNotFound` business error; do not write level/EXP.
  - Do not reject same-level EXP updates for legacy users already stored on an
    inactive level; this task does not perform implicit reconciliation.
  - Preserve the existing inactive privilege skip as defense for non-gameplay
    jumps across a range.
- `internal/core/services/usersvc/service_test.go`
  - inactive raised target is rejected with no privilege grant/persist call;
  - active raised target is unchanged;
  - same-level legacy inactive EXP update remains compatible.

### shared-lib — no change

- Reuse `GetVipLevel`, `GetVipLevelResponse`, and business code `3032`.
- Do not add `effective_level`, `effective_vip_catalog_id`, a new status field,
  or a new RPC.
- No dependency bump is required for this implementation.

### api-gateway / Backoffice / Mobile — no change

- The progression status check is internal gRPC from Missions to User.
- No HTTP mapping, gateway dependency bump, FE field migration, or Mobile
  contract change is required.
- Existing public masking/list/detail behavior from TASK-EAR-106 remains
  untouched.

## Rollout order

1. Implement and deploy the Missions live gate first. Current User already
   rejects inactive `GetVipLevel`, so this is independently safe.
2. Implement and deploy the User `UpdateLevelProgress` defense second.
3. Roll back in reverse safety order: User defense first, then Missions. Do not
   leave old Missions running against the stricter User guard or threshold
   events may fail instead of stopping cleanly.

## Acceptance criteria

- With VIP25 active and VIP26 inactive, sufficient turnover keeps the persisted
  and returned level at VIP25.
- The VIP26 threshold is not subtracted; residual EXP includes the newly earned
  amount and accumulates across repeated events without double-charge or loss.
- No VIP26 avatar/reward privilege is granted.
- Reactivating VIP26 allows retained EXP to advance the user on a later event
  exactly once.
- Active next-level progression and max-level behavior remain unchanged.
- User refuses a raised inactive target before granting privileges or updating
  `user_profiles`; same-level legacy updates remain compatible.
- User-service errors fail the turnover operation without partial persistence;
  existing turnover idempotency can retry the event.
- Focused User and Missions tests pass, followed by `go test ./...`,
  `go build ./...`, `go vet ./...`, and `git diff --check` in each changed repo.
- Staging smoke reproduces the reported steps and verifies raw
  `GetProfile.level` remains at the preceding active level; source/test proof
  alone is not promoted to runtime acceptance.

## Explicitly out of scope

- New `GetProfile` display/effective fields.
- Automatic repair or migration of users already persisted on inactive levels.
- Changing `BuyVipLevel`.
- Changing admin `SetUserVipLevel` semantics beyond regression verification.
- Skipping over inactive levels to a higher active level; this task uses the
  operator-approved hard-barrier interpretation.
- Any shared-lib, api-gateway, Backoffice, or Mobile code change.

## Verification commands

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Missions
GOWORK=off go test ./internal/clients/user ./internal/services -count=1
GOWORK=off go test ./...
GOWORK=off go build -mod=readonly ./...
GOWORK=off go vet ./...
git diff --check

cd /Users/earth/Documents/GitHub/Games-Labs-User
GOWORK=off go test ./internal/core/services/usersvc -count=1
GOWORK=off go test ./...
GOWORK=off go build -mod=readonly ./...
GOWORK=off go vet ./...
git diff --check
```
