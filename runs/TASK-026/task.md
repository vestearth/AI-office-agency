# TASK-026: Use Database as Source of Truth for Missions Daily Activities

Epic: Missions Reliability and Consistency

Type: refactor

Priority: high

Depends On:
- None

Target Services:
- Games-Labs-Missions

Target Files:
- Games-Labs-Missions/internal/repositories/mission_repo.go (modify) -- provide complete DB-backed daily activity CRUD/query surface.
- Games-Labs-Missions/internal/services/mission_service.go (modify) -- remove in-memory daily activity state and read activity config from DB in claim/progress paths.
- Games-Labs-Missions/internal/handlers/mission_handler.go (modify) -- wire admin endpoints to context-aware service methods and proper not-found mapping.
- Games-Labs-Missions/internal/services/*_test.go (modify/create) -- add regression tests for DB-backed activity behavior and admin error mapping.
- Games-Labs-Missions/internal/handlers/*_test.go (modify/create) -- ensure delete returns 404 for missing activity and 500 for non-not-found DB failures.

Overview:
Daily activity configuration is currently vulnerable to drift because service memory can diverge from persisted data and reset on restart. This task centralizes daily activity state in `daily_activities` DB table and ensures mission claim/progress/admin flows all use DB-backed reads/writes.

Objectives:
1) Make DB the only source for daily activity definitions used by mission logic.
2) Eliminate in-memory daily activity map and seed coupling.
3) Ensure admin CRUD for daily activities persists and propagates through claim/progress behavior.
4) Normalize handler-level error mapping for delete-not-found (404) vs unexpected DB failures (500).

Acceptance Criteria:
- Mission service no longer depends on in-memory daily activity map for claim/progress.
- `ClaimDailyMission()` resolves activity config from DB and honors active/reward values from persisted data.
- `GetProgress()` returns daily activity data sourced from DB.
- Admin upsert/delete operations persist data in DB and affect subsequent mission behavior across restarts/instances.
- `DELETE /api/v1/admin/activities` returns 404 on missing activity (`sql.ErrNoRows`) and 500 on other DB errors.
- Automated tests cover DB-backed claim/progress behavior and delete error mapping regression.

Test Plan:
1. Add activity via admin API then verify missions/progress surfaces the new activity.
2. Update activity `active=false` and verify claim returns inactive mission response.
3. Update fixed reward in DB and verify claim reflects updated reward.
4. Delete non-existent activity and verify 404 response.
5. Inject generic DB failure on delete and verify 500 response.
6. Run `go test ./...` for Missions service.

Risks and Mitigations:
- Legacy paths may still reference removed in-memory state.
  - Mitigation: grep/code review for all daily activity lookups and replace with repository-backed access.
- DB latency/outage now directly impacts mission config reads.
  - Mitigation: return clear errors, keep handlers mapping consistent, and ensure retries/timeouts follow current patterns.
- Behavior drift if tests only cover happy paths.
  - Mitigation: add explicit regression tests for inactive, reward updates, and delete-not-found mapping.

Assigned Agent: dev

Reviewer Focus:
- Confirm all daily activity reads/writes are DB-backed.
- Confirm no in-memory fallback path remains.
- Confirm handler status codes for delete path (404 vs 500) are correct and tested.
