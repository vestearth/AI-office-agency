# AI Dev Office Dashboard

Filesystem-backed operational dashboard for `ai-dev-office/runs`. Most views are
read models; the narrow write surface is documented below.

## Views

- `Command`: opens on `Attention` (below); the `Operations` panel (`?tab=command&view=operations`) holds the live workflow map, queue, `Running now` (what a Start button is executing right now; localhost viewers only), `Waiting on` (open tasks by `current_agent`: who a task waits on, not a running agent), health, logs (each line stamped with the last hand-off's time, `MM-DD HH:MM`, when history has one), and task detail/decision controls. Queue, health and Insights counts share one definition (`shared/runCounts.ts`): active = running + in review + blocked + queued + failed; runs whose `status.yaml` cannot be read are counted as `Unreadable`, never as active In Attention, "What unblocks work" leaves out a release train waiting on its own run (`isOwnRunWait`, shared with Readiness), and a recommended action that is a command (the authorization grant) shows one line with `Copy command`. In Operations, Dev Bay (the assigned phases) is toned queued, not "agent on it", and the queue filter for runs awaiting a review decision reads `Review`. Attention's `Bookkeeping` section lists records a person still has to keep, outside the "need attention" count: a blocked task with no `waits_on`, and a staging-accepted task with no production gate that no train carries (with the open trains of its product); each row has the fixing command to copy. When production signals hold errors no run owns (or that recur after a run closed), Attention shows a line near the top that scrolls to the panel. The summary cards fit as many per row as the width allows. Operations' health panel shows the done rate of runs finished in the last 30 days (`doneRateWithin`), not the all-time rate. Bookkeeping sits under the action table, one line per task under one explanation per kind.
- `Monitor`: browse runs (default scope Active; Finished and All group by month of last update; filter by task prefix; a deep link to a finished run widens the scope and scrolls to it), with no run selected it lands on the five most recently updated runs and up to five runs waiting on a human (Attention keeps the full list); open a run's full detail: status with the server's idle badge, why it needs a human, the next action and desktop handoff, decision controls, reviewer issues, timeline (newest first), task.md, artifacts, completion gates, and direct log files inside a run directory Run detail also shows `Waits on` (status.yaml `waits_on`), a `Release` card (what a train `carries` with each task's highest rung, or which trains carry this task and its prod rung; a task on several trains is proven only when all pass), renders GitHub tables in task.md, hides dotfiles from Artifacts, and folds the review decision buttons unless the run is in review or a decision is pending. A run in the `assigned` phase reads `Assigned`, not `In progress`. Within a status the run list puts the most recently moved run first (`lastHandoffAt`, the latest timed phase change in history, else `updated_at`); task numbers only break ties, since each project numbers its own tasks (EAR in the 400s, VS in the 30s) and ordering by number put every EAR run above any VS run. A row shows `▶ running · N min` while a Start-button step runs on that task (`GET /api/launch/active`, localhost viewers), and run detail has a `Launch` card with the newest step on the task, its output, and the server's contract check once it ends. The recommended-action card reads `RECOMMENDATION` (its button opens Start, which runs only after you confirm). Search treats hyphens, underscores and spaces alike and, when the scope hides matches, says how many sit in the other scope with a `Show all` switch. Run detail lists folders (evidence/) as folders with their size, shows a command recommendation with `Copy command`, and dims timeline rows that record metadata (gate updates, waits_on, carries) with a tag so hand-offs stand out. The collapsed timeline folds consecutive metadata rows into one line and always reaches the latest hand-off; rows are ordered by time when every row has a full timestamp (some history blocks were written out of order), and the review model's `lastTransition` is the latest by time too. The landing's `Waiting on you` uses Attention's order (kind first), and `Recently updated` breaks same-day ties by the last hand-off time.
- `Action`: operator inbox for completion gates (unreadable, authorization required, completion held), awaiting review, pending decision reconciliation, workflow exceptions, artifact drift, and stale work (a block whose `blocked_on` tasks have all finished, or a task with no `status.yaml` change for more than 7 days in review / 14 days pending or in active work; tasks already listed for another reason show `stale >Nd` under Age instead). A "What unblocks work" box groups open actions by their structured `waits_on` (kind, and the unblocking task when a `ref` is recorded). It is the one list for acting: awaiting review and pending decisions open the quick decision panel in place (with the latest `history` transition reason), everything else opens the run in `Monitor`; only categories with work get a card, and the filter is shareable as `?tab=command&view=attention&kind=<kind>`. Task decisions are recorded from Attention, Command's queue, or `Monitor`
- `Insights › Flow`: where open work is stuck right now (counts per Action Center reason that open Attention filtered, idle days, phase waits, flow health) and how fast work closes (opened/closed per day, cycle time, who moved work from `history`) `need you` is the same count as Attention, including runs already closed (shown as "(n closed)"). Free-text history agents that start with an operator name ("Claude (advisory lane…)", "claude-conductor") count as that operator. The kind chips cover the same runs as `need you`; `Where it waits` names phases with the shared vocabulary (`phaseLabel`); a history agent named `operator` (the human conducting) counts as an actor.
- `Insights › Readiness`: the release ladder — per product, how far each task is proven by its completion gates (Verified → Staging deployed → Staging accepted → Prod deployed → Prod accepted), which tasks one production run would prove, and a collapsed group of runs that never recorded gates (readiness unknown, not assumed) Tasks waiting on a production gate are grouped by the run that would prove them: one group per release train, a group for tasks that need several trains (each must pass), and tasks with their own production gate. Trains are the run, so they are neither counted as waiting nor listed under "would also unblock". Release trains are counted apart from tasks ("19 gated tasks · 2 release trains") and stay out of the rung tally; a task a train carries is listed once, under what that train would prove, not again under "would also unblock". A task with no `staging_acceptance` gate but an `authenticated_staging` one has it read as the Staging accepted rung (tagged "as authenticated staging"), so an uncarried one shows in Bookkeeping.
- `Reliability ↗` (header link, after `Knowledge`): opens DevOps' AWS Tracking reliability view (`https://aws.upslip.net/reliability`, repo `aws-tracking`) in a new tab — API latency, ECS task restarts and errors, worth checking when picking up infra work. It is an external link, not a section: it has no `?tab=` state, and the site needs the UpSlip admin login so it cannot be embedded. Links live in `EXTERNAL_LINKS` (`client/src/views/types.ts`).

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
PROD_SIGNALS_AWS_PROFILE=vestearth   # optional; default comes from config/prod-signals.yaml
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
  applied changes without applying vault edits from the dashboard. Its one write
  is the Decisions queue's operator-answer ledger (see "Knowledge › Decisions"),
  which never changes finding status.
- Validation results are cached in memory and in
  `knowledge-reviews/.cache/validated-reviews.json` (gitignored), keyed by each
  file's size+mtime, the auto-write policy file, and the validator + schema; a
  restart reuses them instead of re-running the validator on every audit (~6s for
  327). The `invalid` pill opens the failing files with the validator's errors (or
  the duplicate review_id): their findings are not counted anywhere. Audit titles
  drop a leading session id (UUID or 8-hex) from the review slug.
- The Knowledge tab and the selected audit live in the URL
  (`?tab=knowledge&view=decisions|audits&audit=<reviewId>`). Copied re-check briefs
  leave out findings only a human can close and say how many; Attention shows
  how many wait for an answer, linking to Knowledge › Decisions. Its default
  view, Open findings (`GET /api/knowledge-reviews/findings`), gives each finding
  fingerprint the status of the latest audit that reported it and lists the ones
  still `new` or `recurring`, grouped by vault folder and note (a leading
  `knowledge-base/` prefix is folded into the vault). That is an upper bound: a
  note fixed since then stays open until a later audit re-checks it. The Audits
  view collapses audits of the same note set under the newest one. A finding
  only closes when a later audit re-checks it, so Open findings marks findings
  not re-checked for more than 30 days and copies a re-check brief for the
  Librarian: the current filter's worst, stalest notes, capped at 5 notes and
  15 findings per run. The selection rule lives server-side at
  `GET /api/knowledge-reviews/findings/brief?audience=human|task` and
  `POST …/findings/brief` with `{audience, fingerprints[]}` to narrow a human
  brief to the current filter; the weekly re-check task uses `audience=task`, which also keeps only the Games Labs auto-write scope from
  `knowledge-base/knowledge-librarian-policy.yaml`, puts confirmed evidence
  first, and drops findings that need a human decision (`needsHumanDecision`:
  `append_review_queue` plus a fingerprint or closure criterion naming a human
  decision, or `no_change` whose closure criterion names a human actor and act
  such as "Human applies or rejects…"; shown as its own chip and badge).
- Human decisions append to `runs/<task-id>/decision.yaml`; the driver later
  reconciles the latest decision into `status.yaml`. The dashboard never writes
  `status.yaml` directly.
- Identity setup may claim a task prefix in `office.team.yaml` and, when no
  prefix exists, initialize the ignored `office.config.local.yaml`.
- Recommended next actions remain previews. Task details offer **Start or open
  task** (the dialog opens on **Start here**):
  - **Start here** runs one role step in `claude`, `codex` or `cursor-agent` on
    this machine, from the workspace root. The server builds the prompt from the
    task's own files (shown before starting, with the optional instructions
    appended): read AGENTS.md, `agents/<role>.md` and the task artifacts, record
    verification with `scripts/record-evidence.sh`, then the runtime adapter
    contract (`docs/runtime-adapter-contract.md`): write `<role>-output.yaml`,
    run `validate-yaml.rb`, `enforce-output-contract.rb` and
    `sync-status-from-output.rb`, and leave `runs/` uncommitted for the operator.
    `status.yaml` `next_action` is included whether a lane recorded it as
    `{agent, reason}` or as text. It does not go through `run-agent.sh` (2 of the
    40 latest tasks were dispatched that way on 2026-10-16), so there is no
    ownership lease: the dashboard refuses a second start of the same task from
    here, and warns when `status.yaml` changed in the last 30 minutes while
    nothing runs from here (another session may hold the task). CLI guards:
    `claude -p` accepts edits and refuses `gh pr merge`, force pushes and prod
    ECS/RDS starts; `codex exec` uses the workspace-write sandbox (no network);
    `cursor-agent -p --trust` follows the Cursor CLI's own permissions.
    A confirm checkbox gates Start. When the step ends the server checks the
    contract itself instead of trusting the exit code: `<role>-output.yaml` and
    `status.yaml` changed during the run and `validate-yaml.rb` passes now
    (read-only; `enforce-output-contract.rb` writes, so the check never runs it).
  - Cursor uses its [documented prompt deeplink](https://prod.cursor.com/docs/reference/deeplinks);
    Codex and Claude use Copy prompt for manual paste. Select the target workspace
    in the app yourself; the prompt link does not switch repositories. The
    desktop handoff reports an open request, not confirmed delivery or execution.
    Links exceeding Cursor's 10,000-character limit require Copy prompt.
- Launches (Start here, Knowledge › **Run re-check now**) are detached and
  file-backed in the OS temp dir (`ai-dev-office-dashboard/launches/<id>.json|log|exit`,
  10 kept per task): closing the dialog or restarting the dashboard does not stop
  them, and a launch whose process is gone without an exit code reads `lost`.
  A small node wrapper (not `/bin/sh`) runs the CLI and records its exit code,
  so the same path runs on Windows; a CLI that cannot start reads `failed`, exit
  127. Stop sends SIGTERM to the process group, or `taskkill /PID <pid> /T /F` on
  Windows. On Windows a CLI is found as `.exe`/`.com`, or through its npm `.cmd`
  shim's script run under node; a `.cmd` that is not an npm shim reads as
  unavailable (spawning it needs a shell, which would parse the prompt). Windows
  support is covered by unit tests only so far (TASK-EAR-404). The wrapper is
  started through a short-lived middle process, so it is re-parented away from
  the dashboard: nodemon kills every descendant on restart (psTree), which took a
  running re-check with it on 2026-10-16. A signal to the wrapper is passed to the
  CLI and still records an exit code (143 for SIGTERM). Endpoints (localhost-only, POST needs
  an allowed Origin): `GET /api/launch/tools`, `GET /api/launch/task/:taskId`
  (launch, contract once finished, `statusChangedAt`), `POST /api/launch/task/:taskId`
  (`role`, `cli`, optional `note` up to 4,000 characters), `POST
  /api/launch/task/:taskId/prompt` (the prompt a Start would send),
  `GET|POST /api/launch/knowledge` (`rounds`: 1, 3 or 5; GET adds the `chain`),
  `POST /api/launch/knowledge/stop`, `POST /api/launch/:id/stop`, and
  `GET /api/launch/active` (every running launch, for Command › Operations ›
  Running now).
- **Run re-check now ×1/×3/×5** runs rounds back to back: each round is one
  weekly re-check with a brief built when it starts, so it picks the notes the
  previous audit did not look at. The next round starts only after the previous
  one succeeded; a failed, lost or stopped round, Stop, or an empty brief ends
  the rounds and the card says why. The chain is kept on disk
  (`launches/knowledge-chain.json`) and advances on a 10 s timer, so it survives
  a dashboard restart.
- Open findings shows who can close them (`coverage` on
  `GET /api/knowledge-reviews/findings`, from the auto-write policy's write
  targets): the re-check run (in scope, with the runs needed to look at each
  once at the brief caps), the operator (Decisions), or nobody automatically
  (outside the policy: a hand edit or an accepted proposal). On 2026-10-16 that
  was 175 / 30 / 62 of 267, about 12 runs to cover the scope once; the
  `outside auto scope` chip filters to the 62 (other projects' notes, 40 Lessons,
  runs/, Weekly Review, jaview).
- **Advanced › Codex CLI · free prompt** executes the locally installed Codex CLI on the
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
- Knowledge Reviews refreshes on dashboard run events, page load, or its manual
  Refresh control; it does not watch the audit directory directly or validate
  artifacts in the browser

## Knowledge › Decisions

The open findings only a human can close (`needsHumanDecision`), grouped by the kind of
answer they ask for (a hint from the question text, `classifyDecisionKind`): repeat a
proposal?, is it still true?, approve or reject, product or architecture choice. Every card
can also be answered in words or deferred.

- `POST /api/knowledge-reviews/findings/decisions` `{fingerprint, answer, actor, note?}`
  appends to `knowledge-reviews/decisions/human-decisions.yaml` (gitignored, serialized
  appends, fsync before rename). It accepts only open human-decision findings; a note is
  required for `answer` and `no_longer_true`. A later answer replaces an earlier one.
- The ledger is an input: finding status still changes only when an audit records it.
  `GET …/findings/brief?audience=task` lists answers newer than the finding's latest audit
  (not deferrals) under "Operator answers to record", with what the Librarian should do for
  each; the weekly re-check records the finding and cites the answer (closure spec D4,
  amended 2026-10-15).
- A card shows whether its answer is waiting for the re-check, was kept open by a later
  re-check, or was deferred.

## Command › Attention: Production signals

Below the Action Center, `Production signals` (`GET /api/signals?env=prod|staging[&refresh=1]`)
answers "what is failing in a running service that no run owns yet?".

- **Source:** the server runs the `aws` CLI with the profile in `config/prod-signals.yaml`
  (default `vestearth`, override `PROD_SIGNALS_AWS_PROFILE`). Read-only calls only: ECS
  list/describe to find services with desired > 0 and their awslogs group, then
  `logs filter-log-events` over the last `window_hours` (24), every page, read newest
  first in doubling windows (1h, 2h, 4h, …) up to 50,000 matching lines per service and a
  90s budget. If a read stops early, its groups show `≥` and "partial read · since <time>"
  (the 3,000-line cap had cut the 2026-10-15 KBank outage at 3,809 of 8,189 failures). Cached
  `cache_minutes` (15); the first read takes up to about a minute.
- **Clusters → product:** `config/prod-signals.yaml` maps each cluster to its env and TASK
  prefix (upslip → `VS`, sparqlab → `EAR`). A cluster with no running service shows
  "no service running", never "no errors".
- **Grouping:** ERROR lines are classified like DevOps' aws-tracking
  (`server/utils/logs.ts`), but lines sharing a request/correlation id count as one failure,
  and the HTTP status stays readable in the signature. A group seen in 2+ clock hours is
  `recurring`. Samples keep selected fields with ids, IPs, emails and long numbers redacted.
- **Coverage:** each group's terms (its path, and the most specific phrase of its error)
  are searched in the same-prefix runs' `task.md`, `status.yaml`, `*-output.yaml`,
  `verification-evidence.md`, `investigation.md`, `decision-memo.md`.
  `mentioned` = an open run names it; `recurs_after` = a run closed within
  `closed_window_days` (14) names it and the failure happened after it closed (a date-only
  close counts from the end of that Bangkok day); `closed_recently` = such a run mentions it but
  no failure is after its close (the owner just finished); `unowned` = none of these. Mentioned is
  not fixed. Only unowned and recurs_after count toward Attention's top line.
- **Stale while revalidate:** a result older than `cache_minutes` is served at once with
  `refreshing: true` while a fresh read runs in the background; the panel says "updating…" and
  fetches again shortly. `Refresh` waits for a fresh read.
- **Action:** `Copy task brief` copies the signature, counts, coverage, redacted sample and a
  reproduce command for Claude to open a run. The dashboard never opens runs.
- **Restart cache:** the last good result per env is kept in the OS temp dir
  (`ai-dev-office-dashboard/prod-signals-<env>.json`) and reused within `cache_minutes`
  after a server restart; a result with an unreadable cluster is not kept.

## Insights: Flow

- `GET /api/analytics/flow?days=7|14|30` (invalid or missing `days` falls back to `7`) returns one read model built from `runs/`, the review model, and `status.yaml` history
- Stuck now, Where it waits, and Flow health describe all open runs right now and ignore `days`, so a long-running block can never drop out of view
- Flow health = 100 − 10 per validation-failed run − 5 per run idle past its phase threshold (the review model's stale rule) − 5 per unreadable `status.yaml` − 2 per blocked run, clamped to 0–100; ≥90 OK, ≥70 Attention, otherwise Stuck. Command's System Health shows the same score
- Throughput counts closes by `completedAt` and opens by `startedAt` inside the window. Open-to-done time comes from `history` timestamps when they fit (the first one within 36h of `created_at`, the last transition into done), else from `created_at`/`completed_at`, which are dates only (before 2026-10-16 that read 16 of 32 same-day closes as 0d); the card says how many runs were timed from history. Runs closed within 30 days of opening report median/p90 in minutes, hours or days; runs open longer are counted apart as backlog clean-up with the oldest age (`shared/flow.ts` `FLOW_BACKLOG_DAYS`)
- Who moved work counts `history` phase changes (from ≠ to; gate updates excluded) inside the window, by role and by operator, and reports how many runs that changed phase recorded a conductor. Opening a task (`created -> …`) is shown apart (`+N opened` per actor, total in the header), and same-phase entries (`blocked -> blocked`: notes, evidence, metadata) are counted but not moves — pm read 52 moves before 2026-10-16, 31 of them openings and 11 same-phase. History is read only for runs updated inside the window
- The window choice is persisted in `sessionStorage` (`dashboard_analytics_days`)
- There is no cache layer; each request recomputes from filesystem data
- Flow health is distinct from dashboard/server health

## Readiness: release ladder

- `GET /api/reports/release-ladder` returns, per product (task prefix: EAR = Games Labs, VS = VerifySlip, KAS = Casper), every run that declares `completion_gates` with each ladder rung's gate status (`pass` / `pending` / `na` / `absent`), the 2C run record of a pass (`by`, `ref`, `url`), gates outside the ladder, and `waitingOnProd` (the next pending rung is `deploy_production` or `production_acceptance`)
- Rungs come from `CompletionGuard.gate_view` (`scripts/gate-view-json.rb`), the same source Monitor shows; nothing is inferred from phase, branch state or prose, and an unreadable gate view is shown as unreadable
- A release train lists the tasks it promotes in `status.yaml` `carries` (`scripts/update-train-carries.rb`); a carried task's `deploy_production` / `production_acceptance` rung that it does not declare itself is credited from the train's gate of the same name and marked `via <train>` (a train whose gates use other names credits nothing)
- Tasks recording `waits_on` kind `prod_run` (`scripts/update-waits-on.rb`) are listed as what a production run would also unblock
- Runs without `completion_gates` (the contract started 2026-10-07) are listed under "No gates recorded": readiness unknown, never assumed — unless a train carries them. Products with no gated task at all (Legacy, PKG, Casper) share one "No gated tasks yet" card, one toggle per product
- There is no cache; each request reads every run's `status.yaml` and runs `gate-view-json.rb` only for gated runs
