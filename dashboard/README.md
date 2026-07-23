# AI Dev Office Dashboard

Filesystem-backed operational dashboard for `ai-dev-office/runs`. Most views are
read models; the narrow write surface is documented below.

## Views

- `Command`: command-center shell with live workflow map, queue, agent status, health, logs, and task detail/decision controls
- `Monitor`: browse runs, inspect task details, review timeline, and tail direct log files inside a run directory
- `Action`: operator inbox for awaiting review, pending decision reconciliation, workflow exceptions, and artifact drift; task decisions remain in `Command`
- `Analytics`: read-only workflow metrics built from `runs/`, including health score, failure clusters, trends, long-running work, and agent activity
- `Reports`: project readiness view built from repository source evidence

## Structure

- `server/`: Express + TypeScript API, file watcher, SSE
- `client/`: React + Vite + TypeScript UI
- `shared/`: shared dashboard types

## Install

```bash
cd dashboard
npm run install:all
```

## Run

One command (starts server and client together):

```bash
cd dashboard
npm run dev
```

The one-command dev script waits for `http://localhost:4310/api/health` before
starting the Vite client, so initial `/api/events` proxy connections do not race
the API server startup.

To pass Vite dev-server flags to the client, put them after `--`:

```bash
npm run dev -- --host
```

Or separately:

```bash
# Terminal 1
cd dashboard/server && npm run dev

# Terminal 2
cd dashboard/client && npm run dev
```

The client proxies `/api/*` to the server, so the server must be running for
the UI to show data.

Default URLs:

- server: `http://localhost:4310`
- client: `http://localhost:3000`

## Environment

Server reads these variables:

```env
AI_OFFICE_ROOT=/absolute/path/to/ai-dev-office
DASHBOARD_PORT=4310
SSE_HEARTBEAT_MS=15000
WATCHER_DEBOUNCE_MS=500
WATCHER_MAX_WAIT_MS=5000
LOG_TAIL_LINES=500
DASHBOARD_ALLOWED_ORIGINS=http://localhost:3000
DASHBOARD_AUTH_TOKEN=replace-with-a-shared-token
```

Use `server/.env.example` as the starting point.

`DASHBOARD_AUTH_TOKEN` is optional for local development. When set, every
`/api/*` endpoint except `/api/health` requires the shared bearer token. This is
a deployment guardrail, not user-level authorization.

## Expected AI Dev Office Path

`AI_OFFICE_ROOT` must point to the `ai-dev-office` repo root. The dashboard expects:

- runs at `<AI_OFFICE_ROOT>/runs`
- logs at `<AI_OFFICE_ROOT>/logs`

If `AI_OFFICE_ROOT` is not set, the server defaults to the current repository root relative to `dashboard/server/src/config.ts`.

Ruby 2.4+ must be available on the server `PATH`. Knowledge Reviews delegates
each audit to `scripts/validate-knowledge-librarian.rb --json`, which applies the
schema-derived contract checks, semantic rules, and approved-write policy before
returning a normalized render model. The dashboard does not parse the audit
contract itself. If Ruby or the canonical validator is unavailable, the API
fails instead of downgrading every audit to a malformed file.

## Control Boundary

- Run, review, analytics, report, log, and routing-preview data are derived from
  filesystem artifacts.
- Knowledge Reviews is a read-only projection of validated local
  `knowledge-reviews/*.yaml` audits. It shows scope, findings, and proposed or
  applied changes without applying vault edits from the dashboard.
- Human decisions append to `runs/<task-id>/decision.yaml`; the driver later
  reconciles the latest decision into `status.yaml`. The dashboard never writes
  `status.yaml` directly.
- Identity setup may claim a task prefix in `office.team.yaml` and, when no
  prefix exists, initialize the ignored `office.config.local.yaml`.
- Recommended next actions, role launch, and model/reasoning overrides are
  preview-only. The dashboard does not launch, retry, or dispatch a role and
  does not persist routing overrides.

## Current Limitations

- No direct role launch, retry, or `status.yaml` mutation from the dashboard
- The UI currently keeps both the newer `Command` view and the legacy tab shell; consolidate only with browser layout verification
- Authentication is an optional shared bearer token, not per-user roles or permissions
- Persistence is filesystem-local; there is no database-backed control plane
- Health status is filesystem and watcher based, not service dependency aware
- Log viewing is limited to direct files inside each run directory
- SSE refreshes run summaries and the currently selected log only
- Analytics panels still fetch separate endpoints; there is no consolidated initial overview fetch for the Analytics page yet
- Reports is a readiness summary, not a full markdown report generator
- Knowledge Reviews refreshes on dashboard run events, page load, or its manual
  Refresh control; it does not watch the audit directory directly or validate
  artifacts in the browser

## Phase 2 Analytics

- Supported analytics windows are `days=7`, `days=14`, or `days=30`
- Invalid or unsupported `days` values fall back to `7`
- The Analytics page exposes a 7/14/30-day window selector; the choice is persisted in `sessionStorage` (`dashboard_analytics_days`) and the Reports snapshot mirrors the same window
- `GET /api/analytics` returns read-only workflow metrics generated from `runs/`
- `GET /api/analytics/summary` returns workflow health and status distribution for the selected window
- `GET /api/analytics/trends` returns per-day trend buckets for the selected window
- `GET /api/analytics/failures` returns normalized top failure reasons for the selected window
- `GET /api/analytics/agents` returns per-agent activity totals for the selected window
- `GET /api/analytics/long-running` returns current running tasks ranked by duration and does not use the `days` filter
- There is no cache layer yet; each request recomputes analytics from filesystem data
- The response is split into `summary`, `trends`, and `topFailureReasons` so the API can be broken into dedicated endpoints later if needed
- Workflow health score is distinct from dashboard/server health

## Reports Readiness API

- `GET /api/reports/readiness` returns read-only project readiness metrics generated from repository source evidence
- Current projects: Games Labs, Casper, VerifySlip
- Lanes: API for Backoffice, Backoffice UI, Mobile/FE API
- Games Labs scoring currently uses Backoffice `admin/manage` source files, admin/manage-domain admin API contracts, Backoffice `admin/manage` admin API usage, and matching public/mobile API domains
- Casper readiness is generated from `casperacc` client wiring and
  `casperacc-api` route evidence across API for Client, Storefront UI, and
  Commerce E2E lanes
- VerifySlip currently renders as a waiting project until its repository
  evidence is configured
