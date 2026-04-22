# Request: Missions Daily Activities - Database Source of Truth

Refactor Daily Activities in Missions service to use the database table (`daily_activities`) as the single source of truth instead of in-memory service state.

## Requested Changes

1. **Repository Layer (mission_repo.go)**
   - Add / use methods:
     - `ListDailyActivities(ctx)`
     - `GetDailyActivityByID(ctx, id)`
     - `UpsertDailyActivity(ctx, act)`
     - `DeleteDailyActivity(ctx, id)` (return `sql.ErrNoRows` when not found)

2. **Service Layer (mission_service.go)**
   - Remove in-memory `dailyActivities` map usage.
   - Remove daily activity seeding from `seedData()`.
   - Update `ClaimDailyMission()` to load activity config from DB.
   - Update `GetProgress()` to load daily activities from DB.
   - Make admin daily activity methods context-aware and return errors.

3. **Handler Layer (mission_handler.go)**
   - Update admin activity endpoints to use new service methods.
   - For `DELETE /api/v1/admin/activities`:
     - return `404` when activity is not found
     - return `500` for other DB errors

## Expected Outcomes

- Admin activity changes persist in DB.
- Activity configuration is consistent across instances/restarts.
- Claim/progress logic reads a single consistent source from DB.

## Verification Targets

- `go test ./...` passes.
- Lints for changed files are clean.
- UAT:
  - Add activity via admin; missions/progress sees new item.
  - Set `active=false`; claim returns `inactive_mission`.
  - Update fixed reward; claim reflects DB value.
  - Delete missing activity returns `404`.
