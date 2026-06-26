# TASK-EAR-022: Weekly Option B — B3 admin CRUD (activities/groups)

## Parent / Epic
- Parent: `TASK-EAR-018`. Phase **B3** of `weekly-option-b-design.md`. G1 cleared.
- Depends on B1 (models/tables) + B2 (repo file). Branch: `feat/weekly-b2-progress-mapper`
  (cumulative weekly backend epic = G2 + B1 + B2 + B3).

## Goal
Admin surface so Backoffice can edit weekly activities/groups, mirroring the daily
admin (`/admin/activities`, `/admin/activity-groups`) end to end.

## Slices
- **slice 1 ✅ (this commit 596b19c):** weekly_activities repo CRUD —
  List/Get/Upsert/SetActive/Delete + sqlmock tests. Build/vet/test exit 0.
- **slice 2 (next):** admin HTTP handlers + routes (REST mux) for weekly activities,
  mirroring `adminmission/http/activities.go` + `routes/apiv1.go`.
- **slice 3:** proto (`adminmissionpb`) RPCs + google.api.http + gRPC wrappers +
  `buf generate` regen (gateway exposure — what Backoffice actually calls). buf is
  available at /opt/homebrew/bin/buf.
- **slice 4:** weekly_activity_groups (+members) CRUD + handlers + proto.

## Gateway-facing paths (planned, slice 3) — mirror daily, Update = PUT
- `GET/POST /api/v1/admin/weekly/activities`, `GET/PUT/DELETE .../{id}`,
  `POST .../{id}/activate|deactivate`; groups analogous.

## Notes
weekly_activities has no deeplink/cta columns (omitted from B1). condition_type is
a free VARCHAR (turnover/spend/round families + legacy meta counters).
