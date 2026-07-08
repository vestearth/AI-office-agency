# TASK-EAR-082: Monthly check-in future-month default templates

## Short Name

`monthly-checkin-future-months`

## Type

feature

## Priority

medium

## Status

Assigned to Dev on 2026-07-07.

## Background

Admins can edit the current Monthly check-in config and individual configured
months, but future months without a campaign row do not inherit an admin-owned
default. This task implements the approved Approach A from
`Games-Labs-backoffice/docs/superpowers/plans/2026-07-07-monthly-checkin-future-months.md`:
store a default check-in template in `mission_config.check_in_template`, seed
unconfigured months from it on read, and let the Backoffice Monthly board show
template-derived future months.

## Goal

Let admins configure Monthly check-in campaigns for future months via a central
default template while keeping per-month overrides editable and preserving
current-month persistence for claim/ledger foreign keys.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns `mission_config`, check-in config reads/writes, startup backfill, and admin config handlers. |
| `Games-Labs-backoffice` | Owns the Monthly settings page, Monthly board synthesis, and admin mission API composable. |
| `ai-dev-office` | Tracks this cross-repo implementation and verification. |

### Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-Missions/migrations/043_mission_config_check_in_template.sql` | create | Add nullable `mission_config.check_in_template` JSONB column. |
| `Games-Labs-Missions/internal/models/models.go` | modify | Add `MissionConfig.CheckInTemplate`. |
| `Games-Labs-Missions/internal/repositories/mission_repo.go` | modify | Read `check_in_template` and add a targeted writer. |
| `Games-Labs-Missions/internal/repositories/mission_repo_test.go` | modify | Cover config read and targeted template write. |
| `Games-Labs-Missions/internal/services/check_in_calendar_service.go` | modify | Parse template, seed unconfigured months, and backfill if unset. |
| `Games-Labs-Missions/internal/services/mission_service_daily_completion.go` | modify | Add `ApplyCheckInTemplatePatch`. |
| `Games-Labs-Missions/internal/services/check_in_template_test.go` | create | Cover template parsing, seeding, backfill, and patch behavior. |
| `Games-Labs-Missions/internal/handlers/adminmission/http/handler.go` | modify | Apply check-in template patches on `PUT /api/v1/admin/missions/config`. |
| `Games-Labs-Missions/internal/handlers/adminmission/http/activities.go` | modify | Apply check-in template patches on `POST /api/v1/admin/config`. |
| `Games-Labs-Missions/cmd/main.go` | modify | Run one-time startup backfill after service creation. |
| `Games-Labs-backoffice/app/composables/useAdminMissionApi.ts` | modify | Add `check_in_template` type support and `getCheckInTemplate()`. |
| `Games-Labs-backoffice/app/utils/checkInTemplate.ts` | create | Add pure template-to-month summary helpers. |
| `Games-Labs-backoffice/tests/checkInTemplate.test.mjs` | create | Cover template summary synthesis. |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/monthly/settings.vue` | modify | Save Setting Default -> Monthly as the central template. |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/index.vue` | modify | Synthesize absent future months from the template and show origin badge. |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/monthly/edit/[id].vue` | modify | Remove stale comments only. |

## Acceptance Criteria

- `mission_config.check_in_template` exists via migration `043` and is read as `{}` when unset.
- `GetCheckInConfigForMonth` returns template-seeded configs for unconfigured future months without persisting them.
- Current month behavior still persists a campaign row when needed for claim/ledger references.
- Empty or malformed template falls back to existing hardcoded `defaultCheckInConfig`.
- Both admin config handlers persist `check_in_template` through targeted writes that cannot clobber unrelated config fields.
- Startup backfills `check_in_template` from the current active campaign exactly when unset.
- Backoffice Setting Default -> Monthly edits `check_in_template`, not only the current-month campaign.
- The Monthly board renders Next-12 absent months from the template and distinguishes configured rows from template-derived rows.
- Focused backend and frontend tests pass, plus practical build/type checks for touched repos.

## Technical Plan

Follow the implementation plan file task-by-task using TDD where practical:

1. Add migration `043`.
2. Add model field and config read.
3. Add targeted repository writer.
4. Add template parser and month default builder.
5. Seed unconfigured month reads from the template.
6. Add one-time startup backfill.
7. Wire both backend config handlers.
8. Add frontend template API/types.
9. Add frontend template summary helper.
10. Save Monthly settings into the template.
11. Synthesize Monthly board rows from the template and clean stale comments.

## Risks

- Config clobber risk: use targeted writers and mirror existing `schedule_config` patterns.
- Contract drift risk: keep `check_in_template` as `CheckInConfig` minus `campaign` and avoid proto/shared-lib changes.
- Migration conflict risk: current max migration verified as `042`; use `043`.
- UX drift risk: distinguish configured vs template-derived months without changing per-month override behavior.

## Verification Plan

- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-082`
- Backend focused tests for repository and check-in service changes.
- Backend `go build ./...` after service wiring.
- Frontend `node --test --experimental-strip-types tests/checkInTemplate.test.mjs`.
- Frontend build/type check command used by the repo.

