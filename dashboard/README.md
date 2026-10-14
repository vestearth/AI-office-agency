# AI Dev Office Dashboard

Filesystem-backed operational dashboard for `ai-dev-office/runs`. Most views are
read models; the narrow write surface is documented below.

## Views

- `Command`: opens on `Attention` (below); the `Operations` panel (`?tab=command&view=operations`) holds the live workflow map, queue, agent status, health, logs, and task detail/decision controls. Queue, health and Insights counts share one definition (`shared/runCounts.ts`): active = running + in review + blocked + queued + failed; runs whose `status.yaml` cannot be read are counted as `Unreadable`, never as active
- `Monitor`: browse runs (default scope Active; Finished and All group by month of last update; filter by task prefix; a deep link to a finished run widens the scope and scrolls to it), and open a run's full detail: status with the server's idle badge, why it needs a human, the next action and desktop handoff, decision controls, reviewer issues, timeline (newest first), task.md, artifacts, completion gates, and direct log files inside a run directory
- `Action`: operator inbox for completion gates (unreadable, authorization required, completion held), awaiting review, pending decision reconciliation, workflow exceptions, artifact drift, and stale work (a block whose `blocked_on` tasks have all finished, or a task with no `status.yaml` change for more than 7 days in review / 14 days pending or in active work; tasks already listed for another reason show `stale >Nd` under Age instead). It is the one list for acting: awaiting review and pending decisions open the quick decision panel in place (with the latest `history` transition reason), everything else opens the run in `Monitor`; only categories with work get a card, and the filter is shareable as `?tab=command&view=attention&kind=<kind>`. Task decisions are recorded from Attention, Command's queue, or `Monitor`
- `Insights › Flow`: where open work is stuck right now (counts per Action Center reason that open Attention filtered, idle days, phase waits, flow health) and how fast work closes (opened/closed per day, cycle time, who moved work from `history`)
- `Reports`: project readiness view built from repository source evidence

## Structure

- `server/`: Express + TypeScript API, file watcher, SSE
- `client/`: React + Vite + TypeScript UI
- `shared/`: shared dashboard types and run-count definitions

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
DASHBOARD_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
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

- Run, review, analytics, report, and log data are derived from filesystem
  artifacts.
- Knowledge Reviews is a read-only projection of validated local
  `knowledge-reviews/*.yaml` audits. It shows scope, findings, and proposed or
  applied changes without applying vault edits from the dashboard. Its default
  view, Open findings (`GET /api/knowledge-reviews/findings`), gives each finding
  fingerprint the status of the latest audit that reported it and lists the ones
  still `new` or `recurring`, grouped by vault folder and note (a leading
  `knowledge-base/` prefix is folded into the vault). That is an upper bound: a
  note fixed since then stays open until a later audit re-checks it. The Audits
  view collapses audits of the same note set under the newest one.
- Human decisions append to `runs/<task-id>/decision.yaml`; the driver later
  reconciles the latest decision into `status.yaml`. The dashboard never writes
  `status.yaml` directly.
- Identity setup may claim a task prefix in `office.team.yaml` and, when no
  prefix exists, initialize the ignored `office.config.local.yaml`.
- Recommended next actions remain previews. Task details offer **Open task in
  desktop app**: choose a role, enter the absolute target workspace, and review
  the generated prompt. Cursor uses its [documented prompt deeplink](https://prod.cursor.com/docs/reference/deeplinks);
  Codex and Claude use Copy prompt for manual paste. Select the target workspace
  in the app yourself; the prompt link does not switch repositories. The
  desktop handoff reports an open request, not confirmed delivery or execution.
  Links exceeding Cursor's 10,000-character limit require Copy prompt.
- **Codex CLI · run here** executes the locally installed Codex CLI on the
  dashboard server in the confirmed target workspace. Review the generated
  prompt and select read-only (default) or workspace-write permissions before
  pressing Run Codex CLI. The server uses `spawn` without a shell, passes the
  prompt through stdin, keeps Codex's Git check, and never enables sandbox bypass.
  Noninteractive approval policy is `never`: operations requiring interactive
  approval cannot proceed. The existing server user's Codex login is used.
  Claude and Cursor CLI adapters are not implemented yet.
- CLI controls are localhost-only and POST requests require an allowed dashboard
  Origin, in addition to existing optional bearer authentication. API endpoints:
  `GET /api/cli/tools`, `GET /api/cli/:taskId`, `POST /api/cli/:taskId`
  (`cli: codex`, absolute `workspace`, `sandbox: read-only|workspace-write`,
  `prompt` up to 50,000 characters), and `POST /api/cli/:taskId/stop` (`id`).
  Unknown tasks, invalid workspaces, duplicate active tasks, and stale Stop ids
  are rejected. Stop terminates the process tree; runs time out after 30 minutes.
  Output/status are polled and bounded in memory (50 latest task runs, last
  200,000 output characters each). Closing the dialog keeps the CLI running;
  server shutdown stops it and server restart clears this execution history.
  CLI success means process exit 0, not verified task completion. The dashboard
  does not mutate workflow status or completion gates through this interface.
- Completion gates come from `scripts/gate-view-json.rb` (the guard's own view,
  read-only). The dashboard shows the grant command; it never records a grant or
  passes a gate. See [../docs/completion-gates.md](../docs/completion-gates.md).

## Current Limitations

- CLI execution is currently Codex-only, with in-memory logs; no automatic
  workflow role dispatch, retry, or `status.yaml` mutation from the dashboard
- The UI currently keeps both the newer `Command` view and the legacy tab shell; consolidate only with browser layout verification
- Authentication is an optional shared bearer token, not per-user roles or permissions
- Persistence is filesystem-local; there is no database-backed control plane
- Health status is filesystem and watcher based, not service dependency aware
- Log viewing is limited to direct files inside each run directory
- SSE refreshes run summaries and the currently selected log only
- Reports is a readiness summary, not a full markdown report generator
- Knowledge Reviews refreshes on dashboard run events, page load, or its manual
  Refresh control; it does not watch the audit directory directly or validate
  artifacts in the browser

## Insights: Flow

- `GET /api/analytics/flow?days=7|14|30` (invalid or missing `days` falls back to `7`) returns one read model built from `runs/`, the review model, and `status.yaml` history
- Stuck now, Where it waits, and Flow health describe all open runs right now and ignore `days`, so a long-running block can never drop out of view
- Flow health = 100 − 10 per validation-failed run − 5 per run idle past its phase threshold (the review model's stale rule) − 5 per unreadable `status.yaml` − 2 per blocked run, clamped to 0–100; ≥90 OK, ≥70 Attention, otherwise Stuck. Command's System Health shows the same score
- Throughput counts closes by `completedAt` and opens by `startedAt` inside the window; cycle time is median/p90 of `completedAt − startedAt` over closed runs with a start date
- Who moved work counts `history` phase transitions (gate updates excluded) inside the window, by role and by operator, and reports how many moving runs recorded a conductor; history is read only for runs updated inside the window
- The window choice is persisted in `sessionStorage` (`dashboard_analytics_days`)
- There is no cache layer; each request recomputes from filesystem data
- Flow health is distinct from dashboard/server health

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
