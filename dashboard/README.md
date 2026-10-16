# AI Dev Office Dashboard

Filesystem-backed operational dashboard for `ai-dev-office/runs`. Most views are
read models; the narrow write surface is documented below.

## Views

- `Command`: opens on `Attention` (below); the `Operations` panel (`?tab=command&view=operations`) holds the live workflow map, queue, `Running now` (what a Start button is executing right now; localhost viewers only), `Waiting on` (open tasks by `current_agent`: who a task waits on, not a running agent), health, logs (each line stamped with the last hand-off's time, `MM-DD HH:MM`, when history has one), and task detail/decision controls. Queue, health and Insights counts share one definition (`shared/runCounts.ts`): active = running + in review + blocked + queued + failed; runs whose `status.yaml` cannot be read are counted as `Unreadable`, never as active In Attention, "What unblocks work" leaves out a release train waiting on its own run (`isOwnRunWait`, shared with Readiness), and a recommended action that is a command (the authorization grant) shows one line with `Copy command`. Each Attention row of a gated task also shows how far its gates got and what is next (`Prod deployed · next: Prod accepted`, from the release ladder), since the hand-off note can be older than the gates: lanes advance gates without a phase change (VS-028 read "Not merged" after its prod deploy, 2026-10-16). In Operations, Dev Bay (the assigned phases) is toned queued, not "agent on it", and the queue filter for runs awaiting a review decision reads `Review`. Attention's `Bookkeeping` section lists records a person still has to keep, outside the "need attention" count: a blocked task with no `waits_on`, and a staging-accepted task with no production gate that no train carries (with the open trains of its product); each row has the fixing command to copy. When production signals hold errors no run owns (or that recur after a run closed), Attention shows a line near the top that scrolls to the panel. Signals note failures that fell inside an ECS rolling deployment of a service in the same cluster (from the services' events: first task start to `deployment completed`, +60 s; a scale-out's start with no completion is not a deployment): a badge such as `all during 2 deploys`, a `Timing:` line in the task brief, and `(all during deploys)` on the Attention line; only when at least half of a signal's failures fall in deployments. On 2026-10-16 the upstream-connect 502s were all cut connections during two slip-system rollouts. The summary cards fit as many per row as the width allows. Operations' health panel shows the done rate of runs finished in the last 30 days (`doneRateWithin`), not the all-time rate. Bookkeeping sits under the action table, one line per task under one explanation per kind.
- `Monitor`: browse runs (default scope Active; Finished and All group by month of last update; filter by task prefix; a deep link to a finished run widens the scope and scrolls to it), with no run selected it lands on the five most recently updated runs and up to five runs waiting on a human (Attention keeps the full list); open a run's full detail: status with the server's idle badge, why it needs a human, the next action and desktop handoff, decision controls, reviewer issues, timeline (newest first), task.md, artifacts, completion gates, and direct log files inside a run directory Run detail also shows `Waits on` (status.yaml `waits_on`), a `Release` card (what a train `carries` with each task's highest rung, or which trains carry this task and its prod rung; a task on several trains is proven only when all pass), renders GitHub tables in task.md, hides dotfiles from Artifacts, and folds the review decision buttons unless the run is in review or a decision is pending. A run in the `assigned` phase reads `Assigned`, not `In progress`. Within a status the run list puts the most recently moved run first (`lastHandoffAt`, the latest timed phase change in history, else `updated_at`); task numbers only break ties, since each project numbers its own tasks (EAR in the 400s, VS in the 30s) and ordering by number put every EAR run above any VS run. A row shows `▶ running · N min` while a Start-button step runs on that task (`GET /api/launch/active`, localhost viewers), and run detail has a `Launch` card with the newest step on the task, its output, and the server's contract check once it ends. The recommended-action card reads `RECOMMENDATION` (its button opens Start, which runs only after you confirm). Each row's time is the one the list sorts by (the last hand-off, `MMM D, HH:MM`, else `updated_at`); a run with no recorded title reads `(no title recorded)`. A finished run (done or aborted) shows `Closed · <phase> <date>` with the reason from the transition that closed it, and no next-action card. An aborted run is never flagged as artifact drift: its last verdict no longer matters (a done run with an adverse verdict still is). Search treats hyphens, underscores and spaces alike and, when the scope hides matches, says how many sit in the other scope with a `Show all` switch. Run detail lists folders (evidence/) as folders with their size, shows a command recommendation with `Copy command`, and dims timeline rows that record metadata (gate updates, waits_on, carries) with a tag so hand-offs stand out. The collapsed timeline folds consecutive metadata rows into one line and always reaches the latest hand-off; rows are ordered by time when every row has a full timestamp (some history blocks were written out of order), and the review model's `lastTransition` is the latest by time too. The landing's `Waiting on you` uses Attention's order (kind first), and `Recently updated` breaks same-day ties by the last hand-off time.
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
    own sync does not count.
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
    A confirm checkbox gates Start. The result is the governance above, never
    the exit code alone.
  - Cursor uses its [documented prompt deeplink](https://prod.cursor.com/docs/reference/deeplinks);
    Codex and Claude use Copy prompt for manual paste. Select the target workspace
    in the app yourself; the prompt link does not switch repositories. The
    desktop handoff reports an open request, not confirmed delivery or execution.
    Links exceeding Cursor's 10,000-character limit require Copy prompt.
- Launches (Start here, Knowledge › **Run re-check now**) are detached and
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
  an allowed Origin): `GET /api/launch/tools`, `GET /api/launch/task/:taskId`
  (launch, contract once finished, `statusChangedAt`), `POST /api/launch/task/:taskId`
  (`role`, `cli`, `repos`: `[{repo, branch?, base?, adopt?}]`, at least one,
  optional `note` up to 4,000 characters), `POST
  /api/launch/task/:taskId/prompt` (the prompt a Start would send, with the
  planned worktrees for `repos`), `GET|POST /api/launch/task/:taskId/workspace`
  (task.md's proposal and a plan per repository; nothing is created),
  `GET /api/launch/worktrees` and `POST /api/launch/worktrees/remove`
  (`task`, `repo`, `confirm: true`, optional `deleteBranch`; Command ›
  Operations › Task worktrees, below),
  `GET|POST /api/launch/knowledge` (`rounds`: 1, 3 or 5; GET adds the `chain`),
  `POST /api/launch/knowledge/stop`, `POST /api/launch/:id/stop`, and
  `GET /api/launch/active` (every running launch without its log or progress,
  for Command › Operations › Running now).
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
- The old **Advanced › Codex CLI · free prompt** panel and its `/api/cli`
  routes were removed in slice 3 (spec D8/D10): Start here is the one launch
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
- Days are the office's local dates (`OFFICE_TZ`, default Asia/Bangkok): status.yaml's date-only fields mean local midnight, bars are local days, and the window starts at local midnight of the first bar, so the counts always equal the sum of the bars (in UTC a run opened after Bangkok midnight was missing until 07:00).
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
