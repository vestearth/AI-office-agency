# TASK-EAR-123: Weekly Completion Bonus — Claim Flow (staging)

## Short name

`weekly-completion-bonus-claim-flow`

## Type

feature

## Workstream

backend

## Priority

medium

## Created

2026-07-12

## Goal

Let a player actually claim the weekly Value Bonus (weekly_completion_bonus_*)
that TASK-EAR-094 already exposes as display-only. Add a claim endpoint that
pays the bonus exactly once per (user, week) when every weekly mission for that
week is complete, and surface `claimable`/`claimed` on the two public surfaces
that already show the bonus. Staging only — no migration, no proto change, not
promoted to main/prod as part of this task.

## Approved design

Brainstormed and approved by the operator 2026-07-12 (Claude advisory lane).
No separate spec file — Games-Labs-Missions backend tasks in this repo carry
their design directly in `task.md` (unlike frontend tasks, which reference a
`docs/superpowers/specs/` file).

**Decisions locked by the operator:**
- Eligibility = every weekly mission for the week has `progress >= target`
  (mirrors the daily completion-bonus gate: `EligibleDailyActivitiesForCompleteAllBonus`
  + `countCompleteEligible`). Does NOT require each mission to have been
  individually claimed first — the weekly bonus is additive, not a rollup of
  per-mission claims.
- Scope = staging only, and add `claimable`/`claimed` to the public/mobile
  surfaces now (not deferred).

**Why `WeeklyService`, not `MissionService`:** `WeeklyService.repo` (interface
`weeklyMissionRepository`) already exposes `GetMissionConfig` and
`GetActiveWeeklyPlanByWeek`, and `WeeklyService` already owns
`ListWeeklyMissions` — the only source of per-mission `Progress`/`Target` for a
user's week (event-sourced vs. legacy resolution logic lives there, not in
`MissionService`). Putting the claim there avoids a cross-service dependency
and reuses the existing free function `resolveWeeklyCompletionBonus(cfg, plan)`
(same `services` package) that `MissionService.ResolveWeeklyCompletionBonusForWeek`
already calls.

**Components:**

1. **Repo (`internal/repositories/mission_repo.go`)** — three methods mirroring
   the daily completion-bonus claim ledger (`HasDailyCompletionBonusClaim` /
   `TryInsertDailyCompletionBonusClaim` / `DeleteDailyCompletionBonusClaim`),
   against the table that **migration 030 already created**
   (`weekly_completion_bonus_claims`, `UNIQUE(user_id, week_start)`):
   - `HasWeeklyCompletionBonusClaim(ctx, userID, weekStart string) (bool, error)`
   - `TryInsertWeeklyCompletionBonusClaim(ctx, userID, weekStart string, reward int64, currency string) (bool, error)`
   - `DeleteWeeklyCompletionBonusClaim(ctx, userID, weekStart string) error`

2. **Service (`internal/services/weekly_service.go`)** —
   `ClaimWeeklyCompletionBonus(ctx, userID, idempotencyKey string) (models.MissionResult, error)`,
   structured exactly like `MissionService.ClaimDailyCompletionBonus`:
   - Resolve the week's bonus via `resolveWeeklyCompletionBonus(cfg, plan)`
     (load `cfg` from `s.repo.GetMissionConfig`, `plan` from
     `s.repo.GetActiveWeeklyPlanByWeek`). If `!Enabled || Reward <= 0` →
     `not_claimable` / `ErrWeeklyCompletionBonusDisabled`.
   - Call `s.ListWeeklyMissions(ctx, userID)` (existing) and check every
     `WeeklyMissionCard.Progress >= .Target`. If any mission is incomplete →
     `not_claimable` / `ErrWeeklyCompletionBonusNotEligible`.
   - Idempotency key default: `weekly_completion_bonus:<userID>:<weekStart>`
     (mirrors `daily_completion_bonus:<userID>:<bangkokDay>`).
   - `TryInsertWeeklyCompletionBonusClaim` (reserve the ledger row) → if not
     inserted, `already_claimed` / `ErrAlreadyClaimed` (reuse the existing
     shared error — do not add a weekly-specific already-claimed error).
   - `wallet.Credit(...)` with `Reason: "weekly_completion_bonus"`,
     `ReferenceType: "MISSION_REWARD"`, `ReferenceID: weekStart`. On credit
     failure, `DeleteWeeklyCompletionBonusClaim` (compensating delete, same as
     daily) and return the error.
   - On success: `RecordMission(ctx, userID, "weekly_completion_bonus", weekStart, key, reward, currency)`
     and return `{Status: "credited", CreditedCoins: reward, RewardType: "weekly_completion_bonus"}`.

3. **Enrich `models.WeeklyCompletionBonus`** with `Claimable bool` and
   `Claimed bool` (currently has only `Enabled`/`Reward` — the doc comment on
   this struct explicitly says these fields "arrive with the claim feature").
   Compute them **once**, inside `WeeklyService.ListWeeklyMissions` (the single
   place `completionBonus(ctx, weekStart)` is built), by adding one
   `HasWeeklyCompletionBonusClaim(ctx, userID, weekStart)` call:
   `Claimed = <that bool>`, `Claimable = Enabled && Reward > 0 && all missions
   complete && !Claimed`. This is the single source of truth for both:
   - `GET /api/v1/missions/weekly` — gets the enriched fields for free (same
     struct, same call).
   - `GET /api/v1/quest/overview` — `quest_overview_service.go`'s `buildTabs`
     already calls `s.weeklySource.ListWeeklyMissions(ctx, userID)` at line
     ~497 to build the Weekly tab. Reuse that SAME response (do not issue a
     second `ListWeeklyMissions` call) to also build
     `QuestOverviewWeeklyCompletionBonus`, which gains `Total`/`Completed`
     fields (count of weekly missions / count with `Progress >= Target`)
     alongside `Claimable`/`Claimed`, mirroring
     `QuestOverviewDailyCompletionBonus{Total,Completed,Claimable,Claimed,Reward}`
     exactly. `buildQuestOverviewWeeklyCompletionBonus`'s signature changes
     from `(bonus WeeklyCompletionBonusResolved)` to also take the
     `*models.WeeklyMissionsResponse` (or just its `Missions` +
     `CompletionBonus.Claimed`) so it no longer needs a second resolution path.

4. **Wiring** (mirrors the daily bonus wiring exactly):
   - `weeklyMissionHandlerService` interface (`internal/handlers/mission/http/weekly.go`)
     gains `ClaimWeeklyCompletionBonus(ctx, userID, idempotencyKey string) (models.MissionResult, error)`.
   - New handler `WeeklyHandler.ClaimWeeklyCompletionBonus` (mirrors
     `MissionHandler.ClaimDailyCompletionBonus` in `mission.go:76`): POST-only,
     decode `{user_id, idempotency_key}`, `Idempotency-Key` header fallback.
   - New route: `POST /api/v1/missions/claim-weekly-completion-bonus` in
     `internal/routes/apiv1.go` (mirrors the daily route at `apiv1.go:30`).
   - **No gRPC bridge / no api-gateway wiring in this task — corrected during
     planning.** The brainstormed design assumed a bridge could be added the
     same way `ClaimDailyCompletionBonus`/`ClaimWeeklyMission` have one, but
     verifying api-gateway's actual routing shows that's wrong for a *new*
     capability: those two RPCs are only gateway-reachable because
     `missionspb/missions.proto` already declares them with a
     `google.api.http` binding, and api-gateway's public Missions routes are
     registered entirely via `missionspb.RegisterMissionsServiceHandlerFromEndpoint`
     (grpc-gateway, generated from those `.proto` bindings) — there is no
     generic REST passthrough for the public `/api/v1/missions/*` prefix (the
     `SimpleProxy` mechanism in `api-gateway/gateway/http.go` exists only for
     `/admin/*` staff routes). A brand-new RPC name with no `.proto` binding
     would never be dispatched, so a `*Server` Go method for it would be dead
     code implying false capability. Adding the binding is itself the proto
     change the approved scope excludes. Resolution: this task exposes the
     claim endpoint ONLY on the Missions service's own apiv1 HTTP mux
     (`POST /api/v1/missions/claim-weekly-completion-bonus`, directly against
     the Missions service on staging) — sufficient for backend QA/smoke
     testing. Wiring it through api-gateway for mobile is a follow-up task
     that does require a proto change and is explicitly deferred. The
     `claimable`/`claimed` FIELDS on the two existing GET responses are
     unaffected by this and remain proto-free (Struct-passthrough, confirmed
     below) — only the claim *action* needs the follow-up.

5. **Errors** (`internal/missionserr/errors.go` + `internal/services/mission_service.go`
   re-export, mirroring the daily pair): add
   `ErrWeeklyCompletionBonusDisabled`, `ErrWeeklyCompletionBonusNotEligible`.
   Reuse the existing `ErrAlreadyClaimed`.

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns the weekly claim ledger, the claim service/handler/route, and the two response enrichments. |
| `ai-dev-office` | Records the design, scope, and verification handoff for this task. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `internal/repositories/mission_repo.go` | modify | Add `HasWeeklyCompletionBonusClaim` / `TryInsertWeeklyCompletionBonusClaim` / `DeleteWeeklyCompletionBonusClaim` against the existing `weekly_completion_bonus_claims` table. |
| `internal/services/weekly_service.go` | modify | Add `ClaimWeeklyCompletionBonus`; enrich `completionBonus(ctx, weekStart)` → needs `userID` threaded in to compute `Claimed`. |
| `internal/models/models.go` | modify | Add `Claimable`/`Claimed` to `WeeklyCompletionBonus`. |
| `internal/services/quest_overview_service.go` | modify | `buildQuestOverviewWeeklyCompletionBonus` gains `Total`/`Completed`/`Claimable`/`Claimed` sourced from the same `ListWeeklyMissions` call `buildTabs` already makes. |
| `internal/handlers/mission/http/weekly.go` | modify | Add `ClaimWeeklyCompletionBonus` handler + interface method. |
| `internal/routes/apiv1.go` | modify | Register `POST /api/v1/missions/claim-weekly-completion-bonus`. |
| `internal/missionserr/errors.go` | modify | Add the two new weekly error vars. |
| `internal/services/mission_service.go` | modify | Re-export the two new error vars (mirrors the daily pair). |
| `internal/repositories/mission_repo_test.go` | modify | Repo-level sqlmock tests for the three new claim-ledger methods. |
| `internal/services/weekly_service_test.go` (or new `weekly_completion_bonus_test.go`) | modify/create | Service-level tests: claim success, already-claimed, not-all-complete, disabled, credit-fail rolls back the claim row. |
| `internal/handlers/mission/http/weekly_test.go` | modify | Handler test for the new endpoint (mirrors existing claim tests in this file). |
| `ai-dev-office/runs/TASK-EAR-123/status.yaml` | create | Track assignment and next action. |

### Explicitly excluded

- No new database migration — `weekly_completion_bonus_claims` already exists
  (migration 030).
- No protobuf / grpc-gateway contract change. The `claimable`/`claimed` fields
  on `/api/v1/missions/weekly` and `/api/v1/quest/overview` reach mobile
  without a proto change (both are Struct-passthrough responses). The claim
  endpoint itself is Missions-mux-only in this task (no gRPC bridge, no
  api-gateway route) — see "Approved design" above for why, and see "Follow-up
  (out of scope)" below.
- No merge to `main` or deploy to prod as part of this task — staging only.
  Promoting to main/prod is a separate, later decision.
- No changes to the existing per-mission `ClaimWeeklyMission` flow — the
  completion bonus is additive and independent of individual mission claims.
- No backoffice/admin UI changes — the admin board/detail bonus rendering
  (`weeklyCompletionBonusResponse` in `weekly_plans.go`) is unaffected; this
  task only adds a player-facing claim path.
- No changes to `resolveWeeklyCompletionBonus` itself (the override-vs-singleton
  resolution logic) — reused as-is.
- No gRPC bridge method on `internal/handlers/mission/grpc/server.go`, no
  `missionspb`/`shared-lib` change, no api-gateway change. See "Follow-up (out
  of scope)" below.

### Follow-up (out of scope)

Mobile cannot call the claim endpoint through api-gateway until a follow-up
task adds `rpc ClaimWeeklyCompletionBonus(google.protobuf.Struct) returns
(google.protobuf.Struct)` with a `google.api.http` POST binding to
`missionspb/missions.proto` (mirroring `ClaimDailyCompletionBonus`'s
declaration), regenerates `missionspb`, bumps the `shared-lib` dependency in
both `Games-Labs-Missions` and `api-gateway`, and adds the `*Server` bridge
method this task deliberately omits. That is real proto/contract work and
belongs in its own task once this one is validated on staging.

## Description

TASK-EAR-094 exposed the resolved weekly Value Bonus on the admin plan detail
and the two public surfaces (`/api/v1/missions/weekly`,
`/api/v1/quest/overview`), but nothing pays it — `weekly_completion_bonus_claims`
(added in migration 030, alongside the daily table in migration 021) has stayed
unused, and both response structs' doc comments say so explicitly ("no weekly
claim flow yet ... those arrive with the claim feature"). This task closes that
gap by mirroring the daily completion-bonus claim flow one-to-one: a claim
endpoint that pays the resolved bonus exactly once per (user, week) when every
weekly mission is complete, using the claim ledger table that has been sitting
ready since TASK-EAR-020.

## Acceptance criteria

- [ ] `POST /api/v1/missions/claim-weekly-completion-bonus` credits the
      resolved weekly bonus (per-week override first, singleton fallback) to
      the user's wallet exactly once when all weekly missions for the current
      week have `progress >= target`.
- [ ] A second claim attempt for the same (user, week) returns
      `already_claimed` and does not credit again (verified via the
      `UNIQUE(user_id, week_start)` constraint + `TryInsert` semantics).
- [ ] A claim attempt with any incomplete weekly mission returns
      `not_claimable` and does not touch the wallet or the claim ledger.
- [ ] A claim attempt when the bonus is disabled or `reward <= 0` returns
      `not_claimable` (disabled) without touching the wallet or ledger.
- [ ] A wallet credit failure rolls back the reserved claim row (the user is
      not left permanently unable to claim) — mirrors the daily
      `DeleteDailyCompletionBonusClaim` compensation.
- [ ] `GET /api/v1/missions/weekly` response's `weekly_completion_bonus` object
      gains `claimable` and `claimed`, computed from the same
      `ListWeeklyMissions` call (no extra request).
- [ ] `GET /api/v1/quest/overview` response's `weekly_completion_bonus` object
      gains `total`, `completed`, `claimable`, `claimed` — same shape as
      `daily_completion_bonus` — sourced from the single existing
      `ListWeeklyMissions` call `buildTabs` already makes (no duplicate call).
- [ ] No new migration; no proto/`missionspb`/`shared-lib`/api-gateway change
      of any kind — the claim endpoint is Missions-apiv1-mux-only.
- [ ] `go build ./...` and `go vet ./...` pass.
- [ ] `go test ./... -race` passes (11+ packages, no regressions).
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-123` passes.
- [ ] Merged to Games-Labs-Missions `staging` only (not `main`).

## Plan

1. Repo layer: add the three claim-ledger methods + sqlmock tests (TDD: write
   the failing test first, mirroring the existing daily claim-ledger tests).
2. Service layer: add `ClaimWeeklyCompletionBonus` on `WeeklyService` + the two
   new error vars; unit tests for all five branches (credited, already-claimed,
   not-all-complete, disabled, credit-fail-rollback).
3. Enrich `models.WeeklyCompletionBonus` and thread `userID` into
   `WeeklyService.completionBonus`; update its one caller
   (`ListWeeklyMissions`) and its test expectations.
4. Enrich `QuestOverviewWeeklyCompletionBonus` + `buildQuestOverviewWeeklyCompletionBonus`,
   reusing `buildTabs`'s existing `ListWeeklyMissions` call; update
   `quest_overview_service_test.go` expectations.
5. Wire the HTTP handler + apiv1 mux route (Missions-only — no gRPC bridge,
   no api-gateway change; see "Follow-up (out of scope)").
6. Run the full suite (`go build ./...`, `go vet ./...`,
   `go test ./... -race`), fix any regressions.
7. Commit on a new branch cut from `staging`
   (`feat/TASK-EAR-123-weekly-completion-bonus-claim`), open a PR against
   `staging`, request review.
8. Update `ai-dev-office/runs/TASK-EAR-123/status.yaml` to `in_review`, then
   `done` once merged and validated.

## Dependencies and blockers

- Dependency: `weekly_completion_bonus_claims` table (migration 030) — already
  present, no action needed.
- Dependency: `resolveWeeklyCompletionBonus` / `ResolveWeeklyCompletionBonusForWeek`
  (TASK-EAR-094) — already present, no action needed.
- Blockers: none. This task is fully unblocked and staging-only.

## Risks and mitigations

- **Threading `userID` into `WeeklyService.completionBonus`** changes an
  existing private method's signature.
  Mitigation: it has exactly one call site (`ListWeeklyMissions`, same file);
  grep confirmed no other callers before starting.
- **Double-counting risk**: a naive implementation might require each
  individual weekly mission to be *claimed* (not just complete) before paying
  the bonus, which would silently change behavior if a player claims the bonus
  before claiming individual missions.
  Mitigation: explicitly gate on `Progress >= Target` only (completion), not
  `Claimed`, matching the operator's approved eligibility rule and the daily
  pattern's `countCompleteEligible` (which also gates on completion, not
  per-activity claim state).
- **Reusing the `buildTabs` `ListWeeklyMissions` call for the quest-overview
  bonus enrichment** couples two previously-independent code paths.
  Mitigation: keep the enrichment as a pure function taking the already-fetched
  `*models.WeeklyMissionsResponse`, so the coupling is a function parameter,
  not a hidden shared-state dependency — unit-testable in isolation.
- **Wallet credit failure after claim-row insert** (partial failure) — same
  risk class as the daily flow, already has a proven mitigation (compensating
  delete) that this task copies verbatim.

## Assignment

- Primary: `dev` (Claude advisory lane, self-implementing per operator
  authorization to proceed)
- Parallel: `false`
- Reason: single-repository backend change touching a small number of
  interdependent files (repo → service → two response builders → handler →
  route) best implemented sequentially with TDD at each layer.

## Verification and review plan

- `go build ./...`, `go vet ./internal/...` from `Games-Labs-Missions`.
- `go test ./... -race -count=1` — full suite, zero regressions, new tests
  cover all five claim branches plus the two response-enrichment paths.
- Reviewer confirms: no migration added, no proto/contract file touched,
  `Claimable` gates on completion (not per-mission claim state), the
  compensating-delete-on-credit-failure path is tested.
- Run the canonical AI Dev Office YAML validator before handoff:
  `ruby ai-dev-office/validate-yaml.rb TASK-EAR-123`.
- Merge target is `staging` only; do not merge to `main` as part of this task.
