# TASK-EAR-423: Missions AddTurnover: refuse public gateway turnover/EXP forging

Follow-up of TASK-EAR-422 (owner-scope sweep, Games-Labs-Missions#147), which
left `AddTurnover` out on purpose.

## Problem (base origin/staging 6d5500c)

- `MissionsService.AddTurnover` carries `google.api.http: post /api/v1/levels/turnover`
  in shared-lib `missions.proto`, so api-gateway (`gateway/grpc.go:148`) routes it
  publicly for any logged-in player.
- The bridge (`internal/handlers/mission/grpc/server.go`) forwards the body to
  `LevelHandler.AddTurnover` (`internal/handlers/mission/http/level.go:67`), which
  trusts body `user_id` AND `amount` → any player can add EXP/turnover (and level
  up) on any account, their own included. `resolveOwner` would only stop the
  cross-user half.

## Callers (checked 2026-11-03)

- No service in the workspace calls `AddTurnover` / `/api/v1/levels/turnover`
  (shared-lib only has generated code; api-gateway has no HTTP Mission client use;
  backoffice has no hit). Android not inspected for edits (read-only).
- Real turnover enters via internal `ApplyGameplayTurnover` (no http annotation)
  → `services.ApplyTurnoverExp` → `LevelService.AddTurnover`.

## Decision

Refuse in the Missions bridge (single repo, effective on Missions deploy; no
shared-lib regen / gateway bump needed): gRPC `AddTurnover` returns
`PermissionDenied` without invoking any handler or service. Drop the dead HTTP
route `POST /api/v1/levels/turnover` and its handler so no Missions HTTP listener
serves it either. `LevelService.AddTurnover` (used by ApplyTurnoverExp) is kept.

Follow-up (separate): drop the `google.api.http` annotation in shared-lib
`missions.proto` + bump api-gateway so the route stops being advertised at all.

## Acceptance

- Gateway-shaped call to `AddTurnover` (any body, own or other user) → PermissionDenied,
  user level/EXP unchanged.
- `ApplyGameplayTurnover` still adds EXP.
- RED test seen failing on base, GREEN after fix; `go test ./...` green.

## Evidence

- PR: https://github.com/SparqLab/Games-Labs-Missions/pull/148 (base `staging`, not merged),
  branch `fix/TASK-EAR-423-addturnover-internal-only` @ commit on top of 6d5500c.
- RED on base: `TestAddTurnover_PublicBridgeRefuses` both cases `code = OK, want PermissionDenied`.
- GREEN after fix; `go test ./... -count=1` rc=0.

## Merged, deployed, accepted (2026-11-03, Claude conductor)

- **Approval:** the operator approved merging ("PR จาก session อื่น merge ได้เลยครับ").
- **Pre-merge check:** I merged #147 and #148 together onto staging and ran `go vet` and `go test`; both passed with no conflicts. I also confirmed that no service and no Backoffice code calls `AddTurnover`.
- **Merged:** #147 as `6c7669e`, #148 as `4139416`.
- **Deployed:** Deploy STAGING run 41617388756 succeeded. DEV runs Missions td161 `staging-sha-4139416`, HEALTHY (ev-001).
- **Accepted on DEV:** the operator ran these through Postman. Both calls returned `code: 7` (PermissionDenied):

  | Call | Message |
  | --- | --- |
  | cross-user `missions/progress` | "user_id does not match authenticated user" |
  | `levels/turnover` | "turnover is applied from settled gameplay only" |

- **Review:** no separate reviewer-lane pass was run for #147 or #148. This is disclosed in the gates.
