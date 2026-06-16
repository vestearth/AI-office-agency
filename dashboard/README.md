# AI Dev Office Dashboard

Read-only monitoring dashboard for `ai-dev-office/runs`.

## Views

- `Command`: command-center shell with live workflow map, queue, agent status, health, logs, and task detail/decision controls
- `Monitor`: browse runs, inspect task details, review timeline, and tail direct log files inside a run directory
- `Review`: review queue and decision controls built from the reviewer read model
- `Analytics`: read-only workflow metrics built from `runs/`, including health score, failure clusters, trends, long-running work, and agent activity
- `Reports`: lightweight snapshot view built from the analytics overview endpoint for quick summary reading

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
LOG_TAIL_LINES=500
```

Use `server/.env.example` as the starting point.

## Expected AI Dev Office Path

`AI_OFFICE_ROOT` must point to the `ai-dev-office` repo root. The dashboard expects:

- runs at `<AI_OFFICE_ROOT>/runs`
- logs at `<AI_OFFICE_ROOT>/logs`

If `AI_OFFICE_ROOT` is not set, the server defaults to the current repository root relative to `dashboard/server/src/config.ts`.

## Current Limitations

- Read-only only; no task control actions
- The UI currently keeps both the newer `Command` view and the legacy tab shell; consolidate only with browser layout verification
- No auth or persistence layer
- Health status is filesystem and watcher based, not service dependency aware
- Log viewing is limited to direct files inside each run directory
- SSE refreshes run summaries and the currently selected log only
- Analytics panels still fetch separate endpoints; there is no consolidated initial overview fetch for the Analytics page yet
- Reports is currently a snapshot summary view, not a full markdown report generator

## Phase 2 Analytics

- Supported analytics windows are `days=7`, `days=14`, or `days=30`
- Invalid or unsupported `days` values fall back to `7`
- `GET /api/analytics` returns read-only workflow metrics generated from `runs/`
- `GET /api/analytics/summary` returns workflow health and status distribution for the selected window
- `GET /api/analytics/trends` returns per-day trend buckets for the selected window
- `GET /api/analytics/failures` returns normalized top failure reasons for the selected window
- `GET /api/analytics/agents` returns per-agent activity totals for the selected window
- `GET /api/analytics/long-running` returns current running tasks ranked by duration and does not use the `days` filter
- There is no cache layer yet; each request recomputes analytics from filesystem data
- The response is split into `summary`, `trends`, and `topFailureReasons` so the API can be broken into dedicated endpoints later if needed
- Workflow health score is distinct from dashboard/server health
