# TASK-105: Backoffice Missions shell and Daily Mission Plan UI parity

## Short name
`backoffice-missions-shell-daily-parity`

## Type
feature

## Priority
medium

## Parent / Epic
- Epic: Backoffice Mission management

## Status

Assigned. PM review approved this as the foundation task before opening larger
Weekly, Monthly, Invite, Setting, Schedule, or Create Event work.

## Background

The Backoffice Mission navigation already exposes Daily, Weekly, Monthly, and
Invite under `/admin/manage/missions` using the `type` query. The current page
does not use that query and always renders the Daily Mission Plan with mock data.

Figma node `2333:24031` in `BackOffice GAMESLAB` shows the Mission area, including
the Primary Daily Mission Plan and larger Setting/Schedule/Create Event flows.
This task only covers the mission shell and Daily plan parity slice.

Attached UI references:

- `ai-dev-office/runs/TASK-105/ui-reference/README.md`
- `ai-dev-office/runs/TASK-105/ui-reference/work-captures/task-105-108-109-daily-setting-schedule-user-capture.png`

## Goal

Make `/admin/manage/missions` behave as a real mission shell with Daily as the
default view, query-aware Daily/Weekly/Monthly/Invite states, and Daily Mission
Plan UI parity against the provided Figma slice.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Mission admin UI shell and Daily Mission Plan view. |
| `ai-dev-office` | Task tracking and handoff artifacts. |

### Likely Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/missions/index.vue` | modify | Read `route.query.type`, keep Daily as default, and render the correct mission sub-view. |
| `Games-Labs-backoffice/app/components/mission/DailyPlanCard.vue` | modify | Finish Daily Mission Plan UI parity if gaps remain. |
| `Games-Labs-backoffice/app/data/mock.ts` | modify | Reuse or minimally extend existing mission mock data only if needed for bounded placeholders. |
| `ai-dev-office/runs/TASK-105/*` | create | PM task, status, and handoff artifacts. |

### Explicitly Excluded

- No backend, API, proto, or shared-lib changes.
- No persistence or real CRUD.
- No Setting Default implementation.
- No Schedule implementation.
- No Create Event implementation.
- No Invite backend logic; Invite is UI-only/mock-only when shown.
- No broad redesign outside Backoffice Mission pages/components.

## Acceptance Criteria

- [ ] `/admin/manage/missions` defaults to the Daily Mission Plan.
- [ ] `/admin/manage/missions?type=weekly`, `monthly`, and `invite` no longer render the Daily view by mistake.
- [ ] Daily Mission Plan matches the Figma slice closely enough for PM visual review.
- [ ] Daily/Weekly/Monthly/Invite nav and breadcrumb active states remain correct.
- [ ] Weekly/Monthly/Invite are bounded mock or placeholder states only, clearly not backend-backed.
- [ ] No backend/API persistence claims are introduced.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] Screenshots are captured for Daily and the three query states for PM review.

## Implementation Plan

1. Reuse the existing Mission route, sidebar query links, breadcrumb logic, mock
   data, and mission components.
2. Add the smallest query switch in `missions/index.vue`: invalid or missing
   `type` resolves to Daily.
3. Keep Daily wired to the current `DailyPlanCard` and tighten UI parity only
   where the current screen visibly diverges from Figma.
4. Add simple bounded Weekly, Monthly, and Invite states so the shell is honest
   and does not show Daily content under the wrong tab.
5. Build-verify and capture PM review screenshots.

## Risks

- The provided Figma node is a large board; this task intentionally uses only the
  Mission/Daily slice. Weekly, Monthly, Invite, Setting, Schedule, and Create
  Event need separate acceptance slices before implementation.
- Browser smoke may be login-gated; document the limitation if local auth blocks
  screenshots.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Manual smoke:
  - `/admin/manage/missions`
  - `/admin/manage/missions?type=weekly`
  - `/admin/manage/missions?type=monthly`
  - `/admin/manage/missions?type=invite`

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: one frontend route plus nearby mission components; sequential work avoids
divergent UI states.
