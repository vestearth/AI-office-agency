# TASK-EAR-169 — verification evidence (runtime smoke)

Run date: 2026-07-31. Lane: Claude advisory (manual), operator-requested.
Operator ruling the same day: **staging passing counts as passing** for this run.

The gap this closes: the dev-2 handoff recorded that "authenticated runtime and
deployment smoke remain unrun", and the record still described three open Draft
PRs. All three were in fact merged on 2026-07-29 — two with green deploys, one
of them to the live production lane — so the unrun smoke had been sitting
against shipped code.

## 1. What is actually deployed

| repo | PR | merge commit | lane | deploy |
| --- | --- | --- | --- | --- |
| Games-Labs-Missions | #87 | `9b8ca90` | staging | **success** (2026-07-29) |
| Games-Labs-backoffice | #59 | `8aeb412` | main = **live k3s/ArgoCD** | **success** |
| api-gateway | #27 | `b0a160c` | main = DEV lane | no run — expected |

`9b8ca90` confirmed an ancestor of `origin/staging`. Deploy conclusions read
from the Actions API, not from a `gh run watch` exit code.

**api-gateway #27 is documentation only** — `docs/Games-Labs-APIs.postman_collection.json`,
+4/-4, nothing else. That matters: this workspace has been bitten four times by
a gateway proto binding that needed its own staging-lane bump. Not a risk here,
because 169 deliberately kept the existing route
`POST /api/v1/admin/missions/force-complete` and its `google.protobuf.Struct`
transport unchanged (the route was wired back in TASK-EAR-132), so no binding
was added or moved.

## 2. Acceptance behaviour re-verified on the merged staging code

The local Missions checkout had another session's uncommitted changes in it, so
testing there would have proved nothing about what shipped. Ran instead in a
throwaway git worktree pinned to `origin/staging`, then removed it.

    go build ./...                                    BUILD OK
    go vet ./internal/handlers/adminmission/... \
           ./internal/services/...                    VET OK
    go test ./internal/handlers/adminmission/... \
            ./internal/services/...                   ok / ok

Then the acceptance-critical cases under the race detector:

    go test -race -run ForceComplete ...

    --- PASS: TestHandleForceComplete_ValidatesDailyMissionRequest
              /admin_missing_user_id
              /non-admin_without_auth_header
              /admin_missing_mission_id
              /user_cannot_force_complete_own_mission
              /unsupported_type
    --- PASS: TestHandleForceComplete_MonthlyReturnsStableSuccess
    --- PASS: TestHandleForceComplete_UserTokenRequiresAdminForMonthly
    --- PASS: TestHandleForceComplete_MonthlyAutoCreditIsIdempotent
    --- PASS: TestForceCompleteMonthly_PreservesPersistedRewardClaimed
    --- PASS: TestForceCompleteDailyMission_SetsProgressToThresholdAndMarksClaimable
    ok  .../internal/handlers/adminmission/http   1.526s
    ok  .../internal/services                      1.564s

Mapped to the acceptance criteria:

- *"Force-complete requires an admin/superadmin caller for Daily and Monthly"* →
  the three authorization subtests plus `UserTokenRequiresAdminForMonthly`.
- *"Monthly payout … can retry after Wallet or persistence failure without
  double credit"* → `MonthlyAutoCreditIsIdempotent`, under `-race`.
- *"persisted Monthly reward_claimed state is preserved across service
  restarts"* → `PreservesPersistedRewardClaimed`.
- *"Daily payout reuses the canonical Daily claim rules"* →
  `SetsProgressToThresholdAndMarksClaimable`.

## 3. Backoffice

    node --test tests/playerMissionComplete.test.mjs
    ✔ player mission progress is read-only with no incremental controls
    ✔ approved Update label remains while the action requests automatic reward credit
    ✔ batch feedback accounts for credited rewards and partial failures
    pass 3, fail 0

Those three map directly to the UI acceptance criteria (read-only progress, the
retained `Update` label sending `claim_reward`, honest partial-failure
reporting).

Full suite on `main`: **107 pass / 7 fail**. All 7 failures are the identical
`ERR_MODULE_NOT_FOUND: Cannot find package '~'` — the Nuxt `~` alias is not
resolvable under a bare `node --test`, so those files never execute. They are
`adminCouponApi`, `adminStoreItemsApi`, `missionBoardGameNames`, `missionName`,
`missionPointCurrency`, `passGameSupport`, `weeklyPlanBoardBonus` — none of them
touched by this run, and the failure is a runner-invocation gap, not test logic.
Pre-existing; worth its own cleanup, not a blocker here.

## 4. Live staging check

    POST https://api-test-gateway.gameslabs.app/api/v1/admin/missions/force-complete
    (no Authorization header)
    -> HTTP 401
    {"success":false,"error":{"code":"UNAUTHORIZED","message":"Missing authorization header"}}

The admin gate is enforced on the deployed staging surface, which is the one
acceptance criterion reachable without a credential.

**Stated limit, so nobody reads more into this than it proves:** the gateway
answers 401 in auth middleware *before* routing — a nonexistent path returns 401
too — so this response does not by itself prove the route is mounted. Route
existence rests on it being unchanged since TASK-EAR-132 and on #27 being
docs-only.

## 5. What is still not proven

An authenticated end-to-end run — force-complete a real staging user's Daily and
Monthly missions, observe the wallet credit, repeat the call and observe no
second credit — was not performed. It needs an admin bearer token, and entering
credentials is outside what this lane does.

Everything that behaviour depends on is covered above by race-tested code on the
merged staging commit plus a green staging deploy, and the operator ruled on
2026-07-31 that staging passing counts as passing. Recorded here so a later
reader knows exactly which link in the chain is inference rather than
observation: the wallet credit itself was never watched happening on staging.
