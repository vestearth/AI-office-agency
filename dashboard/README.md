# AI Dev Office Dashboard

Filesystem-backed operational dashboard for `ai-dev-office/runs`. Most views are
read models; the narrow write surface is documented below.

## Views

- `Command`: opens on `Attention` (below); the `Operations` panel (`?tab=command&view=operations`) holds the live workflow map, queue, `Running now` (what a Run is executing right now; localhost viewers only), `Waiting on` (open tasks by `current_agent`: who a task waits on, not a running agent), health, logs (each line stamped with the last hand-off's time, `MM-DD HH:MM`, when history has one), and task detail/decision controls. Queue, health and Insights counts share one definition (`shared/runCounts.ts`): active = running + in review + blocked + queued + failed; runs whose `status.yaml` cannot be read are counted as `Unreadable`, never as active In Attention, "What unblocks work" leaves out a release train waiting on its own run (`isOwnRunWait`, shared with Readiness), and a recommended action that is a command (the authorization grant) shows one line with `Copy command`. Each Attention row of a gated task also shows how far its gates got and what is next (`Prod deployed · next: Prod accepted`, from the release ladder), since the hand-off note can be older than the gates: lanes advance gates without a phase change (VS-028 read "Not merged" after its prod deploy, 2026-10-16). In Operations, Dev Bay (the assigned phases) is toned queued, not "agent on it", and the queue filter for runs awaiting a review decision reads `Review`. Attention's `Bookkeeping` section lists records a person still has to keep, outside the "need attention" count: a blocked task with no `waits_on`, and a staging-accepted task with no production gate that no train carries (with the open trains of its product); each row has the fixing command to copy. When production signals hold errors no run owns (or that recur after a run closed), Attention shows a line near the top that scrolls to the panel. Signals note failures that fell inside an ECS rolling deployment of a service in the same cluster (from the services' events: first task start to `deployment completed`, +60 s; a scale-out's start with no completion is not a deployment): a badge such as `all during 2 deploys`, a `Timing:` line in the task brief, and `(all during deploys)` on the Attention line; only when at least half of a signal's failures fall in deployments. On 2026-10-16 the upstream-connect 502s were all cut connections during two slip-system rollouts. The summary cards fit as many per row as the width allows. Operations' health panel shows the done rate of runs finished in the last 30 days (`doneRateWithin`), not the all-time rate. Bookkeeping sits under the action table, one line per task under one explanation per kind. A task still open while another run's `task.md` says `Supersedes TASK-<ID>` of it shows under `Artifact drift` as "Superseded by TASK-<new> (<status>), still <phase>", with the close-out step (aborted, through the office scripts); the dashboard never closes it (operator decision 2026-10-17: VS-030 stayed `assigned` after VS-040 superseded it).
- `Monitor`: browse runs (default scope Active; Finished and All group by month of last update; filter by task prefix; a deep link to a finished run widens the scope and scrolls to it), with no run selected it lands on the five most recently updated runs and up to five runs waiting on a human (Attention keeps the full list); open a run's full detail: status with the server's idle badge, why it needs a human, the next action and Start or open task (Run or Open), decision controls, reviewer issues, timeline (newest first), task.md, artifacts, completion gates, and direct log files inside a run directory Run detail also shows `Waits on` (status.yaml `waits_on`), a `Release` card (what a train `carries` with each task's highest rung, or which trains carry this task and its prod rung; a task on several trains is proven only when all pass), renders GitHub tables in task.md, hides dotfiles from Artifacts, and folds the review decision buttons unless the run is in review or a decision is pending. A run in the `assigned` phase reads `Assigned`, not `In progress`. Within a status the run list puts the most recently moved run first (`lastHandoffAt`, the latest timed phase change in history, else `updated_at`); task numbers only break ties, since each project numbers its own tasks (EAR in the 400s, VS in the 30s) and ordering by number put every EAR run above any VS run. A row shows `▶ running · N min` while a Run step runs on that task (`GET /api/launch/active`, localhost viewers), and run detail has a `Launch` card with the newest step on the task, its output, and the server's contract check once it ends, plus the newest Open hand-off. The recommended-action card reads `RECOMMENDATION` (its button opens Start or open task; nothing runs or opens until you confirm). Each row's time is the one the list sorts by (the last hand-off, `MMM D, HH:MM`, else `updated_at`); a run with no recorded title reads `(no title recorded)`. A finished run (done or aborted) shows `Closed · <phase> <date>` with the reason from the transition that closed it, and no next-action card. An aborted run is never flagged as artifact drift: its last verdict no longer matters (a done run with an adverse verdict still is). Search treats hyphens, underscores and spaces alike and, when the scope hides matches, says how many sit in the other scope with a `Show all` switch. Run detail lists folders (evidence/) as folders with their size, shows a command recommendation with `Copy command`, and dims timeline rows that record metadata (gate updates, waits_on, carries) with a tag so hand-offs stand out. The collapsed timeline folds consecutive metadata rows into one line and always reaches the latest hand-off; rows are ordered by time when every row has a full timestamp (some history blocks were written out of order), and the review model's `lastTransition` is the latest by time too. The landing's `Waiting on you` uses Attention's order (kind first), and `Recently updated` breaks same-day ties by the last hand-off time.
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
DASHBOARD_RUN_CONCURRENCY=2          # optional; Runs (task steps + knowledge rounds) running at once
DASHBOARD_QUEUE_FILE=                # optional; default <tmp>/ai-dev-office-dashboard/launches/queue-<root hash>.json
DASHBOARD_KNOWLEDGE_CHAIN_FILE=      # optional; default <tmp>/ai-dev-office-dashboard/launches/knowledge-chain-<root hash>.json
DASHBOARD_CHAIN_WRITER_CLI=claude    # optional; role chains: the CLI for pm, dev, dev-2, debugger, devops
DASHBOARD_CHAIN_REVIEWER_CLI=codex   # optional; role chains: the reviewer's CLI, always different from the writer
DASHBOARD_CHAIN_STEP_CAP=6           # optional; role chains: steps per chain (1-20)
DASHBOARD_CHAINS_FILE=               # optional; default <tmp>/ai-dev-office-dashboard/launches/chains-<root hash>.json
DASHBOARD_NEW_TASKS_FILE=            # optional; default <tmp>/ai-dev-office-dashboard/launches/new-tasks-<root hash>.json
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
  task** (slice 4 of `docs/start-task-redesign-spec.md`, D1/D15): two actions,
  **Run** (the default) and **Open**, sharing the role (defaulted from
  `next_action`, else `current_agent`; a done task offers reviewer), the
  optional instructions (up to 4,000 characters), the target repositories and the
  prompt the server builds, previewed in the dialog for the chosen action. Above
  both, the dialog warns when `status.yaml` changed recently or an Open hand-off
  is recorded after the last Run (below).
  - **Run** runs one role step in `claude`, `codex` or `cursor-agent` on
    this machine, in the task's worktrees (slice 2 of
    `docs/start-task-redesign-spec.md`, `server/src/services/worktrees.ts`).
    **Target repositories** are proposed from task.md (real repositories under
    the workspace root named as a word, a path segment, or on a `Repo:` /
    `Type: … (repo)` line) and confirmed or edited in the dialog. Only the
    strongest are preselected and planned by default (named in the title, on a
    `Type:`/`Repo:` line, or as a row of a repository table; with none of those,
    the first-ranked match); the rest are listed unticked under "Also mentioned"
    with their evidence (a commit on a "Found by" line, siblings to check).
    Read-only ones (Games-Lab-Android) show as reference only and are
    refused as targets. A Run with no confirmed repository is refused. Each
    repository gets a worktree at `<workspace>/.worktrees/<repo>-<TASK>` on
    `task/<TASK>`; the first is the primary, the step's working directory, and the
    others plus `runs/<TASK>` (this office checkout) are its extra writable dirs.
    The plan per repository comes from git's state: reuse a worktree the dashboard
    created or adopted for the task; add a worktree on an existing
    `task/<TASK>` or single `task/<TASK>-<slug>` branch (several: pick one);
    otherwise create `task/<TASK>` (no upstream) from a base ref named in task.md
    (`base: \`staging\``, only when it is a branch on origin), else the workspace
    Git policy's branch (`BASE_POLICY`, from AGENTS.md: `Games-Labs-*` and
    `api-gateway` from `origin/staging`; `shared-lib`, `Games-Labs-backoffice` and
    `slip-*` from `origin/main`), else origin's default branch. The base and the
    rule that chose it are shown and overridable; the server runs `git fetch` on
    that branch first and the dialog shows a fetch that failed. A worktree
    at the path or the task branch checked out in another worktree that the
    dashboard did not create is never modified, moved or removed: a Run uses it
    only on the opt-in "Use the existing worktree" and records it as adopted (no
    cursor-agent `--trust`, never proposed for removal). The task branch checked
    out in a main checkout is refused. Every repository is planned before any
    worktree is made, so one refusal creates nothing. The plan also warns when a
    step cannot fetch dependencies with the network off (a Node project with no
    `node_modules` in the worktree; a Go module needs every module cached).
    `<workspace>/.worktrees/.dashboard-worktrees.json` records each worktree the
    dashboard created or adopted (repo, path, branch, base, task, origin, time).
    The server builds the prompt from the
    task's own files (shown before starting, with the optional instructions
    appended): read AGENTS.md, `agents/<role>.md` and the task artifacts, run the
    role's checks from the worktree they check and list them as `claims` in the
    output, and write `<role>-output.yaml`, the only file the agent writes under
    `runs/<TASK>` (operation 4 of `docs/runtime-adapter-contract.md`). The agent
    runs no office script (no `record-evidence.sh`, `validate-yaml.rb`,
    `enforce-output-contract.rb` or `sync-status-from-output.rb`: the dashboard
    runs them, below) and never commits, pushes, merges or deploys. It names the
    worktrees, the primary repository and the absolute runs dir, and says to
    write the output file with the shell if the edit tool refuses a path outside
    the working directory (cursor-agent's edit tool does; its shell does not,
    checked 2026-10-17).
    `status.yaml` `next_action` is included whether a lane recorded it as
    `{agent, reason}` or as text.
    **Governance (slice 3, `server/src/services/stepGovernance.ts`,
    `taskLease.ts`)**: the dashboard is the step's runtime adapter. Before the
    worktrees are made it records an office run (`scripts/record-run.rb`,
    `client: dashboard-<cli>`, `model_requested`, later `repo_sha` and the
    prompt's `instruction_sha`) and takes the task's ownership lease with
    `scripts/task-ownership.rb acquire` under that run id, so `run-agent.sh`
    (exit 9) and every fenced status writer are refused while the step runs;
    another holder refuses the Run with the holder and the reason. The step's
    detached wrapper renews the lease every `ownership.renew_interval_seconds`
    while the CLI is alive (across a dashboard restart too); a lease nobody
    renews lapses after `ownership.lease_seconds` (1800 s) and the next acquire
    reclaims it. It also takes run-agent.sh's task-input-integrity snapshot and
    records each worktree's HEAD. When the step ends (any ending, also while
    the dashboard was down: a 5 s tick and the task's GET finalize it once):
    the protocol result; the lease still ours (else nothing runs); then, stopping
    at the first failure, the output is new this step, `task-input-integrity.rb
    verify`, `validate-yaml.rb <TASK>`, `enforce-output-contract.rb <TASK> <role>`
    and `sync-status-from-output.rb <TASK> <role> <status> <output> <today>
    <reviewer queue phase>` with the step's run id and epoch, so `status.yaml`
    is written only by those scripts. A commit in a step worktree the dashboard
    did not make (HEAD moved; cursor-agent can commit) fails the step and nothing
    is committed on top. When everything passed, each worktree's diff (tracked
    changes and new files as `.gitignore`/`info/exclude` allow, never `.cache/`
    or `.cursor/`) is committed locally on its task branch with the operator's git
    identity, hooks off, a conventional subject from the output summary and
    `Task`/`Role`/`CLI`/`Model`/`Launch-Id`/`Run-Id` trailers, never pushed; an
    empty diff makes no commit. `scripts/record-evidence.sh --type artifact`
    records each commit (`git show --stat`) under the step's run id. Then the run
    record's outcome, the lease released, and the files changed in `runs/<TASK>`
    (shown, never committed: lanes commit runs). The Launch card shows, in order,
    the protocol result, each script's result (with its output, truncated, when
    it failed), agent-commit detection and the commit sha per worktree, or why
    each was skipped. One step at a time per task: a start is refused while a
    step runs or is still being verified. Interactive sessions take no lease, so
    the dialog still warns when `status.yaml` changed in the last 30 minutes while
    nothing runs from here (another session may hold the task); the dashboard's
    own sync does not count. It also warns (never blocks) when the task's newest
    Open hand-off (`open-handoffs.yaml`, below) was recorded after its last Run
    ended, or with no Run at all, in the last 7 days: that session may still be
    working in the worktree and nothing it did was verified.
    Every CLI runs in one sandbox envelope (slice 1 of
    `docs/start-task-redesign-spec.md`, `server/src/services/cliAdapter.ts`):
    writes only in the working directory and `runs/<TASK>`, network off, local
    tests and builds allowed, and the step fails rather than run unsandboxed.
    `claude -p --output-format stream-json --verbose --permission-mode dontAsk
    --permission-prompts none --setting-sources user --no-session-persistence
    --add-dir runs/<TASK> --settings <sandbox enabled, failIfUnavailable, no
    unsandboxed commands, no allowed domains; allow Edit/Write/Read/Bash; deny
    git push, WebFetch, WebSearch>` (`--model claude-opus-5-5` by default;
    `DASHBOARD_CLAUDE_MODEL` overrides); `codex exec -m <DASHBOARD_CODEX_MODEL, default
    gpt-5.6-sol> --json -s workspace-write -C <cwd> --add-dir runs/<TASK> -c
    sandbox_workspace_write.network_access=false -c
    sandbox_workspace_write.exclude_slash_tmp=true -c approval_policy="never"
    --ephemeral -` (`/tmp` refused like claude's sandbox, `$TMPDIR` writable;
    `--skip-git-repo-check` only for a working directory outside a git work tree,
    which task steps never have); `cursor-agent -p --output-format stream-json
    --sandbox enabled --workspace <cwd>` with `<cwd>/.cursor/sandbox.json`
    (workspace read-write plus `runs/<TASK>`, network denied; an existing
    sandbox.json that is not a deny-network workspace policy is never replaced,
    and `--trust` is passed only when the primary worktree is one the dashboard
    created; cursor-agent is refused outside a git work tree, so no sandbox.json
    lands in the workspace root's `.cursor/`). `GOCACHE` points at
    `<cwd>/.cache/go-build`; in a git work tree `.cache/` and `.cursor/` go to
    the repository's `info/exclude`, never `.gitignore`. The prompt goes to the
    CLI's stdin, never argv. Only your user settings load for claude: a
    project-level hook in the working directory's `.claude/settings.json` did
    not run under `--setting-sources user` (checked 2026-10-17). The knowledge
    re-check still runs at the workspace root (claude only).
    A CLI is selectable only when it is usable (`GET /api/launch/tools`, cached
    15 s): on PATH, its help lists every flag the adapter passes, logged in
    (`claude auth status` JSON `loggedIn`; `codex login status` says logged in
    and not "Not logged in"; `cursor-agent status --format json`
    `isAuthenticated`, the only field read, since the rest is personal data),
    and for codex the model is in `~/.codex/model-catalogs/auto.json`; claude
    and cursor-agent have no catalog, which the dialog says. Otherwise the
    dialog shows the reason, and on Windows Run is disabled (macOS first).
    The dialog lists each CLI as usable (with its model or note) or with the
    reason it cannot run. A confirm checkbox gates Run. The result is the
    governance above, never the exit code alone.
    **When** (slice 5, D13): every Run goes through the Run queue (below):
    **Now** (the default: starts at once when a slot is free, else waits),
    **At a time**, **After another task's step ends** or **After another task's
    chain ends** (pick an open task, or this one). A queued Run shows in the
    dialog and the Launch card with what it waits for and **Cancel**; one that
    could not start shows the reason there.
    **One step / Until a human is needed** (slice 6, D12): the second runs a
    role chain (below) from the chosen role. The panel shows the planned
    pairing before start (which CLI writes, which reviews, the step cap; both
    editable, the defaults from the server config) and, once started, the
    chain's timeline with **Stop chain**.
  - **Open** hands the same step to an app you drive (spec D15,
    `server/src/services/openHandoff.ts`): **Claude desktop**
    (`claude://code/new?q=<prompt>&folder=<worktree>`; Claude asks to confirm the
    folder), **Claude Code in the terminal**
    (`claude-cli://open?cwd=<worktree>&q=<prompt>`, your last-used terminal) or the
    **Codex app** (`codex://new?prompt=<prompt>&path=<worktree>`), every parameter
    percent-encoded (`encodeURIComponent`: spaces `%20`, `&` `%26`, newlines
    `%0A`). The server opens the link with `execFile('/usr/bin/open', [url])` (no
    shell); the prompt is filled in, never sent. The dashboard needs no permission
    to open a link, but the apps ask theirs the first time: `claude-cli://` makes
    macOS ask to let "claude" control Terminal.app (Automation; until allowed,
    nothing opens), and the Codex app asks its own permission. The Codex app may
    not come to the front after the link opens: look for its window. The
    worktrees are made or reused exactly as for a Run, after you confirm the
    repositories; the app opens one folder, the primary worktree, so a multi-repo
    task picks it under "Folder to open" (it becomes the primary, and the prompt
    names the others as writable). **Cursor** stays prompt only (its deeplink
    cannot set a folder): Prepare worktree makes or reuses it and shows its path;
    open that folder in Cursor and paste the prompt. Copy prompt is there for
    every target. The open prompt is the Run prompt with the hand-off lines
    changed: the session runs `validate-yaml.rb` itself and leaves enforce, sync
    and the commit to you, since the dashboard does not verify or commit a session
    it opened. **Cap**: the deep links take at most 5,000 prompt characters (the
    smallest limit, `claude-cli://`); a longer prompt is **refused, never cut**
    (the end of the prompt is the output contract and the no-commit rule), with
    the count, in the dialog and by the server (413) before any worktree is made:
    shorten the instructions, or Copy prompt. Cursor has no cap. The deep links
    are macOS only (D9): elsewhere they are disabled with the reason, Cursor
    still works. Open is refused while a Run is running or being verified on the
    task, and takes **no lease**. Each hand-off is recorded in
    `runs/<TASK>/open-handoffs.yaml` (dashboard-owned like `decision.yaml`,
    written atomically, the newest 20; local to this checkout, since the runs/
    allowlist does not sync it; never `status.yaml`):
    `{task_id, handoffs: [{id, at, target, role, worktree, repos, prompt_sha256}]}`.
    The Launch card shows the newest one. An open request is not confirmed
    delivery: if the app did not open, use Copy prompt.
- Launches (Run, Knowledge › **Run re-check now**) are detached and
  file-backed in the OS temp dir (`ai-dev-office-dashboard/launches/<id>.json|log|exit|prompt|timeout|step|integrity`,
  10 kept per task): closing the dialog or restarting the dashboard does not stop
  them, and a launch whose process is gone without an exit code reads `lost`.
  The log holds the CLI's streamed JSON; the server parses it into readable
  progress (assistant text, tool calls, failed commands, the result) shown in
  the Launch card, with the raw stream folded below. A step fails when the exit
  code is non-zero or the stream reports a protocol failure (claude/cursor-agent:
  a `result` with `is_error` or an `error…` subtype; codex: `error` or
  `turn.failed`), or when it exits 0 without its final event; the card says why
  (`failureReason`). Each step has a time limit
  (`DASHBOARD_STEP_TIME_LIMIT_MINUTES`, default 30; knowledge rounds use
  `DASHBOARD_KNOWLEDGE_TIME_LIMIT_MINUTES`, default 60): the wrapper then stops its
  process group (SIGTERM, then SIGKILL to the CLI after 10 s) and the launch reads
  failed with that reason, also across a dashboard restart. The knowledge re-check
  runs through the same adapter (claude, `--model claude-opus-5-5`, plus denies
  for git commit/reset/checkout and rm).
  A small node wrapper (not `/bin/sh`) runs the CLI and records its exit code,
  so the same path runs on Windows; a CLI that cannot start reads `failed`, exit
  127. Stop sends SIGTERM to the process group, or `taskkill /PID <pid> /T /F` on
  Windows. On Windows a CLI is found as `.exe`/`.com`, or through its npm `.cmd`
  shim's script run under node; a `.cmd` that is not an npm shim reads as
  unavailable (spawning it needs a shell, which would parse the arguments). Windows
  support is covered by unit tests only so far (TASK-EAR-404). The wrapper is
  started through a short-lived middle process, so it is re-parented away from
  the dashboard: nodemon kills every descendant on restart (psTree), which took a
  running re-check with it on 2026-10-16. A signal to the wrapper is passed to the
  CLI and still records an exit code (143 for SIGTERM). Endpoints (localhost-only, POST needs
  an allowed Origin): `GET /api/launch/tools` (each CLI's usability, and `open`:
  whether the deep links work here and the prompt cap), `GET /api/launch/task/:taskId`
  (launch, contract once finished, `statusChangedAt`, `lastHandoff`), `POST /api/launch/task/:taskId`
  (`role`, `cli`, `repos`: `[{repo, branch?, base?, adopt?}]`, at least one,
  optional `note` up to 4,000 characters, optional `trigger`: `{kind: "now"}`
  (default), `{kind: "at", at}` or `{kind: "after", taskId, scope?: "step"|"chain"}`; 201 with the
  launch when it started now, 202 with the queue `item` when it waits, 409 with
  the reason when it could not start; GET adds `queued` and `queueFailed`), `POST
  /api/launch/task/:taskId/prompt` (the prompt a Run would send, or with
  `mode: "open"` the one Open fills in, with the planned worktrees for `repos`),
  `POST /api/launch/task/:taskId/open` (`target`: `claude-desktop`, `claude-cli`,
  `codex-app` or `cursor`, plus `role`, `repos`, optional `note`; makes or reuses
  the worktrees, opens the link, records the hand-off), `GET|POST /api/launch/task/:taskId/workspace`
  (task.md's proposal and a plan per repository; nothing is created),
  `GET /api/launch/worktrees` and `POST /api/launch/worktrees/remove`
  (`task`, `repo`, `confirm: true`, optional `deleteBranch`; Command ›
  Operations › Task worktrees, below), `GET /api/launch/queue` (`{cap, running,
  items, recent}`) and `POST /api/launch/queue/:id/cancel`,
  `GET|POST /api/launch/knowledge` (`rounds`: 1, 3 or 5; GET adds the `chain`),
  `POST /api/launch/knowledge/stop`, `POST /api/launch/:id/stop`,
  `GET /api/launch/active` (every running launch without its log or progress,
  for Command › Operations › Running now), `POST /api/launch/task/:taskId/chain`
  (a role chain: `role`, `repos`, optional `note` and `trigger` for the first
  step, optional `writer`, `reviewer` and `cap`; 201 with the chain and launch,
  202 when step 1 waits, 400 for a bad pairing or cap, 409 with the reason when
  it would stop at once or a chain runs on the task; GET `/api/launch/task/:taskId`
  adds the task's newest `chain`), `POST /api/launch/task/:taskId/chain/stop`
  and `GET /api/launch/chains` (the running chains). `GET /api/launch/tools`
  adds `chain`: the default pairing, cap, writer roles and the change-request limit.
- **Role chains** (slice 6, spec D12, `server/src/services/taskChain.ts`,
  `chainOffice.ts`): **Run until a human is needed**. Each step is an ordinary
  Run queue item (the cap, one step per task, the lease, validate → enforce →
  sync and the dashboard commit are unchanged; a queue item carries
  `chain: {id, step}`). When a step has been verified, the dashboard runs
  `ruby scripts/decide-next-step.rb <role> runs/<T>/<role>-output.yaml runs/<T>/status.yaml`
  (the auto pipeline's decision half; nothing of it is reimplemented) and queues
  the role it names, or stops and records why. **Pairing**: the writer CLI runs
  pm, dev, dev-2, debugger and devops, the reviewer CLI runs reviewer, and they
  always differ (default claude writes with Opus 5.5, codex reviews with the
  pinned model; `DASHBOARD_CHAIN_WRITER_CLI` / `DASHBOARD_CHAIN_REVIEWER_CLI`,
  an unusable or equal pair falls back to the default with a warning;
  overridable per chain). A chain that starts at reviewer checks the task's
  newest step before it: a reviewer on the CLI that wrote it is refused.
  **Stop rules**, each shown as the chain's stop reason (`ended.kind` and
  `ended.reason`): `failed` (the step failed, was stopped, hit its time limit,
  was lost, could not start, an agent committed, or the dashboard commit
  failed); `verification` (an office script failed: unmet contract; or the task
  is in `validation_failed`); `gate` (sync exit 5: a completion gate keeps the
  task from `done`, and decide-next-step.rb then names no next role with
  "Completion blocked"); `authorization` (`scripts/authorization-dispatch-check.rb
  decide <T> --role <next>` reports `missing_authorization` or `config_error`,
  or cannot judge the task; stricter than run-agent.sh, which only warns under
  `warn_only`); `blocked` (status.yaml `phase: blocked`, `blocked_on`,
  `waiting_for` or `waits_on`); `changes` (the reviewer's `review_verdict` was
  `changes_requested` more than twice in this chain); `cap` (the step cap,
  `DASHBOARD_CHAIN_STEP_CAP`, default 6, overridable 1–20 per chain: the chain
  stops before the step that would exceed it and names it); `done`
  (decide-next-step.rb says terminal: the reviewer approved, or done; closing,
  merging, pushing and approving stay the operator's); `escalated` (the next
  role is free-roam, which a chain never runs, or the task is escalated);
  `cli` (the step's CLI fails the D4 probe: the chain stops, it never swaps in
  another CLI); `pairing`; `no-next` (no next role, an unknown one, or no
  answer from the script); `queue` (the next step could not be queued, e.g.
  another Run of the task is waiting); `operator` (**Stop chain**: cancels the
  waiting step and stops the running one, like the knowledge chain; also a
  chain step cancelled in the queue). Merge, push and deploy have no signal of
  their own in decide-next-step.rb: an agent cannot do them (network off; the
  dashboard commits locally and never pushes), and the points that lead there
  are `done` and the deploy authorizations of pending gates, both stops above.
  The operator's note goes to the first step only; every step uses the
  repositories confirmed at start. A single Run on a task is refused while its
  chain runs. The chains live in one file per office root,
  `<tmp>/ai-dev-office-dashboard/launches/chains-<root hash>.json`
  (`DASHBOARD_CHAINS_FILE`): `{version: 1, chains: [{id, taskId, startedAt,
  pairing: {writer, reviewer}, cap, repos, note?, steps: [{n, role, cli, model?,
  itemId, launchId?, outcome?: {ok, text}, verdict?, decision?: {next, terminal,
  note?}}], ended?: {at, kind, reason}}]}`, the newest 50 ended kept, and they
  advance on the queue's 5 s timer, so a chain survives a dashboard restart.
  The **timeline** (Launch card, Run panel) lists each step with role, CLI,
  model, status (queued with what it waits for, running, verifying, verified,
  failed, not started), the verification result, the reviewer's verdict, the
  next role decided and the dashboard's commit; Command › Operations › Running
  now lists running chains with their current step.
- **Run queue** (slice 5, spec D13, `server/src/services/runQueue.ts`): every
  Run (task steps from the Start dialog, and each knowledge re-check round) goes
  through one queue kept in a file, one per office root:
  `<tmp>/ai-dev-office-dashboard/launches/queue-<sha256(office root), 12 hex>.json`
  (`DASHBOARD_QUEUE_FILE` overrides; written atomically, temp file + rename; the
  launches dir is shared by every dashboard server on this Mac, so a second server
  with another office root keeps its own queue and never starts this one's items).
  Shape: `{version: 1, items: [{id, kind: task|knowledge, key: <TASK>|knowledge,
  label, enqueuedAt, trigger, step?: {role, cli, repos, note?}, round?: {number,
  total}, chain?: {id, step}, state, launchId?, startedAt?, endedAt?, reason?, fired?, after?,
  dueSince?}]}`, the newest 50 ended items kept. `state`: `waiting`, `starting`,
  `started` (it has a launch), `failed` (could not start: the reason says why),
  `cancelled`, `skipped` (a knowledge round with nothing to re-check). At enqueue
  only what you confirmed is kept (role, CLI, repositories, note); the prompt,
  worktrees and argv are decided when the item starts, from the task files as
  they are then. A server timer (5 s, plus once per enqueue) advances it, so the
  queue **only moves while the dashboard runs**; it survives a restart. Each tick:
  (1) an item left `starting` by a dashboard that stopped mid-start is `started`
  if its pre-assigned launch exists, else `failed` (interrupted); (2) while fewer
  than **`DASHBOARD_RUN_CONCURRENCY` (default 2)** launches run on this machine
  (every running task step and knowledge round, plus items being started), the
  oldest ready item starts. Ready: its trigger fired and no dashboard step of its
  task is running or being verified (**one step at a time per task**, D8: such an
  item keeps waiting; one waiting item per task, a second is refused 409). At
  start the existing guards still apply: a task lease held by another holder
  (run-agent.sh, another session), a CLI no longer usable, a task gone, or a
  worktree refused make the item `failed` with that reason, shown in the Launch
  card, the dialog and the queue panel; it is **never retried**: queue it again.
  Triggers: **now** (a "now" is still refused at once while a step runs or is
  verified on the task, as before the queue); **at a time** (ISO time, at most 1
  min in the past and 7 days ahead; starts at that time or when a slot frees
  after; one first seen due more than an hour late, because the dashboard was not
  running then, fails as `missed` instead of starting late, unattended); **after
  another task's step** (`{kind: "after", taskId, scope: "step"}`): the step is
  resolved at enqueue as that task's waiting queue item, else its step in flight,
  else its next step to start; it fires when that step **ends, however it ends**
  (succeeded, failed, time limit, stopped, lost) **and the dashboard's
  verification of it is done**, so the next step reads the synced status; if the
  awaited queue item fails, is cancelled or skipped, this one fails with that
  reason. **After another task's chain** (`scope: "chain"`) waits on that task's
  running role chain (else the next chain started on it) and fires when the
  chain stops, for any reason, with the stop reason in `fired`. **Cancel** takes a waiting item out before it starts (a started one is
  stopped with Stop instead). Command › Operations › **Run queue** (localhost
  viewers) lists the waiting items oldest first with what each waits for (its
  time, the other task's step, its task to be free, a free slot `n of cap
  running`), Cancel, and the items that could not start in the last day.
- Command › Operations › **Task worktrees** (localhost viewers) lists only the
  worktrees the dashboard created (never adopted ones, never anything outside
  its registry), each with why it is or is not removable: the task is done or
  aborted, no step runs on it, the branch is merged into its base or pushed to
  origin (as of the last fetch), and the worktree has no uncommitted or untracked
  files (the excluded `.cache/` and `.cursor/` do not count). Remove asks for a
  confirmation; the server re-checks and runs `git worktree remove` without
  `--force` (git's own refusals stand). Deleting the branch is a separate tick,
  offered only for a branch the dashboard created that is merged into its base.
  A worktree already gone is only forgotten.
- **Run re-check now ×1/×3/×5** runs rounds back to back: each round is one
  weekly re-check with a brief built when it starts, so it picks the notes the
  previous audit did not look at. Each round is a Run queue item (above), so it
  counts against the same cap as task steps: with the cap taken it waits
  (`POST /api/launch/knowledge` answers 202 with the chain and the queued item;
  the card shows "Round n of N queued: waiting for …" with Stop). The next round
  is queued only after the previous one succeeded; a failed, lost or stopped
  round, a round that could not start or was cancelled in the queue, Stop
  (which also cancels a waiting round), or an empty brief ends the rounds and the
  card says why. Rounds keep their own time limit (60 min). The chain is kept on
  disk (`launches/knowledge-chain-<root hash>.json`, per office root like the
  queue) and advances on the queue's 5 s timer, so it survives a dashboard
  restart.
- Open findings shows who can close them (`coverage` on
  `GET /api/knowledge-reviews/findings`, from the auto-write policy's write
  targets): the re-check run (in scope, with the runs needed to look at each
  once at the brief caps), the operator (Decisions), or nobody automatically
  (outside the policy: a hand edit or an accepted proposal). On 2026-10-16 that
  was 175 / 30 / 62 of 267, about 12 runs to cover the scope once; the
  `outside auto scope` chip filters to the 62 (other projects' notes, 40 Lessons,
  runs/, Weekly Review, jaview).
- Knowledge shows uncommitted vault notes (`GET /api/knowledge-reviews/vault-changes`:
  `git status`/`git log -1` in knowledge-base, read-only), each with the applied
  changes audits recorded since the vault's last commit; a note no audit explains
  reads `no audit` and is listed first; a note an audit lists in `notes_reviewed`
  without a change entry (e.g. the weekly report entry) reads `reviewed by <audit>,
  no change recorded` and is not counted as unrecorded. On 2026-10-16 a re-check killed mid-run
  left three such notes. Each row copies its `git diff` command; nothing here
  reverts or commits.
- Task briefs skip findings an audit looked at in the last 24 hours
  (`RECHECK_COOLDOWN_HOURS`) and say how many: a finding left recurring minutes ago
  has no new evidence, and worst-priority-first put four of them back into the
  next round of a 3-round chain.
- **New task** (slice 7, spec D11, `server/src/services/newTask.ts`, Command ›
  Operations › New task; localhost viewers only, like the Run queue). The
  operator types a **title** and a **request**, picks the **prefix** and the
  **completion gates**: one or more presets from
  `tasks/templates/gate-presets.yaml`, or **No gates** with a required reason
  (custom gates are not offered; open them with `./run-agent.sh open`). Then:
  1. **Claim.** The dashboard runs `scripts/open-task.rb` in the office
     checkout it runs in (`AI_OFFICE_ROOT`: the main checkout, where every run
     is visible) with `--title`, the request as task.md's placeholder
     `--description`, `--agent pm --actor pm`, and `--preset …` or
     `--no-gates "<reason>"`, with `OFFICE_TASK_PREFIX=<prefix>`. The id is
     run-agent.sh intake's rule exactly: the largest `TASK-<PREFIX>-<digits>`
     among the entries of `runs/` and `tasks/` + 1, at least three digits
     (anything else, another prefix, a suffix like `-old`, is ignored; a test
     compares it with `run-agent.sh intake` in a throwaway office). Claims are
     serialized inside the server. Other lanes claim in the same checkout: when
     open-task.rb exits 4 (the directory exists) the next id is tried, at most 5
     ids, then 409. Exits 1 (namespace refused: 403), 2 (usage: 400), 3 (presets
     file: 500) and 5 (write failed, rolled back: 500) are shown with the
     script's message, never retried. open-task.rb is the only writer of the
     new status.yaml (D6). **Prefixes offered**: with a registry
     (`office.team.yaml`), its registered, non-reserved prefixes (never PKG, GW
     or TASK), the dashboard identity's prefix first and preselected; with no
     registry, the configured prefix, else the legacy `TASK-NNN` pool. Nothing
     is claimed when the request is invalid or the pm step's CLI cannot run.
  2. **pm step.** One ordinary Run through the queue (lease, verification,
     provenance) on the chain writer CLI (`DASHBOARD_CHAIN_WRITER_CLI`, default
     claude, Opus 5.5), in **runs-only mode**: no worktree (a pm step changes no
     code, so none is created), the working directory is `runs/<TASK>` and it
     is the only writable one (no `--add-dir`, nothing written into it first:
     no `.cache/`, no info/exclude edit). cursor-agent is refused as a runs-only
     CLI (its sandbox file needs a task worktree). The prompt
     (`taskPrompt.newTaskPmPrompt`) carries the request and the gate decision
     and asks for task.md with Problem, Scope, Acceptance criteria, **Target
     repositories** as `Repo: <name>` lines (what the Run's repository proposal
     preselects; reference-only repositories on a `Reference only:` line) and
     Plan/Risks, plus pm-output.yaml. The dashboard then runs validate → enforce
     → sync as for any step; there is no commit (no worktree, and runs/ is the
     operator's to publish).
  3. **Stop.** The task waits in the New task list: pm running (or queued), pm
     failed (with why: could not start, failed, failed verification; the task
     stays opened, abort it with the office tools), or **task.md ready for
     your review**. The review shows task.md, the repositories proposed from it
     and the pm output's next action, with **Confirm and start chain** (records
     the confirmation, then opens the Start dialog on *Until a human is
     needed* with the repositories proposed from the new task.md; you still
     confirm and start it there), **Redo pm** (queues another runs-only pm step,
     with an optional note), or **Close task here**. A chain on a task opened
     here is refused (409) until it is confirmed or closed; a single Run is not.
  Routes: `GET /api/launch/new-task` (`{prefixes: {allowed, default, note?},
  presets: [{name, gates}], presetsError?, writer: {cli, usable, reason?},
  tasks}`: the tasks still waiting on you), `POST /api/launch/new-task`
  (`{title, request, prefix, presets? | noGatesReason?}` → 201 `{task,
  attempts: [{taskId, exitCode, message}], launch}`; errors `{error,
  attempts?}`), `GET /api/launch/new-task/:taskId` (`{task}`), and `POST
  …/:taskId/confirm`, `…/close`, `…/redo` (`{note?}`). A task view: `{taskId,
  title, request, prefix, gates: {presets} | {none}, createdAt, cli, itemId?,
  itemIds, attempts, queueError?, pmOutcome?, confirmedAt?, closedAt?, state:
  pm|pm-failed|review|confirmed|closed, pm: {status, text?, launchId?},
  taskMarkdown?, proposed?, referenceOnly?, nextAction?}`. The records live in
  one file per office root,
  `<tmp>/ai-dev-office-dashboard/launches/new-tasks-<root hash>.json`
  (`DASHBOARD_NEW_TASKS_FILE`), the newest 50 kept; the queue item of a pm
  step carries `step.runsOnly: true`.
- The old **Advanced › Codex CLI · free prompt** panel and its `/api/cli`
  routes were removed in slice 3 (spec D8/D10): Run is the one launch
  path, so every task step goes through the lease and the office scripts.
- Completion gates come from `scripts/gate-view-json.rb` (the guard's own view,
  read-only). The dashboard shows the grant command; it never records a grant or
  passes a gate. See [../docs/completion-gates.md](../docs/completion-gates.md).

## Current Limitations

- CLI execution is currently Codex-only, with in-memory logs; no automatic
  workflow role dispatch, retry, or `status.yaml` mutation from the dashboard
- The UI currently keeps both the newer `Command` view and the legacy tab shell; consolidate only with browser layout verification
- Authentication is an optional shared bearer token, not per-user roles or permissions
- Persistence is filesystem-local; there is no database-backed control plane
- The Run queue and role chains only advance while the dashboard server runs (no launchd or OS
  scheduler); a time trigger missed by more than an hour fails rather than starting late
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

- Each card shows the current state of every task its question names (`TASK-EAR-363 ·
  aborted 10-12`, from `/api/runs`), linking to Monitor, so a status check reads its answer
  on the card.
- Repeat-a-proposal and is-it-still-true groups offer one answer for all their unanswered
  questions (`Existing proposal is enough`, `Check it for me`) after a confirm; each finding
  is still recorded on its own, with the same actor, through the endpoint below.

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
  `mentioned` = an open run names it; `closed_recently` = a run closed within
  `closed_window_days` (14) names it and no failure is after its close (the owner just finished,
  so it saw the last failure); `recurs_after` = every such run closed before the last failure (a
  date-only close counts from the end of that Bangkok day); `unowned` = none of these.
  `closed_recently` wins over `recurs_after` (operator decision 2026-10-17: TASK-VS-040 closed at
  21:24Z having recorded the 20:31Z timeout, yet Attention said "still failing after a run
  closed"); the earlier run still shows as "still failing after TASK-…" detail. Mentioned is
  not fixed. Only unowned and recurs_after count toward Attention's top line.
- **Related, not owners:** when a group has an error phrase, a run whose files match only its
  path is about the endpoint, not this failure: it is listed as `related` (a quiet
  "related: TASK-…" line, and `Related (not owners)` in the task brief) and never counts toward
  coverage (operator decision 2026-10-17: `POST /v1/slips/verify -> 502 bank verifier
  unavailable` listed TASK-VS-039, about deploy 502s, next to its owner TASK-VS-028). A group with
  no usable error phrase (only a path term) is still owned by path matches.
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
- Days are the office's local dates (`OFFICE_TZ`, default Asia/Bangkok): status.yaml's date-only fields mean local midnight, bars are local days, and the window starts at local midnight of the first bar, so the counts always equal the sum of the bars (in UTC a run opened after Bangkok midnight was missing until 07:00).
- The same rule holds wherever the dashboard counts from a date-only field (`server/src/services/officeTime.ts`; the client's `statusTimeMs` in `formatAge.ts` reads it as the viewer's local midnight, so it assumes the viewer is in the office zone):
  - the review model's `idle`, which drives Attention's `stale >Nd`, `stale_work`, and Flow health's idle penalty;
  - Oldest wait;
  - the 3D Review room's ages and line order;
  - `formatAge`: Attention's Age, Command's zone ages, and the 3D room `Stale` line;
  - the run list's recency order.

  Until 2026-10-24 several of these read the date as UTC midnight. So between 00:00 and 07:00 local time, a task now goes stale up to 7 hours sooner than it did. A date-only value that is not a calendar day (`2026-13-01`, `2026-02-30`) reads as no time on both sides.
- Throughput counts closes by `completedAt` and opens by `startedAt` inside the window; aborted runs (status cancelled) are counted apart (`N aborted`, a grey bar per day), never as closed. Open-to-done time comes from `history` timestamps when they fit (the first one within 36h of `created_at`, the last transition into done), else from `created_at`/`completed_at`, which are dates only (before 2026-10-16 that read 16 of 32 same-day closes as 0d); the card says how many runs were timed from history. Runs closed within 30 days of opening report median/p90 in minutes, hours or days; runs open longer are counted apart as backlog clean-up with the oldest age (`shared/flow.ts` `FLOW_BACKLOG_DAYS`)
- Who moved work counts `history` phase changes (from ≠ to; gate updates excluded) inside the window, by role and by operator, and reports how many runs that changed phase recorded a conductor. Opening a task (`created -> …`) is shown apart (`+N opened` per actor, total in the header), and same-phase entries (`blocked -> blocked`: notes, evidence, metadata) are counted but not moves — pm read 52 moves before 2026-10-16, 31 of them openings and 11 same-phase. History is read only for runs updated inside the window
- The window choice is persisted in `sessionStorage` (`dashboard_analytics_days`)
- There is no cache layer; each request recomputes from filesystem data
- Flow health is distinct from dashboard/server health

## Readiness: release ladder

- `GET /api/reports/release-ladder` returns, per product (task prefix: EAR = Games Labs, VS = VerifySlip, KAS = Casper), every run that declares `completion_gates` with each ladder rung's gate status (`pass` / `pending` / `na` / `absent`), the 2C run record of a pass (`by`, `ref`, `url`), gates outside the ladder, and `waitingOnProd` (the next pending rung is `deploy_production` or `production_acceptance`)
- Rungs come from `CompletionGuard.gate_view` (`scripts/gate-view-json.rb`), the same source Monitor shows; nothing is inferred from phase, branch state or prose, and an unreadable gate view is shown as unreadable
- A release train lists the tasks it promotes in `status.yaml` `carries` (`scripts/update-train-carries.rb`); a carried task's `deploy_production` / `production_acceptance` rung that it does not declare itself is credited from the train's gate of the same name and marked `via <train>` (a train whose gates use other names credits nothing)
- Tasks recording `waits_on` kind `prod_run` (`scripts/update-waits-on.rb`) are listed as what a production run would also unblock
- Runs without `completion_gates` (the contract started 2026-10-07) are listed under "No gates recorded": readiness unknown, never assumed — unless a train carries them. Products with no gated task at all (Legacy, PKG, Casper) share one "No gated tasks yet" card, one toggle per product. Complete tasks fold under one "N complete" row at the end of their product's table, so open work leads: production acceptance passed, or done with every gate the task declared passed or not applicable (a test-only fix that declares only implementation_verification is complete at Verified); the row says how many of them are proven in production
- There is no cache; each request reads every run's `status.yaml` and runs `gate-view-json.rb` only for gated runs
