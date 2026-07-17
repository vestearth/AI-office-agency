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
| `internal/services/quest_overview_service.go` | modify | `buildQuestOverviewWeeklyCompletionBonus` gains `Total`/`Completed`/`Claimable`/`Claimed` sourced from the same `ListWeeklyMissions` call `buildTabs` already makes; deletes the then-dead `resolveWeeklyCompletionBonusThisWeek` + the `questProgressSource.ResolveWeeklyCompletionBonusForWeek` interface method. |
| `internal/services/weekly_completion_bonus_resolve.go` | modify | Delete the then-dead `MissionService.ResolveWeeklyCompletionBonusForWeek` (its only caller was the deleted overview path). `resolveWeeklyCompletionBonus` + `ResolveWeeklyPlanCompletionBonus` stay — both still have live callers. |
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
- [ ] The `ResolveWeeklyCompletionBonusForWeek` chain (overview helper +
      `questProgressSource` interface method + `MissionService` impl + test
      stub method + `weeklyBonusByWeek` stub field) is deleted, since Task 5
      removes its only caller. `resolveWeeklyCompletionBonus` and
      `ResolveWeeklyPlanCompletionBonus` are NOT touched — both still have
      live callers.
- [ ] `go build ./...` and `go vet ./...` pass.
- [ ] `go test ./... -race` passes (11+ packages, no regressions).
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-123` passes.
- [ ] Merged to Games-Labs-Missions `staging` only (not `main`).

## Plan Summary

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

## Detailed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

### Global Constraints

- Repo: `Games-Labs-Missions`. All file paths below are relative to the repo root.
- Branch cut from `staging`; PR merges to `staging` ONLY — never `main`, never deploy to prod.
- No new database migration — `weekly_completion_bonus_claims` (migration 030) already exists.
- No `.proto` / `missionspb` / `shared-lib` / `api-gateway` change of any kind. The claim endpoint is reachable only on the Missions service's own apiv1 HTTP mux (`POST /api/v1/missions/claim-weekly-completion-bonus`) — see `ai-dev-office/runs/TASK-EAR-123/task.md` "Follow-up (out of scope)" for why a gRPC bridge is deliberately NOT added here.
- Every new/changed function must have a passing test before being considered done (TDD).
- After every task: `go build ./...` and `go vet ./...` must be clean, and `go test ./... -count=1` must pass with zero regressions.
- Reuse existing error codes via `meta.Error.AppendMessage(existingCode, newMessage)` — do NOT add new numeric error codes to `shared-lib` (that would itself be a cross-repo/dependency change).

---

### Task 1: Repo layer — weekly completion-bonus claim ledger

**Files:**
- Modify: `internal/repositories/mission_repo.go` (insert after line 1506, the closing `}` of `DeleteDailyCompletionBonusClaim`, before the `// ── Daily Activities ──` comment)
- Test: `internal/repositories/mission_repo_test.go` (append after `TestMissionRepository_HasDailyCompletionBonusClaim`, i.e. after line 182)

**Interfaces:**
- Produces (for Task 3 to consume via the `weeklyMissionRepository` interface):
  - `func (r *MissionRepository) HasWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) (bool, error)`
  - `func (r *MissionRepository) TryInsertWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string, reward int64, currency string) (bool, error)`
  - `func (r *MissionRepository) DeleteWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) error`

- [ ] **Step 1: Write the failing tests**

Append to `internal/repositories/mission_repo_test.go` (the file already imports `context`, `database/sql`, `testing`, `sqlmock "github.com/DATA-DOG/go-sqlmock"` — no new imports needed):

```go
func TestMissionRepository_HasWeeklyCompletionBonusClaim(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	repo := NewMissionRepository(db)
	mock.ExpectQuery("SELECT EXISTS").
		WithArgs("user-1", "2026-05-04").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	claimed, err := repo.HasWeeklyCompletionBonusClaim(context.Background(), "user-1", "2026-05-04")
	if err != nil {
		t.Fatalf("HasWeeklyCompletionBonusClaim error: %v", err)
	}
	if !claimed {
		t.Fatalf("expected claimed=true")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestMissionRepository_WeeklyCompletionBonusClaimIdempotency(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	repo := NewMissionRepository(db)

	mock.ExpectQuery("INSERT INTO weekly_completion_bonus_claims").
		WithArgs("user-1", "2026-05-04", int64(500), "COIN").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(42)))

	inserted, err := repo.TryInsertWeeklyCompletionBonusClaim(context.Background(), "user-1", "2026-05-04", 500, "COIN")
	if err != nil {
		t.Fatalf("first TryInsertWeeklyCompletionBonusClaim error: %v", err)
	}
	if !inserted {
		t.Fatalf("expected first insert to reserve the claim")
	}

	mock.ExpectQuery("INSERT INTO weekly_completion_bonus_claims").
		WithArgs("user-1", "2026-05-04", int64(500), "COIN").
		WillReturnError(sql.ErrNoRows)

	inserted, err = repo.TryInsertWeeklyCompletionBonusClaim(context.Background(), "user-1", "2026-05-04", 500, "COIN")
	if err != nil {
		t.Fatalf("duplicate TryInsertWeeklyCompletionBonusClaim error: %v", err)
	}
	if inserted {
		t.Fatalf("expected duplicate insert to report inserted=false")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestMissionRepository_DeleteWeeklyCompletionBonusClaim(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	repo := NewMissionRepository(db)
	mock.ExpectExec("DELETE FROM weekly_completion_bonus_claims").
		WithArgs("user-1", "2026-05-04").
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := repo.DeleteWeeklyCompletionBonusClaim(context.Background(), "user-1", "2026-05-04"); err != nil {
		t.Fatalf("DeleteWeeklyCompletionBonusClaim error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail (methods don't exist yet)**

Run: `go test ./internal/repositories/ -run 'WeeklyCompletionBonusClaim' -v`
Expected: FAIL with `repo.HasWeeklyCompletionBonusClaim undefined` (and similarly for the other two).

- [ ] **Step 3: Implement the three repo methods**

In `internal/repositories/mission_repo.go`, insert immediately after the closing `}` of `DeleteDailyCompletionBonusClaim` (line 1506) and before the `// ── Daily Activities ──` comment (line 1508):

```go

// HasWeeklyCompletionBonusClaim reports whether the user already claimed the
// complete-all-weekly bonus for weekStart (Bangkok Monday, "2006-01-02").
func (r *MissionRepository) HasWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM weekly_completion_bonus_claims
			WHERE user_id = $1 AND week_start = $2::date
		)
	`, userID, weekStart).Scan(&exists)
	return exists, err
}

// TryInsertWeeklyCompletionBonusClaim reserves the claim row for (user, week). Returns false if already claimed.
func (r *MissionRepository) TryInsertWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string, reward int64, currency string) (bool, error) {
	var id sql.NullInt64
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO weekly_completion_bonus_claims (user_id, week_start, reward_amount, currency)
		VALUES ($1, $2::date, $3, $4)
		ON CONFLICT (user_id, week_start) DO NOTHING
		RETURNING id
	`, userID, weekStart, reward, currency).Scan(&id)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return id.Valid && id.Int64 > 0, nil
}

// DeleteWeeklyCompletionBonusClaim removes a reserved claim row (wallet failure compensation).
func (r *MissionRepository) DeleteWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) error {
	_, err := r.db.ExecContext(ctx, `
		DELETE FROM weekly_completion_bonus_claims
		WHERE user_id = $1 AND week_start = $2::date
	`, userID, weekStart)
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/repositories/ -run 'WeeklyCompletionBonusClaim' -v`
Expected: PASS (3 tests).

Also run the full repository package to confirm no regressions: `go test ./internal/repositories/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/repositories/mission_repo.go internal/repositories/mission_repo_test.go
git commit -m "feat(missions): add weekly completion bonus claim-ledger repo methods (TASK-EAR-123)"
```

---

### Task 2: Errors — weekly completion-bonus error vars

**Files:**
- Modify: `internal/missionserr/errors.go`
- Modify: `internal/services/mission_service.go` (re-export block)

**Interfaces:**
- Produces (for Task 3): `missionserr.ErrWeeklyCompletionBonusDisabled`, `missionserr.ErrWeeklyCompletionBonusNotEligible`, re-exported as `services.ErrWeeklyCompletionBonusDisabled` / `services.ErrWeeklyCompletionBonusNotEligible`.
- No independent test — these are plain error values; Task 3's tests exercise them via `errors.Is`.

- [ ] **Step 1: Add the two error vars to `internal/missionserr/errors.go`**

Add these two lines to the `var (...)` block, right after the existing `ErrDailyCompletionBonusNotEligible` line:

```go
	ErrWeeklyCompletionBonusDisabled    = meta.Error.AppendMessage(errormsg.DailyCompletionBonusDisabled.Code, "Weekly completion bonus disabled or not configured.")
	ErrWeeklyCompletionBonusNotEligible = meta.Error.AppendMessage(errormsg.DailyCompletionBonusNotEligible.Code, "Weekly completion bonus not eligible.")
```

This reuses the existing daily-bonus numeric codes (7008/7009) with weekly-specific messages — the same pattern already used by `ErrMissionEventJoinClosed` in the same file (`meta.Error.AppendMessage(errormsg.TournamentAlreadyJoined.Code, "...")`). `errormsg` and `meta` are already imported in this file. No `shared-lib` change.

- [ ] **Step 2: Re-export in `internal/services/mission_service.go`**

Add these two lines to the `var (...)` re-export block (right after the existing `ErrDailyCompletionBonusNotEligible` line, before `ErrInvalidGoldenPassConfig`):

```go
	ErrWeeklyCompletionBonusDisabled    = missionserr.ErrWeeklyCompletionBonusDisabled
	ErrWeeklyCompletionBonusNotEligible = missionserr.ErrWeeklyCompletionBonusNotEligible
```

- [ ] **Step 3: Verify it compiles**

Run: `go build ./...`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/missionserr/errors.go internal/services/mission_service.go
git commit -m "feat(missions): add weekly completion bonus error vars (TASK-EAR-123)"
```

---

### Task 3: Service layer — `WeeklyService.ClaimWeeklyCompletionBonus`

**Files:**
- Modify: `internal/services/weekly_service.go`
- Modify: `internal/services/weekly_service_test.go` (extend `fakeWeeklyRepo`)
- Create: `internal/services/weekly_completion_bonus_claim_test.go`

**Interfaces:**
- Consumes: Task 1's `HasWeeklyCompletionBonusClaim`/`TryInsertWeeklyCompletionBonusClaim`/`DeleteWeeklyCompletionBonusClaim` (added to the `weeklyMissionRepository` interface below); Task 2's `ErrWeeklyCompletionBonusDisabled`/`ErrWeeklyCompletionBonusNotEligible`; the existing `resolveWeeklyCompletionBonus(cfg models.MissionConfig, plan *models.WeeklyPlan) WeeklyCompletionBonusResolved` (package-level func, `weekly_completion_bonus_resolve.go`); the existing `s.ListWeeklyMissions(ctx, userID)`; the existing `ErrInvalidInput`, `ErrAlreadyClaimed`, `errWeeklyServiceNoWallet`.
- Produces (for Task 4 and Task 6): `func (s *WeeklyService) ClaimWeeklyCompletionBonus(ctx context.Context, userID, idempotencyKey string) (models.MissionResult, error)`.

- [ ] **Step 1: Write the failing tests**

Create `internal/services/weekly_completion_bonus_claim_test.go`:

```go
package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Games-Labs-Missions/internal/models"
)

// weeklyBonusFixtureNow / weeklyBonusFixtureWeekStart pin the window used by
// every test in this file to the same Bangkok week as
// TestListWeeklyMissions_ReturnsProgressClaimabilityAndResetMetadata
// (weekly_service_test.go), for consistency: Friday 2026-05-08 -> week start
// Monday 2026-05-04.
var weeklyBonusFixtureNow = func() time.Time { return time.Date(2026, 5, 8, 12, 0, 0, 0, bangkokLocation) }

const weeklyBonusFixtureWeekStart = "2026-05-04"

func weeklyBonusEnabledConfig() *models.MissionConfig {
	return &models.MissionConfig{
		WeeklyCompletionBonusEnabled:  true,
		WeeklyCompletionBonusReward:   500,
		WeeklyCompletionBonusCurrency: "COIN",
	}
}

// allWeeklyMissionsCompleteCounts satisfies every default weekly mission's
// target (weekly_daily_mission_5=5, weekly_watch_ad_10=10, weekly_mission_boost_1=1).
func allWeeklyMissionsCompleteCounts() map[string]int64 {
	return map[string]int64{
		"daily_mission": 5,
		"watch_ad":      10,
		"mission_boost": 1,
	}
}

func TestClaimWeeklyCompletionBonus_CreditsWhenAllMissionsComplete(t *testing.T) {
	repo := &fakeWeeklyRepo{
		counts:            allWeeklyMissionsCompleteCounts(),
		claims:            make(map[string]*models.WeeklyMissionClaim),
		config:            weeklyBonusEnabledConfig(),
		weeklyBonusClaims: make(map[string]bool),
	}
	wallet := &fakeWeeklyWallet{}
	svc := &WeeklyService{
		wallet:       wallet,
		repo:         repo,
		now:          weeklyBonusFixtureNow,
		definitions:  defaultWeeklyMissionDefinitions,
		memoryClaims: make(map[string]*models.WeeklyMissionClaim),
	}

	result, err := svc.ClaimWeeklyCompletionBonus(context.Background(), "user-1", "")
	if err != nil {
		t.Fatalf("ClaimWeeklyCompletionBonus returned error: %v", err)
	}
	if result.Status != "credited" || result.CreditedCoins != 500 || result.RewardType != "weekly_completion_bonus" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if wallet.calls != 1 {
		t.Fatalf("expected exactly 1 wallet credit call, got %d", wallet.calls)
	}
	got := wallet.requests[0]
	want := models.CreditRequest{
		UserID:         "user-1",
		Amount:         500,
		Currency:       "COIN",
		Reason:         "weekly_completion_bonus",
		IdempotencyKey: "weekly_completion_bonus:user-1:" + weeklyBonusFixtureWeekStart,
		ReferenceType:  "MISSION_REWARD",
		ReferenceID:    weeklyBonusFixtureWeekStart,
	}
	if got != want {
		t.Fatalf("credit request = %+v, want %+v", got, want)
	}
	if !repo.weeklyBonusClaims["user-1:"+weeklyBonusFixtureWeekStart] {
		t.Fatalf("expected claim ledger row to be reserved")
	}
}

func TestClaimWeeklyCompletionBonus_AlreadyClaimedReturnsError(t *testing.T) {
	repo := &fakeWeeklyRepo{
		counts: allWeeklyMissionsCompleteCounts(),
		claims: make(map[string]*models.WeeklyMissionClaim),
		config: weeklyBonusEnabledConfig(),
		weeklyBonusClaims: map[string]bool{
			"user-1:" + weeklyBonusFixtureWeekStart: true,
		},
	}
	wallet := &fakeWeeklyWallet{}
	svc := &WeeklyService{
		wallet:       wallet,
		repo:         repo,
		now:          weeklyBonusFixtureNow,
		definitions:  defaultWeeklyMissionDefinitions,
		memoryClaims: make(map[string]*models.WeeklyMissionClaim),
	}

	_, err := svc.ClaimWeeklyCompletionBonus(context.Background(), "user-1", "")
	if !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("expected ErrAlreadyClaimed, got %v", err)
	}
	if wallet.calls != 0 {
		t.Fatalf("expected no wallet credit call, got %d", wallet.calls)
	}
}

func TestClaimWeeklyCompletionBonus_NotEligibleWhenAnyMissionIncomplete(t *testing.T) {
	counts := allWeeklyMissionsCompleteCounts()
	counts["daily_mission"] = 3 // below the weekly_daily_mission_5 target of 5
	repo := &fakeWeeklyRepo{
		counts:            counts,
		claims:            make(map[string]*models.WeeklyMissionClaim),
		config:            weeklyBonusEnabledConfig(),
		weeklyBonusClaims: make(map[string]bool),
	}
	wallet := &fakeWeeklyWallet{}
	svc := &WeeklyService{
		wallet:       wallet,
		repo:         repo,
		now:          weeklyBonusFixtureNow,
		definitions:  defaultWeeklyMissionDefinitions,
		memoryClaims: make(map[string]*models.WeeklyMissionClaim),
	}

	_, err := svc.ClaimWeeklyCompletionBonus(context.Background(), "user-1", "")
	if !errors.Is(err, ErrWeeklyCompletionBonusNotEligible) {
		t.Fatalf("expected ErrWeeklyCompletionBonusNotEligible, got %v", err)
	}
	if wallet.calls != 0 {
		t.Fatalf("expected no wallet credit call, got %d", wallet.calls)
	}
	if len(repo.weeklyBonusClaims) != 0 {
		t.Fatalf("expected no claim row reserved, got %+v", repo.weeklyBonusClaims)
	}
}

func TestClaimWeeklyCompletionBonus_DisabledWhenBonusNotConfigured(t *testing.T) {
	repo := &fakeWeeklyRepo{
		counts:            allWeeklyMissionsCompleteCounts(),
		claims:            make(map[string]*models.WeeklyMissionClaim),
		config:            &models.MissionConfig{}, // WeeklyCompletionBonusEnabled defaults to false
		weeklyBonusClaims: make(map[string]bool),
	}
	wallet := &fakeWeeklyWallet{}
	svc := &WeeklyService{
		wallet:       wallet,
		repo:         repo,
		now:          weeklyBonusFixtureNow,
		definitions:  defaultWeeklyMissionDefinitions,
		memoryClaims: make(map[string]*models.WeeklyMissionClaim),
	}

	_, err := svc.ClaimWeeklyCompletionBonus(context.Background(), "user-1", "")
	if !errors.Is(err, ErrWeeklyCompletionBonusDisabled) {
		t.Fatalf("expected ErrWeeklyCompletionBonusDisabled, got %v", err)
	}
	if wallet.calls != 0 {
		t.Fatalf("expected no wallet credit call, got %d", wallet.calls)
	}
}

func TestClaimWeeklyCompletionBonus_CreditFailureRollsBackClaim(t *testing.T) {
	repo := &fakeWeeklyRepo{
		counts:            allWeeklyMissionsCompleteCounts(),
		claims:            make(map[string]*models.WeeklyMissionClaim),
		config:            weeklyBonusEnabledConfig(),
		weeklyBonusClaims: make(map[string]bool),
	}
	wallet := &fakeWeeklyWallet{err: errors.New("wallet unavailable")}
	svc := &WeeklyService{
		wallet:       wallet,
		repo:         repo,
		now:          weeklyBonusFixtureNow,
		definitions:  defaultWeeklyMissionDefinitions,
		memoryClaims: make(map[string]*models.WeeklyMissionClaim),
	}

	_, err := svc.ClaimWeeklyCompletionBonus(context.Background(), "user-1", "")
	if err == nil || err.Error() != "wallet unavailable" {
		t.Fatalf("expected the wallet error to propagate, got %v", err)
	}
	if repo.weeklyBonusClaims["user-1:"+weeklyBonusFixtureWeekStart] {
		t.Fatalf("expected the claim row to be rolled back after a credit failure")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/services/ -run 'ClaimWeeklyCompletionBonus' -v`
Expected: FAIL to compile — `svc.ClaimWeeklyCompletionBonus undefined` and `fakeWeeklyRepo` missing the three new methods / `weeklyBonusClaims` field.

- [ ] **Step 3: Extend `fakeWeeklyRepo` in `internal/services/weekly_service_test.go`**

Add a new field to the `fakeWeeklyRepo` struct (right after the existing `activePlan *models.WeeklyPlan` field):

```go
	weeklyBonusClaims map[string]bool // TASK-EAR-123: key is "userID:weekStart"
```

Add these three methods right after the existing `ClaimWeeklyMission` method on `fakeWeeklyRepo`:

```go
func (r *fakeWeeklyRepo) HasWeeklyCompletionBonusClaim(_ context.Context, userID, weekStart string) (bool, error) {
	return r.weeklyBonusClaims[userID+":"+weekStart], nil
}

func (r *fakeWeeklyRepo) TryInsertWeeklyCompletionBonusClaim(_ context.Context, userID, weekStart string, _ int64, _ string) (bool, error) {
	if r.weeklyBonusClaims == nil {
		r.weeklyBonusClaims = make(map[string]bool)
	}
	key := userID + ":" + weekStart
	if r.weeklyBonusClaims[key] {
		return false, nil
	}
	r.weeklyBonusClaims[key] = true
	return true, nil
}

func (r *fakeWeeklyRepo) DeleteWeeklyCompletionBonusClaim(_ context.Context, userID, weekStart string) error {
	delete(r.weeklyBonusClaims, userID+":"+weekStart)
	return nil
}

func (r *fakeWeeklyRepo) RecordMission(_ context.Context, _, _, _, _ string, _ int64, _ string) error {
	return nil
}
```

- [ ] **Step 4: Extend the `weeklyMissionRepository` interface and add `ClaimWeeklyCompletionBonus` in `internal/services/weekly_service.go`**

Add these four lines to the `weeklyMissionRepository` interface (right after the existing `GetActiveWeeklyPlanByWeek` line):

```go
	// TASK-EAR-123: the weekly completion-bonus claim ledger (mirrors the daily
	// completion-bonus claim methods on MissionService).
	HasWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) (bool, error)
	TryInsertWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string, reward int64, currency string) (bool, error)
	DeleteWeeklyCompletionBonusClaim(ctx context.Context, userID, weekStart string) error
	RecordMission(ctx context.Context, userID, missionType, refID, idempKey string, reward int64, currency string) error
```

Add the new method anywhere in the file after `ClaimWeeklyMission` (e.g. right before `func (s *WeeklyService) definitionByID`):

```go
// ClaimWeeklyCompletionBonus credits the resolved weekly Value Bonus at most
// once per (user, week) when every weekly mission for the current week has
// progress >= target. Mirrors MissionService.ClaimDailyCompletionBonus
// (TASK-EAR-123): the bonus is additive to, and independent of, individually
// claiming each weekly mission — eligibility is gated on completion
// (progress >= target), not on each mission having been separately claimed.
func (s *WeeklyService) ClaimWeeklyCompletionBonus(ctx context.Context, userID, idempotencyKey string) (models.MissionResult, error) {
	if userID == "" {
		return models.MissionResult{}, ErrInvalidInput
	}
	if s.repo == nil {
		return models.MissionResult{
			Status:     "disabled",
			RewardType: "weekly_completion_bonus",
			Message:    "weekly completion bonus is disabled or not configured",
		}, ErrWeeklyCompletionBonusDisabled
	}

	window := weeklyMissionWindow(s.now(), bangkokLocation)
	weekStart := window.StartLocal.Format("2006-01-02")

	cfg, err := s.repo.GetMissionConfig(ctx)
	if err != nil || cfg == nil {
		return models.MissionResult{
			Status:     "disabled",
			RewardType: "weekly_completion_bonus",
			Message:    "weekly completion bonus is disabled or not configured",
		}, ErrWeeklyCompletionBonusDisabled
	}
	var plan *models.WeeklyPlan
	if p, perr := s.repo.GetActiveWeeklyPlanByWeek(ctx, weekStart); perr == nil {
		plan = p
	}
	bonus := resolveWeeklyCompletionBonus(*cfg, plan)
	if !bonus.Enabled || bonus.Reward <= 0 {
		return models.MissionResult{
			Status:     "disabled",
			RewardType: "weekly_completion_bonus",
			Message:    "weekly completion bonus is disabled or not configured",
		}, ErrWeeklyCompletionBonusDisabled
	}

	key := idempotencyKey
	if key == "" {
		key = fmt.Sprintf("weekly_completion_bonus:%s:%s", userID, weekStart)
	}

	list, err := s.ListWeeklyMissions(ctx, userID)
	if err != nil {
		return models.MissionResult{}, err
	}
	if len(list.Missions) == 0 {
		return models.MissionResult{
			Status:     "not_claimable",
			RewardType: "weekly_completion_bonus",
			Message:    "no eligible weekly missions configured",
		}, ErrWeeklyCompletionBonusNotEligible
	}
	for _, mission := range list.Missions {
		if mission.Progress < mission.Target {
			return models.MissionResult{
				Status:     "not_claimable",
				RewardType: "weekly_completion_bonus",
				Message:    "not all weekly missions are complete",
			}, ErrWeeklyCompletionBonusNotEligible
		}
	}

	reward := bonus.Reward
	currency := bonus.Currency
	if currency == "" {
		currency = models.CurrencyCoin
	}

	inserted, err := s.repo.TryInsertWeeklyCompletionBonusClaim(ctx, userID, weekStart, reward, currency)
	if err != nil {
		return models.MissionResult{}, err
	}
	if !inserted {
		return models.MissionResult{Status: "already_claimed", RewardType: "weekly_completion_bonus", Message: "already claimed for this week"}, ErrAlreadyClaimed
	}

	if s.wallet == nil {
		_ = s.repo.DeleteWeeklyCompletionBonusClaim(ctx, userID, weekStart)
		return models.MissionResult{}, errWeeklyServiceNoWallet
	}

	req := models.CreditRequest{
		UserID:         userID,
		Amount:         float64(reward),
		Currency:       currency,
		Reason:         "weekly_completion_bonus",
		IdempotencyKey: key,
		ReferenceType:  "MISSION_REWARD",
		ReferenceID:    weekStart,
	}
	if err := s.wallet.Credit(ctx, req); err != nil {
		_ = s.repo.DeleteWeeklyCompletionBonusClaim(ctx, userID, weekStart)
		return models.MissionResult{}, err
	}

	_ = s.repo.RecordMission(ctx, userID, "weekly_completion_bonus", weekStart, key, reward, currency)

	return models.MissionResult{
		Status:        "credited",
		CreditedCoins: reward,
		RewardType:    "weekly_completion_bonus",
	}, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/services/ -run 'ClaimWeeklyCompletionBonus' -v`
Expected: PASS (5 tests).

Also run the whole `services` package to confirm `fakeWeeklyRepo`'s new methods didn't break any existing weekly test: `go test ./internal/services/ -count=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/services/weekly_service.go internal/services/weekly_service_test.go internal/services/weekly_completion_bonus_claim_test.go
git commit -m "feat(missions): add WeeklyService.ClaimWeeklyCompletionBonus (TASK-EAR-123)"
```

---

### Task 4: Response enrichment — `claimable`/`claimed` on `WeeklyCompletionBonus`

**Files:**
- Modify: `internal/models/models.go`
- Modify: `internal/services/weekly_service.go` (`completionBonus` signature + its one call site)
- Modify: `internal/services/weekly_service_test.go` (new test)

**Interfaces:**
- Consumes: Task 1's `HasWeeklyCompletionBonusClaim` (already added to `weeklyMissionRepository` and `fakeWeeklyRepo` in Task 3).
- Produces (for Task 5): `models.WeeklyCompletionBonus.Claimable bool` / `.Claimed bool`, populated inside `WeeklyService.ListWeeklyMissions`'s existing `CompletionBonus: s.completionBonus(...)` call — so `GET /api/v1/missions/weekly` gets these fields automatically once this task lands.

- [ ] **Step 1: Write the failing test**

Add to `internal/services/weekly_service_test.go`, right after `TestListWeeklyMissions_ReturnsProgressClaimabilityAndResetMetadata`:

```go
func TestListWeeklyMissions_CompletionBonusClaimableAndClaimed(t *testing.T) {
	baseRepo := func() *fakeWeeklyRepo {
		return &fakeWeeklyRepo{
			counts:            allWeeklyMissionsCompleteCounts(),
			claims:            make(map[string]*models.WeeklyMissionClaim),
			config:            weeklyBonusEnabledConfig(),
			weeklyBonusClaims: make(map[string]bool),
		}
	}
	newSvc := func(repo *fakeWeeklyRepo) *WeeklyService {
		return &WeeklyService{
			wallet:       &fakeWeeklyWallet{},
			repo:         repo,
			now:          weeklyBonusFixtureNow,
			definitions:  defaultWeeklyMissionDefinitions,
			memoryClaims: make(map[string]*models.WeeklyMissionClaim),
		}
	}

	t.Run("claimable when all missions complete and not yet claimed", func(t *testing.T) {
		resp, err := newSvc(baseRepo()).ListWeeklyMissions(context.Background(), "user-1")
		if err != nil {
			t.Fatalf("ListWeeklyMissions error: %v", err)
		}
		if !resp.CompletionBonus.Enabled || !resp.CompletionBonus.Claimable || resp.CompletionBonus.Claimed {
			t.Fatalf("unexpected completion bonus: %+v", resp.CompletionBonus)
		}
	})

	t.Run("not claimable when a mission is incomplete", func(t *testing.T) {
		repo := baseRepo()
		repo.counts["daily_mission"] = 3
		resp, err := newSvc(repo).ListWeeklyMissions(context.Background(), "user-1")
		if err != nil {
			t.Fatalf("ListWeeklyMissions error: %v", err)
		}
		if resp.CompletionBonus.Claimable {
			t.Fatalf("expected not claimable with an incomplete mission: %+v", resp.CompletionBonus)
		}
	})

	t.Run("claimed and not claimable when already claimed", func(t *testing.T) {
		repo := baseRepo()
		repo.weeklyBonusClaims["user-1:"+weeklyBonusFixtureWeekStart] = true
		resp, err := newSvc(repo).ListWeeklyMissions(context.Background(), "user-1")
		if err != nil {
			t.Fatalf("ListWeeklyMissions error: %v", err)
		}
		if !resp.CompletionBonus.Claimed || resp.CompletionBonus.Claimable {
			t.Fatalf("unexpected completion bonus for already-claimed: %+v", resp.CompletionBonus)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/services/ -run 'TestListWeeklyMissions_CompletionBonusClaimableAndClaimed' -v`
Expected: FAIL — `resp.CompletionBonus.Claimable undefined` (field doesn't exist on `models.WeeklyCompletionBonus` yet).

- [ ] **Step 3: Add `Claimable`/`Claimed` to `models.WeeklyCompletionBonus` in `internal/models/models.go`**

Replace the existing struct (and its now-outdated doc comment) with:

```go
// WeeklyCompletionBonus is the "complete all weekly missions" bonus configured
// on the mission_config singleton (weekly_completion_bonus_*), or overridden
// per-week on the active plan (migration 045). Claimable/Claimed report the
// live claim state (TASK-EAR-123): Claimable is true only when Enabled, the
// reward is positive, every weekly mission is complete, and it has not
// already been claimed for this week.
type WeeklyCompletionBonus struct {
	Enabled   bool                `json:"enabled"`
	Reward    WeeklyMissionReward `json:"reward"`
	Claimable bool                `json:"claimable"`
	Claimed   bool                `json:"claimed"`
}
```

- [ ] **Step 4: Thread `userID` into `completionBonus` and populate the two new fields**

In `internal/services/weekly_service.go`, this method currently has no `userID` parameter and is called from exactly one place (`ListWeeklyMissions`, in the same file). Replace the whole method:

```go
// completionBonus resolves the weekly Value Bonus for the given user/week: the
// active plan's per-week override (weekly_plans.bonus_*, migration 045) when
// set, else the mission_config singleton. Also reports live Claimable/Claimed
// state (TASK-EAR-123). Best-effort: this is auxiliary display data, so a read
// failure yields a disabled bonus instead of failing the whole missions list.
// Currency arrives already normalized (the admin write path uppercases it).
func (s *WeeklyService) completionBonus(ctx context.Context, userID string, weekStart time.Time, allComplete bool) models.WeeklyCompletionBonus {
	if s.repo == nil {
		return models.WeeklyCompletionBonus{}
	}
	cfg, err := s.repo.GetMissionConfig(ctx)
	if err != nil || cfg == nil {
		return models.WeeklyCompletionBonus{}
	}
	var plan *models.WeeklyPlan
	if p, perr := s.repo.GetActiveWeeklyPlanByWeek(ctx, weekStart.Format("2006-01-02")); perr == nil {
		plan = p
	}
	resolved := resolveWeeklyCompletionBonus(*cfg, plan)
	if !resolved.Enabled || resolved.Reward <= 0 {
		return models.WeeklyCompletionBonus{}
	}
	claimed, _ := s.repo.HasWeeklyCompletionBonusClaim(ctx, userID, weekStart.Format("2006-01-02"))
	return models.WeeklyCompletionBonus{
		Enabled: true,
		Reward: models.WeeklyMissionReward{
			Amount:   resolved.Reward,
			Currency: resolved.Currency,
		},
		Claimable: allComplete && !claimed,
		Claimed:   claimed,
	}
}
```

Note: `allComplete` is passed in rather than recomputed here, because `ListWeeklyMissions` (the only caller) already has the per-mission `Progress`/`Target` data in hand right before this call — recomputing it here would mean a second, redundant iteration and (worse) a second, potentially inconsistent notion of "complete" if the two ever drifted.

- [ ] **Step 5: Update `ListWeeklyMissions`'s call site**

In `internal/services/weekly_service.go`, `ListWeeklyMissions` currently ends with:

```go
	return &models.WeeklyMissionsResponse{
		UserID:          userID,
		WeekStart:       window.StartLocal.Format("2006-01-02"),
		WeekEnd:         window.EndLocal.AddDate(0, 0, -1).Format("2006-01-02"),
		ResetAt:         window.ResetAt.Format(time.RFC3339),
		ResetInSeconds:  secondsUntilReset(window.ResetAt, s.now()),
		Missions:        missions,
		CompletionBonus: s.completionBonus(ctx, window.StartLocal),
	}, nil
}
```

Replace it with (computing `allComplete` from the already-built `missions` slice, and passing `userID`/`allComplete` into the updated `completionBonus`):

```go
	allComplete := len(missions) > 0
	for _, m := range missions {
		if m.Progress < m.Target {
			allComplete = false
			break
		}
	}

	return &models.WeeklyMissionsResponse{
		UserID:          userID,
		WeekStart:       window.StartLocal.Format("2006-01-02"),
		WeekEnd:         window.EndLocal.AddDate(0, 0, -1).Format("2006-01-02"),
		ResetAt:         window.ResetAt.Format(time.RFC3339),
		ResetInSeconds:  secondsUntilReset(window.ResetAt, s.now()),
		Missions:        missions,
		CompletionBonus: s.completionBonus(ctx, userID, window.StartLocal, allComplete),
	}, nil
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/services/ -run 'TestListWeeklyMissions' -v`
Expected: PASS, including the pre-existing `TestListWeeklyMissions_ReturnsProgressClaimabilityAndResetMetadata` (unaffected — it never asserts on `CompletionBonus`).

Run the full package: `go test ./internal/services/ -count=1`
Expected: PASS, zero regressions.

- [ ] **Step 7: Commit**

```bash
git add internal/models/models.go internal/services/weekly_service.go internal/services/weekly_service_test.go
git commit -m "feat(missions): surface claimable/claimed on the weekly completion bonus (TASK-EAR-123)"
```

---

### Task 5: Quest overview enrichment — reuse one `ListWeeklyMissions` call

**Files:**
- Modify: `internal/services/quest_overview_service.go`
- Modify: `internal/services/quest_overview_service_test.go`
- Modify: `internal/services/weekly_completion_bonus_resolve.go` (Step 7 only — delete the dead `MissionService.ResolveWeeklyCompletionBonusForWeek`)

**Interfaces:**
- Consumes: Task 4's enriched `models.WeeklyCompletionBonus{Claimable, Claimed}` (already flows through `weeklySource.ListWeeklyMissions`'s response, no new interface needed).
- Produces: `QuestOverviewWeeklyCompletionBonus` gains `Total`/`Completed`/`Claimable`/`Claimed`, matching `QuestOverviewDailyCompletionBonus`'s shape. `GET /api/v1/quest/overview`'s `weekly_completion_bonus` object gains these fields with **zero additional `ListWeeklyMissions` calls** (reuses the one `buildTabs` already makes).
- Removes: `questProgressSource.ResolveWeeklyCompletionBonusForWeek` and `MissionService.ResolveWeeklyCompletionBonusForWeek` (dead once Step 6 lands). No later task may reference either.

- [ ] **Step 1: Write the failing test**

Replace the existing `TestBuildQuestOverviewWeeklyCompletionBonus` in `internal/services/quest_overview_service_test.go` (currently calls `buildQuestOverviewWeeklyCompletionBonus(WeeklyCompletionBonusResolved{...})` — this signature is changing) with:

```go
// TASK-EAR-123: the overview's weekly_completion_bonus block now mirrors
// daily_completion_bonus's shape (Total/Completed/Claimable/Claimed/Reward),
// built from the SAME WeeklyMissionsResponse buildTabs already fetches — no
// second ListWeeklyMissions call, no dependency on the now-removed
// resolveWeeklyCompletionBonusThisWeek path.
func TestBuildQuestOverviewWeeklyCompletionBonus(t *testing.T) {
	allComplete := &models.WeeklyMissionsResponse{
		Missions: []models.WeeklyMissionCard{
			{MissionID: "m1", Progress: 5, Target: 5},
			{MissionID: "m2", Progress: 10, Target: 10},
		},
		CompletionBonus: models.WeeklyCompletionBonus{
			Enabled:   true,
			Reward:    models.WeeklyMissionReward{Amount: 50, Currency: "point"},
			Claimable: true,
			Claimed:   false,
		},
	}
	got := buildQuestOverviewWeeklyCompletionBonus(allComplete)
	if !got.Enabled || got.Total != 2 || got.Completed != 2 || !got.Claimable || got.Claimed {
		t.Fatalf("unexpected enabled bonus: %+v", got)
	}
	if got.Reward.Amount != 50 || got.Reward.Currency != "POINT" {
		t.Fatalf("unexpected reward: %+v", got.Reward)
	}

	partial := &models.WeeklyMissionsResponse{
		Missions: []models.WeeklyMissionCard{
			{MissionID: "m1", Progress: 3, Target: 5},
			{MissionID: "m2", Progress: 10, Target: 10},
		},
		CompletionBonus: models.WeeklyCompletionBonus{
			Enabled: true,
			Reward:  models.WeeklyMissionReward{Amount: 50, Currency: "point"},
		},
	}
	if got := buildQuestOverviewWeeklyCompletionBonus(partial); got.Total != 2 || got.Completed != 1 || got.Claimable {
		t.Fatalf("unexpected partial-completion bonus: %+v", got)
	}

	for name, resp := range map[string]*models.WeeklyMissionsResponse{
		"disabled": {
			Missions:        []models.WeeklyMissionCard{{MissionID: "m1", Progress: 5, Target: 5}},
			CompletionBonus: models.WeeklyCompletionBonus{Enabled: false, Reward: models.WeeklyMissionReward{Amount: 50, Currency: "point"}},
		},
		"non-positive": {
			Missions:        []models.WeeklyMissionCard{{MissionID: "m1", Progress: 5, Target: 5}},
			CompletionBonus: models.WeeklyCompletionBonus{Enabled: true, Reward: models.WeeklyMissionReward{Amount: 0, Currency: "point"}},
		},
		"nil response": nil,
	} {
		got := buildQuestOverviewWeeklyCompletionBonus(resp)
		if got.Enabled || got.Reward.Amount != 0 || got.Reward.Currency != "" {
			t.Fatalf("%s: expected zeroed disabled bonus, got %+v", name, got)
		}
	}
}
```

Then fix the one other broken call site — `TestQuestOverviewWeeklyDisplayNamesUseWeeklyTemplates`. It currently reads:

```go
	svc := NewQuestOverviewService(nil, nil, questWeeklySourceStub{response: &models.WeeklyMissionsResponse{
		Missions: []models.WeeklyMissionCard{
			{MissionID: "weekly-game", Title: "game_turnover", ConditionType: "TURNOVER_GAME_POOL"},
			{MissionID: "weekly-any", Title: "any_game_turnover", ConditionType: "TURNOVER_AMOUNT"},
			{MissionID: "weekly-spend", Title: "spend_prop", ConditionType: "SPEND_DIAMOND_AMOUNT", Target: 500},
			{MissionID: "weekly-manual", Title: "Weekend Sprint", ConditionType: "TURNOVER_AMOUNT"},
		},
	}}, nil, nil)

	tab := svc.buildWeeklyTab(context.Background(), "user-1", cfg)
```

`buildWeeklyTab` no longer reads `s.weeklySource`, so leaving the missions in the stub would leave two copies of the same fixture with only one of them actually driving the assertions. Move the fixture to the call and pass an empty stub (still required positionally by `NewQuestOverviewService`). Replace both statements above with:

```go
	svc := NewQuestOverviewService(nil, nil, questWeeklySourceStub{}, nil, nil)

	tab := svc.buildWeeklyTab(&models.WeeklyMissionsResponse{
		Missions: []models.WeeklyMissionCard{
			{MissionID: "weekly-game", Title: "game_turnover", ConditionType: "TURNOVER_GAME_POOL"},
			{MissionID: "weekly-any", Title: "any_game_turnover", ConditionType: "TURNOVER_AMOUNT"},
			{MissionID: "weekly-spend", Title: "spend_prop", ConditionType: "SPEND_DIAMOND_AMOUNT", Target: 500},
			{MissionID: "weekly-manual", Title: "Weekend Sprint", ConditionType: "TURNOVER_AMOUNT"},
		},
	}, cfg)
```

The rest of that test (the `wants` slice and its assertion loop) is unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/services/ -run 'TestBuildQuestOverviewWeeklyCompletionBonus|TestQuestOverviewWeeklyDisplayNamesUseWeeklyTemplates' -v`
Expected: FAIL to compile (`buildQuestOverviewWeeklyCompletionBonus` still takes the old `WeeklyCompletionBonusResolved` type; `buildWeeklyTab` still takes `(ctx, userID, cfg)`).

- [ ] **Step 3: Add `Total`/`Completed` to `QuestOverviewWeeklyCompletionBonus`**

In `internal/services/quest_overview_service.go`, replace:

```go
type QuestOverviewWeeklyCompletionBonus struct {
	Enabled bool                `json:"enabled"`
	Reward  QuestOverviewReward `json:"reward"`
}
```

with:

```go
type QuestOverviewWeeklyCompletionBonus struct {
	Total     int64               `json:"total"`
	Completed int64               `json:"completed"`
	Claimable bool                `json:"claimable"`
	Claimed   bool                `json:"claimed"`
	Enabled   bool                `json:"enabled"`
	Reward    QuestOverviewReward `json:"reward"`
}
```

Also update its doc comment (currently says "weekly has no claim flow yet") — replace the comment block directly above the struct:

```go
// QuestOverviewWeeklyCompletionBonus is the weekly Value Bonus, mirroring
// QuestOverviewDailyCompletionBonus's shape (TASK-EAR-123): Total/Completed
// count weekly missions, Claimable/Claimed report live claim state.
```

- [ ] **Step 4: Rewrite `buildQuestOverviewWeeklyCompletionBonus`**

Replace the whole function:

```go
func buildQuestOverviewWeeklyCompletionBonus(resp *models.WeeklyMissionsResponse) QuestOverviewWeeklyCompletionBonus {
	zeroed := QuestOverviewWeeklyCompletionBonus{
		Reward: QuestOverviewReward{
			Type:     normalizeRewardType(""),
			Amount:   0,
			Currency: questOverviewRewardCurrency(""),
		},
	}
	if resp == nil || !resp.CompletionBonus.Enabled || resp.CompletionBonus.Reward.Amount <= 0 {
		return zeroed
	}

	total := int64(len(resp.Missions))
	var completed int64
	for _, m := range resp.Missions {
		if m.Progress >= m.Target {
			completed++
		}
	}

	return QuestOverviewWeeklyCompletionBonus{
		Total:     total,
		Completed: completed,
		Claimable: resp.CompletionBonus.Claimable,
		Claimed:   resp.CompletionBonus.Claimed,
		Enabled:   true,
		Reward: QuestOverviewReward{
			Type:     normalizeRewardType(resp.CompletionBonus.Reward.Currency),
			Amount:   resp.CompletionBonus.Reward.Amount,
			Currency: questOverviewRewardCurrency(resp.CompletionBonus.Reward.Currency),
		},
	}
}
```

- [ ] **Step 5: Change `buildWeeklyTab`'s signature to take the response directly**

Replace:

```go
func (s *QuestOverviewService) buildWeeklyTab(ctx context.Context, userID string, cfg models.MissionConfig) QuestOverviewTab {
	tab := placeholderQuestTab("weekly", "Weekly")
	if s.weeklySource == nil {
		return tab
	}

	resp, err := s.weeklySource.ListWeeklyMissions(ctx, userID)
	if err != nil || resp == nil {
		return tab
	}

	tab.Active = true
```

with:

```go
func (s *QuestOverviewService) buildWeeklyTab(resp *models.WeeklyMissionsResponse, cfg models.MissionConfig) QuestOverviewTab {
	tab := placeholderQuestTab("weekly", "Weekly")
	if resp == nil {
		return tab
	}

	tab.Active = true
```

(The rest of the function body — `tab.ResetInSeconds = resp.ResetInSeconds` through the closing `return tab` — is unchanged; it already only reads from `resp` and `cfg`.)

- [ ] **Step 6: Update `buildTabs` and `GetOverview` to fetch `ListWeeklyMissions` once and reuse it**

Replace `buildTabs`:

```go
func (s *QuestOverviewService) buildTabs(ctx context.Context, userID string, progress models.MissionProgress, cfg models.MissionConfig) []QuestOverviewTab {
	return []QuestOverviewTab{
		s.buildDailyTab(progress, cfg),
		s.buildWeeklyTab(ctx, userID, cfg),
		s.buildMonthlyTab(progress, cfg),
		s.buildEventTab(ctx, userID),
		s.buildInviteTab(ctx, userID),
	}
}
```

with:

```go
func (s *QuestOverviewService) buildTabs(ctx context.Context, userID string, progress models.MissionProgress, cfg models.MissionConfig, weeklyResp *models.WeeklyMissionsResponse) []QuestOverviewTab {
	return []QuestOverviewTab{
		s.buildDailyTab(progress, cfg),
		s.buildWeeklyTab(weeklyResp, cfg),
		s.buildMonthlyTab(progress, cfg),
		s.buildEventTab(ctx, userID),
		s.buildInviteTab(ctx, userID),
	}
}
```

In `GetOverview`, replace:

```go
	overview := &QuestOverview{
		User: QuestOverviewUser{
			UserID:   userID,
			VipLabel: "",
			Partial:  false,
			NextLevelProgress: QuestOverviewProgressStat{
				Current: 0,
				Target:  0,
				Unit:    "exp",
			},
		},
		Tabs: s.buildTabs(ctx, userID, progress, cfg),
		BonusReward: QuestOverviewBonusReward{
			Total:     int64(progress.Monthly.TotalDays),
			Current:   int64(progress.Monthly.LoginsCount),
			Claimable: progress.Monthly.IsCompleted && !progress.Monthly.RewardClaimed,
			Reward: QuestOverviewReward{
				Type:     normalizeRewardType(cfg.MonthlyChallengeCurrency),
				Amount:   cfg.MonthlyChallengeReward,
				Currency: questOverviewRewardCurrency(cfg.MonthlyChallengeCurrency),
			},
		},
		DailyCompletionBonus:  buildQuestOverviewDailyCompletionBonus(s.resolveDailyCompletionBonusToday(ctx), progress),
		WeeklyCompletionBonus: buildQuestOverviewWeeklyCompletionBonus(s.resolveWeeklyCompletionBonusThisWeek(ctx)),
	}
```

with:

```go
	var weeklyResp *models.WeeklyMissionsResponse
	if s.weeklySource != nil {
		if resp, err := s.weeklySource.ListWeeklyMissions(ctx, userID); err == nil {
			weeklyResp = resp
		}
	}

	overview := &QuestOverview{
		User: QuestOverviewUser{
			UserID:   userID,
			VipLabel: "",
			Partial:  false,
			NextLevelProgress: QuestOverviewProgressStat{
				Current: 0,
				Target:  0,
				Unit:    "exp",
			},
		},
		Tabs: s.buildTabs(ctx, userID, progress, cfg, weeklyResp),
		BonusReward: QuestOverviewBonusReward{
			Total:     int64(progress.Monthly.TotalDays),
			Current:   int64(progress.Monthly.LoginsCount),
			Claimable: progress.Monthly.IsCompleted && !progress.Monthly.RewardClaimed,
			Reward: QuestOverviewReward{
				Type:     normalizeRewardType(cfg.MonthlyChallengeCurrency),
				Amount:   cfg.MonthlyChallengeReward,
				Currency: questOverviewRewardCurrency(cfg.MonthlyChallengeCurrency),
			},
		},
		DailyCompletionBonus:  buildQuestOverviewDailyCompletionBonus(s.resolveDailyCompletionBonusToday(ctx), progress),
		WeeklyCompletionBonus: buildQuestOverviewWeeklyCompletionBonus(weeklyResp),
	}
```

- [ ] **Step 7: Delete the whole now-dead `ResolveWeeklyCompletionBonusForWeek` chain**

Step 6 removed the only production caller of this chain, leaving all four pieces below dead. Operator decision (2026-07-12, pre-flight review): delete them rather than leave dead code. Verified before planning: `ResolveWeeklyCompletionBonusForWeek`'s only non-test caller was `quest_overview_service.go:661` (inside `resolveWeeklyCompletionBonusThisWeek`). Its sibling `ResolveWeeklyPlanCompletionBonus` is NOT dead (real caller: `internal/handlers/adminmission/http/weekly_plans.go:101`) — do not touch it. The free function `resolveWeeklyCompletionBonus(cfg, plan)` is also NOT dead (used by `WeeklyService.completionBonus` and `MissionService.ResolveWeeklyPlanCompletionBonus`) — do not touch it.

Delete 1 of 4 — from `internal/services/quest_overview_service.go`:

```go
func (s *QuestOverviewService) resolveWeeklyCompletionBonusThisWeek(ctx context.Context) WeeklyCompletionBonusResolved {
	weekStart := weeklyMissionWindow(s.now(), bangkokLocation).StartLocal.Format("2006-01-02")
	return s.progressSource.ResolveWeeklyCompletionBonusForWeek(ctx, weekStart)
}
```

Delete 2 of 4 — from the `questProgressSource` interface in `internal/services/quest_overview_service.go`, remove the method and its doc comment:

```go
	// ResolveWeeklyCompletionBonusForWeek is the weekly analog (per-week plan
	// override first, singleton fallback; TASK-EAR-094). weekStart is the
	// Bangkok-Monday "2006-01-02" key.
	ResolveWeeklyCompletionBonusForWeek(ctx context.Context, weekStart string) WeeklyCompletionBonusResolved
```

Delete 3 of 4 — from `internal/services/weekly_completion_bonus_resolve.go`, remove the method and its doc comment:

```go
// ResolveWeeklyCompletionBonusForWeek resolves the bonus for the week starting
// at the given Bangkok Monday ("2006-01-02") by loading that week's active plan
// — used by the public weekly missions response and the quest overview so both
// show exactly what a future claim path would pay (daily parity:
// ResolveDailyCompletionBonusForDate).
func (s *MissionService) ResolveWeeklyCompletionBonusForWeek(ctx context.Context, weekStart string) WeeklyCompletionBonusResolved {
	cfg := s.GetConfig()
	var plan *models.WeeklyPlan
	if s.repo != nil && strings.TrimSpace(weekStart) != "" {
		if p, err := s.repo.GetActiveWeeklyPlanByWeek(ctx, weekStart); err == nil {
			plan = p
		}
	}
	return resolveWeeklyCompletionBonus(cfg, plan)
}
```

After deleting it, check whether `strings` and `context` are still used elsewhere in `weekly_completion_bonus_resolve.go`; if either import is now unused, remove it (`go build ./...` will tell you).

Delete 4 of 4 — from `internal/services/quest_overview_service_test.go`, remove the stub method (it exists only to satisfy the interface method deleted above) and its doc comment:

```go
func (s questProgressSourceStub) ResolveWeeklyCompletionBonusForWeek(_ context.Context, weekStart string) WeeklyCompletionBonusResolved {
	if res, ok := s.weeklyBonusByWeek[weekStart]; ok {
		return res
	}
	return resolveWeeklyCompletionBonus(s.config, nil)
}
```

Also remove the now-unused `weeklyBonusByWeek` field (and its doc comment) from the `questProgressSourceStub` struct:

```go
	// weeklyBonusByWeek injects a per-week resolved bonus keyed by Bangkok-Monday
	// "2006-01-02"; absent weeks fall back to the singleton config, matching the
	// production resolver's behaviour (TASK-EAR-094).
	weeklyBonusByWeek map[string]WeeklyCompletionBonusResolved
```

Verified before planning: no test sets `weeklyBonusByWeek` (its only references are the field declaration, its doc comment, and the stub method being deleted), so nothing else needs updating. `TestResolveWeeklyCompletionBonus` (which tests the still-live free function `resolveWeeklyCompletionBonus`) stays exactly as-is — do not delete it.

- [ ] **Step 8: Run tests to verify they pass**

Run: `go test ./internal/services/ -run 'TestBuildQuestOverviewWeeklyCompletionBonus|TestQuestOverviewWeeklyDisplayNamesUseWeeklyTemplates' -v`
Expected: PASS.

Run the full package: `go test ./internal/services/ -count=1`
Expected: PASS, zero regressions (including the two `GetOverview`-level tests using `questWeeklySourceStub` at lines ~247 and ~437 — neither asserts on `WeeklyCompletionBonus`'s value, and `buildTabs`'s external behavior for the other tabs is unchanged, so these should pass without modification).

- [ ] **Step 9: Commit**

```bash
git add internal/services/quest_overview_service.go internal/services/quest_overview_service_test.go
git commit -m "feat(missions): reuse one ListWeeklyMissions call for quest overview's weekly bonus (TASK-EAR-123)"
```

---

### Task 6: HTTP handler + apiv1 route

**Files:**
- Modify: `internal/handlers/mission/http/weekly.go`
- Modify: `internal/routes/apiv1.go`
- Test: `internal/handlers/mission/http/weekly_test.go`

**Interfaces:**
- Consumes: Task 3's `WeeklyService.ClaimWeeklyCompletionBonus(ctx, userID, idempotencyKey string) (models.MissionResult, error)`.
- Produces: `POST /api/v1/missions/claim-weekly-completion-bonus` (Missions apiv1 mux only — see Global Constraints; not reachable via api-gateway in this task).

- [ ] **Step 1: Write the failing test**

`internal/handlers/mission/http/weekly_test.go` currently starts with:

```go
package missionhttp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Games-Labs-Missions/internal/models"
	"github.com/Games-Labs-Missions/internal/services"
)

type fakeWeeklyHandlerService struct {
	listResp  *models.WeeklyMissionsResponse
	listErr   error
	claimResp *models.WeeklyMissionClaimResponse
	claimErr  error
}

func (s *fakeWeeklyHandlerService) ListWeeklyMissions(_ context.Context, _ string) (*models.WeeklyMissionsResponse, error) {
	return s.listResp, s.listErr
}

func (s *fakeWeeklyHandlerService) ClaimWeeklyMission(_ context.Context, _ string, _ string) (*models.WeeklyMissionClaimResponse, error) {
	return s.claimResp, s.claimErr
}
```

Replace that whole block (imports through the `ClaimWeeklyMission` method) with:

```go
package missionhttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Games-Labs-Missions/internal/models"
	"github.com/Games-Labs-Missions/internal/services"
)

type fakeWeeklyHandlerService struct {
	listResp       *models.WeeklyMissionsResponse
	listErr        error
	claimResp      *models.WeeklyMissionClaimResponse
	claimErr       error
	claimBonusResp models.MissionResult
	claimBonusErr  error
}

func (s *fakeWeeklyHandlerService) ListWeeklyMissions(_ context.Context, _ string) (*models.WeeklyMissionsResponse, error) {
	return s.listResp, s.listErr
}

func (s *fakeWeeklyHandlerService) ClaimWeeklyMission(_ context.Context, _ string, _ string) (*models.WeeklyMissionClaimResponse, error) {
	return s.claimResp, s.claimErr
}

func (s *fakeWeeklyHandlerService) ClaimWeeklyCompletionBonus(_ context.Context, _, _ string) (models.MissionResult, error) {
	return s.claimBonusResp, s.claimBonusErr
}
```

(this adds the `"encoding/json"` import, the two new struct fields, and the new `ClaimWeeklyCompletionBonus` method — everything else in the file is untouched)

Then append these two test functions at the end of the file:

```go
func TestWeeklyHandlerClaimWeeklyCompletionBonus_Success(t *testing.T) {
	h := NewWeeklyHandler(&fakeWeeklyHandlerService{
		claimBonusResp: models.MissionResult{Status: "credited", CreditedCoins: 500, RewardType: "weekly_completion_bonus"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/missions/claim-weekly-completion-bonus", strings.NewReader(`{"user_id":"user-1"}`))
	w := httptest.NewRecorder()
	h.ClaimWeeklyCompletionBonus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp models.MissionResult
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "credited" || resp.CreditedCoins != 500 {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestWeeklyHandlerClaimWeeklyCompletionBonus_RejectsNonPost(t *testing.T) {
	h := NewWeeklyHandler(&fakeWeeklyHandlerService{})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/missions/claim-weekly-completion-bonus", nil)
	w := httptest.NewRecorder()
	h.ClaimWeeklyCompletionBonus(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/handlers/mission/http/ -run 'ClaimWeeklyCompletionBonus' -v`
Expected: FAIL to compile — `h.ClaimWeeklyCompletionBonus undefined` and `fakeWeeklyHandlerService` missing the new method/fields.

- [ ] **Step 3: Add the interface method, handler, and `writeClaimError` helper in `internal/handlers/mission/http/weekly.go`**

Add one line to the `weeklyMissionHandlerService` interface (after the existing `ClaimWeeklyMission` line):

```go
	ClaimWeeklyCompletionBonus(ctx context.Context, userID, idempotencyKey string) (models.MissionResult, error)
```

Add a `writeClaimError` helper to `WeeklyHandler` (mirrors `MissionHandler.writeClaimError` in `mission.go`) — add it right after the existing `writeSvcError` method:

```go
func (h *WeeklyHandler) writeClaimError(w http.ResponseWriter, body any, err error) {
	if errors.Is(err, services.ErrAlreadyClaimed) {
		httperr.WriteIdempotentSuccess(w, body, err)
		return
	}
	httperr.WriteResult(w, body, err)
}
```

Add the new handler at the end of the file (mirrors `MissionHandler.ClaimDailyCompletionBonus` in `mission.go`):

```go
func (h *WeeklyHandler) ClaimWeeklyCompletionBonus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		UserID         string `json:"user_id"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	idemp := r.Header.Get("Idempotency-Key")
	if req.IdempotencyKey != "" {
		idemp = req.IdempotencyKey
	}

	resp, err := h.svc.ClaimWeeklyCompletionBonus(r.Context(), req.UserID, idemp)
	if err != nil {
		h.writeClaimError(w, resp, err)
		return
	}
	h.writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 4: Register the route in `internal/routes/apiv1.go`**

Add this line right after the existing `mux.HandleFunc("POST /api/v1/missions/weekly/{mission_id}/claim", mission.Weekly.ClaimWeeklyMission)` line:

```go
	mux.HandleFunc("POST /api/v1/missions/claim-weekly-completion-bonus", mission.Weekly.ClaimWeeklyCompletionBonus)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/handlers/mission/http/ -run 'ClaimWeeklyCompletionBonus' -v`
Expected: PASS.

Run the full handlers package and the routes package: `go test ./internal/handlers/... ./internal/routes/... -count=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/handlers/mission/http/weekly.go internal/handlers/mission/http/weekly_test.go internal/routes/apiv1.go
git commit -m "feat(missions): wire POST /api/v1/missions/claim-weekly-completion-bonus (TASK-EAR-123)"
```

---

### Task 7: Full verification + PR to staging

**Files:** none (verification and version control only).

**Interfaces:** none — this task consumes everything produced by Tasks 1–6 as a whole.

- [ ] **Step 1: Full build and vet**

Run: `go build ./...`
Expected: no errors.

Run: `go vet ./...`
Expected: no warnings.

- [ ] **Step 2: Full test suite with race detector**

Run: `go test ./... -race -count=1`
Expected: PASS, all packages, zero regressions (this repo has 11 packages with tests as of TASK-EAR-054/051 in this same session).

- [ ] **Step 3: Confirm the branch was cut from `staging` and push**

```bash
git branch --show-current
git log --oneline staging..HEAD
git push -u origin feat/TASK-EAR-123-weekly-completion-bonus-claim
```

Expected: the branch name matches `feat/TASK-EAR-123-weekly-completion-bonus-claim`; the log shows exactly the 6 commits from Tasks 1–6 (repo, errors, service+claim, response enrichment, quest overview, handler+route).

- [ ] **Step 4: Open a PR against `staging` (not `main`)**

```bash
gh pr create --repo SparqLab/Games-Labs-Missions --base staging --head feat/TASK-EAR-123-weekly-completion-bonus-claim \
  --title "feat(missions): weekly completion bonus claim flow (TASK-EAR-123)" \
  --body "$(cat <<'EOF'
Implements the EAR-094 follow-up: pay the weekly Value Bonus exactly once per
(user, week) when every weekly mission for that week is complete, mirroring
the existing daily-completion-bonus claim flow. Staging only.

- No new migration (weekly_completion_bonus_claims already exists, migration 030).
- No proto/shared-lib/api-gateway change — the claim endpoint is Missions-apiv1-mux-only.
  Mobile reachability via api-gateway is an explicit follow-up task (needs a real proto RPC).
- claimable/claimed added to GET /api/v1/missions/weekly and GET /api/v1/quest/overview
  (both Struct-passthrough — reach mobile automatically once this deploys to staging).

See ai-dev-office/runs/TASK-EAR-123/task.md for the full design and
ai-dev-office/runs/TASK-EAR-123/plan.md for the implementation plan.
EOF
)"
```

- [ ] **Step 5: Update the task run status**

Update `ai-dev-office/runs/TASK-EAR-123/status.yaml`: `phase`/`state` → `in_review`, `current_agent`/`assigned_to` → `reviewer`, and append a `history` entry (2-space indent list, matching this file's existing style) noting the PR URL and that the full suite passed with `-race`. Run `ruby ai-dev-office/validate-yaml.rb TASK-EAR-123` and confirm it passes before committing.

```bash
cd ai-dev-office
git add runs/TASK-EAR-123/status.yaml
git commit -m "chore(runs): TASK-EAR-123 -> in_review (PR opened against staging)"
git push origin main
```

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
