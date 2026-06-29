# TASK-EAR-018: Wire Backoffice Mission pages to the admin API (off mock)

## Short name
`backoffice-mission-admin-api-wiring`

## Type
feature

## Priority
medium

## Parent / Epic
- Depends on: `TASK-105`, `TASK-106`, `TASK-107`, `TASK-108`, `TASK-109`, `TASK-110`
- Epic: Backoffice Mission management

## Lane
Claude manual advisory lane (no automated dev runner; see
`ai-dev-office/docs/CLAUDE.md`). Machine-readable `agent`/`current_agent` use the
standard enum roles; Claude executed this slice in the `dev` role.

## Background / single-source-of-truth verification

TASK-105..110 built the Backoffice Mission management UI on **local/mock state**
(`app/composables/useAdminPageData.ts` -> `import * as mock from '~/data/mock'`;
`missions/edit/index.vue` comments "no admin storage/persistence ... preview
only — not saved to the server").

The Mission backend already guarantees the property the product wants ("edit in
Backoffice -> Mobile reads the same value"), verified in code:

- `Games-Labs-Missions/cmd/main.go` opens **one** Postgres (`sql.Open`), builds
  **one** repo set (`missionRepo`, `storeRepo`), and injects the **same**
  `missionService` / `storeService` into BOTH the mobile handlers
  (`missionhttp.NewHandlers`) and the admin handlers
  (`adminmissionhttp.NewHandler(storeService, missionService)`).
- `internal/handlers/adminmission/grpc/server.go:28` — the gRPC admin server is a
  thin adapter: every method `call(...)`s the **same** `http.HandlerFunc` as the
  REST admin routes via `httpx.CallHandler`. No duplicate logic, no second store.
- `internal/routes/apiv1.go` registers mobile `GET /api/v1/...` and admin
  `PUT/POST /api/v1/admin/...` on the same mux.

=> No new architecture, sync job, or separate config store is needed. The only
gap is **frontend**: rewire the Mission pages from mock to the admin API through
api-gateway, following the live pattern already used by VIP/Provider/Store
(`useVipLevelAdminList.ts`, `useAdminProviderApi.ts`, `useAdminStoreExchangeApi.ts`).

## Deliverable in this run (first draft)

- `Games-Labs-backoffice/app/composables/useAdminMissionApi.ts` — additive,
  currently unused. Typed `$fetch` client over the admin endpoints, reusing
  `vipGatewayBase()`-style base + `useApiBearerHeaders()`, envelope-tolerant
  (`{status,data}` from grpc-gateway OR a raw structpb.Struct body).

## Page -> component -> endpoint map

Gateway base path = `${apiBaseUrl}` (e.g. `https://dev-api-gateway.gameslabs.app`).
All admin verbs go through api-gateway -> `adminmissionpb` (grpc-gateway) ->
Missions gRPC wrapper -> same HTTP handler -> `missionService`/`storeService`.

### `app/pages/admin/manage/missions/index.vue` (5 segmented views)

| View    | Component        | Mock source today              | Admin endpoint(s)                                                                 | Status |
|---------|------------------|--------------------------------|----------------------------------------------------------------------------------|--------|
| daily   | `DailyPlanCard`  | `mockDailyMissionPlan*`        | `GET/POST/DELETE /api/v1/admin/activities`, `GET/PUT /api/v1/admin/activities/{id}`, `.../activate` `.../deactivate`, `GET/POST/PUT/DELETE /api/v1/admin/activity-groups` (+ `/members`) | ✅ COVERED |
| weekly  | `WeeklyPlanCard` | `mockWeeklyMissionPlan*`       | — none — (mobile read is `GET /api/v1/missions/weekly`; no admin write surface)   | ❌ BACKEND GAP |
| monthly | `MonthlyPlanCard`| `mockMonthlyMissionPlan*`      | `GET/PUT /api/v1/admin/check-in/config` (page = "Monthly Check-in Mission Plan")  | ⚠️ PARTIAL (confirm check-in == monthly) |
| invite  | `InvitePlanCard` | `mockInviteMissionPlans`       | — none — (mobile read `GET /api/v1/missions/invite/overview`; service built with `NewInviteOverviewService(nil)`) | ❌ BACKEND GAP |
| event   | `EventPlanCard`  | `mockEventMissionPlans`        | `GET/POST/PUT/DELETE /api/v1/admin/missions/tournaments` IF event==tournament; mission_events (`GET /api/v1/missions/events`) has NO admin CRUD | ⚠️ AMBIGUOUS |

### `app/pages/admin/manage/missions/edit/index.vue` (Mission settings)

| Tab             | Component            | Mock source                  | Admin endpoint(s)                                  | Status |
|-----------------|----------------------|------------------------------|----------------------------------------------------|--------|
| Default Mission | `DefaultMissionForm` | `mockDailyDefaultMissions`   | `GET/PUT /api/v1/admin/missions/config` and/or `POST /api/v1/admin/activities` (upsert daily activity template) | ⚠️ map fields -> activity model |
| Schedule        | `SegmentedTabs`+form | `mockDailyMissionSchedule`   | — no clear storage field (weekday/time). `daily_activities` has UI metadata (mig 019) + groups but not a schedule contract | ❌ BACKEND GAP (TASK-109 already flagged) |

### `app/pages/admin/manage/missions/event/create.vue`

| Step            | Component                       | Mock source              | Admin endpoint                                   | Status |
|-----------------|---------------------------------|--------------------------|--------------------------------------------------|--------|
| condition/reward| `EventStepper`,`NumberStepper`  | `mockDailyDefaultMissions`| `POST /api/v1/admin/missions/tournaments` (create) IF event==tournament | ⚠️ depends on Event definition |
| game select     | `EventGameSelector`             | `mockMissionGameCatalog` | game catalog comes from Game service, not Missions admin | ⚠️ cross-service |
| thumbnail       | `ThumbnailUpload`               | local                    | `POST {gateway}/admin/uploads/{kind}` (`useImageUpload`) | ✅ COVERED |

### Settings not yet surfaced as pages but backend-ready
- `GET/PUT /api/v1/admin/missions/boost/config` (mission boost)
- `GET/POST/PUT/DELETE /api/v1/admin/missions/badges`
- `GET/PUT /api/v1/admin/store/passes/config`, `.../golden-pass/config`
- operational: `POST /api/v1/admin/missions/{reset-streak,daily/reset,force-complete}`, `/admin/store/give-pass`

## BACKEND GAPS — cannot be FE-only (need Missions backend contract first)
1. **Weekly mission config** — no admin write endpoint exists; only the mobile
   read and runtime `weekly_mission_claims`. Needs admin CRUD + table/columns.
2. **Invite mission config** — no admin endpoint; `InviteOverviewService(nil)`
   is effectively a stub. Needs repo + admin CRUD.
3. **Daily Schedule (weekday/time)** — no persisted contract; TASK-109 already
   flagged "Schedule ownership ... requires product/backend clarification".
4. **Event definition** — product must confirm whether Backoffice "Event" maps
   to `tournaments` (admin CRUD exists) or `mission_events` (read-only today,
   no admin CRUD). Drives whether event pages can wire now or need backend.

## Gotchas to carry from Redemption wiring (memory: redemption-admin-api-wiring)
- Update verbs must be **PUT, not POST**, at the gateway (else 405).
- Watch fields with a **`_1` suffix** silently dropped by gateway
  `DiscardUnknown` — verify every field round-trips after save.
- Many admin gRPC methods take/return `structpb.Struct` (free-form JSON), so the
  gateway JSON envelope may differ from the typed `{status,data}` VIP shape —
  `useAdminMissionApi.ts` unwraps defensively.

## Proposed next slice (separate run once gaps triaged)
Wire the ✅ COVERED surfaces first: Daily activities/groups, mission config,
check-in config, boost config, badges, tournaments. Defer weekly/invite/schedule
until backend contracts land.

## Acceptance (this run)
- [x] `useAdminMissionApi.ts` drafted, typechecks against existing composable
      pattern, additive/unused.
- [x] Page->component->endpoint map produced with COVERED vs BACKEND-GAP marks.
- [ ] (next run) Components rewired + round-trip verified against dev gateway.

## Review closeout

Reviewer pass completed on 2026-06-29 against current `main`.

- Source reviewed: weekly admin API client route shapes and current
  `Games-Labs-Missions/internal/routes/apiv1.go` route registrations.
- Verdict: approved for this advisory/design umbrella; concrete implementation
  slices TASK-EAR-019, TASK-EAR-020, and TASK-EAR-021 also passed review.
- Verification: `GOWORK=off go test ./...`, `go vet ./internal/...`, and
  `GOWORK=off go build -mod=readonly ./...` passed in `Games-Labs-Missions`;
  `npm run build` passed in `Games-Labs-backoffice`.
