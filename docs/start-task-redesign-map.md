# Start or open task — redesign decision map

Decision map for redesigning the dashboard's "Start or open task" from scratch
(operator request, 2026-10-16, after the codex review of TASK-EAR-404 requested
changes). Format: `ai-skills/decision-wayfinding/references/decision-map.md`.
This file is problem state, not an evidence ledger; verified reusable findings
go through knowledge-capture when the spec is done.

Starting point (what exists on main at efdca4ef, for reference only — none of it
is assumed to survive):

- Monitor › Start or open task dialog: Start here (claude / codex / cursor-agent),
  Cursor deeplink, copy-prompt for Codex/Claude, Advanced › Codex CLI free prompt.
- Detached file-backed launcher (`dashboard/server/src/services/officeLauncher.ts`,
  `routes/launch.ts`), server-built step prompt (`taskPrompt.ts`), post-run
  contract check (`taskContract.ts`), knowledge re-check rounds (`knowledgeChain.ts`),
  Running now / Launch card / running badge in the UI.
- Codex review of TASK-EAR-404 (`runs/TASK-EAR-404/reviewer-output.yaml`):
  target repository not validated (runs from the workspace root), PATH-only
  availability with no login probe, plain-text output (no stream-json / JSONL),
  `--skip-git-repo-check`, `cursor-agent --trust`, Windows unverified.
- TASK-EAR-404 was aborted on 2026-10-16 (operator decision; `runs/TASK-EAR-404`
  keeps its history and the codex review). Its branch `task/TASK-EAR-404` and
  worktree were deleted the same day. The branch's two commits (54e29f41,
  ead05448) are unreachable now and git may prune them; their design, kept here
  for I2:
  - `cliRunner.ts` adapters for codex and claude behind one `CliRunner`, stdin
    prompt, in-memory runs (lost on restart), 30-minute limit.
  - codex: `exec --json --color never --sandbox <read-only|workspace-write>
    -c approval_policy="never" -` (keeps codex's git-repo check).
  - claude: `-p --output-format stream-json --verbose --include-partial-messages
    --restricted --strict-mcp-config --no-session-persistence --tools
    Read,Glob,Grep[,Edit,Write] --permission-mode plan|acceptEdits
    --permission-prompts none` (flags as written on the branch; R1 must confirm
    they exist in the installed CLI).
  - Usability probe (15 s cache): `--help` must list the required flags, then
    `codex login status` (matches /logged in/) or `claude auth status` (JSON
    `loggedIn: true`); unavailable CLIs carry a reason.
  - A run fails on a JSON protocol error event (`turn.failed`, `error`, or a
    `result` with `is_error`), not only on the exit code.
  - Target workspace: operator-typed absolute path inside a git repo, suggested
    from `git worktree list` when a `task/<TASK-ID>` worktree exists.
  - Cursor stayed copy-prompt / deeplink only.

```yaml
destination:
  outcome: >-
    "Start or open task" is decision-complete: what it does, who it starts, where
    and with what permissions it runs, how the dashboard knows the outcome, and
    what happens to today's code, written as an implementation-ready V1 spec.
  done_when:
    - "Every decision on the V1 path is resolved or explicitly deferred with a reason"
    - "No fog item blocks a V1 decision"
    - "The fate of the current Start-here code, the launcher, knowledge re-check rounds, CliRunPanel and the task/TASK-EAR-404 branch is decided"
  v1_boundary: >-
    The operator's local dashboard (localhost, one operator). In: start or hand off
    a role step of a task; open a new task from the dashboard; chain roles
    automatically; schedule or queue steps; run steps of several tasks at once.
    Out: multi-user or remote execution.
  status: confirmed
  confirmed_by: "operator, 2026-10-16 (AskUserQuestion: expand V1 with new-task intake, role chaining, scheduling/queue, parallel tasks)"

nodes:
  - id: D1
    type: decision
    title: "What is the button for: start an unattended agent step, hand off to an interactive session, or both?"
    status: resolved
    depends_on: [I1]
    outcome: >-
      Both, with unattended runs as the primary engine. Run = an agent executes the
      step in the background (the basis for chaining, queueing and parallel tasks).
      Open = hand the same task context to a session the operator drives, for steps
      that need judgment or conversation. Both share one prompt and one contract check.
    evidence: ["I1 (chat-first today)", "destination V1 (chaining, queue, parallel need unattended runs)", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: I1
    type: investigation
    title: "How are task steps actually started and worked today (run-agent.sh, interactive Claude/Codex/Cursor sessions, Start here), and what did each Start-here use on 2026-10-16 show?"
    status: resolved
    depends_on: []
    outcome: >-
      Chat-first. In the last 30 days 108 of 110 tasks never went through run-agent.sh;
      the only 7 dispatches (EAR-389/390, 10-12, codex dev-2) changed no code because
      codex's read-only sandbox could not write a service repo. Claude is the main
      conductor/advisory lane (54 tasks name it), Codex a co-conductor and the reviewer
      started from the dashboard; Cursor and Gemini are effectively unused. Work lands
      on task/* branches in the shared main checkouts (146 branches across 16 repos;
      api-gateway's checkout sits on task/TASK-EAR-386 now); only 3 real worktrees exist
      and worktree_exclusive is false. Operator model (AGENTS.md:140): "Solo is the
      default"; delegation happens inside the conductor's session, not run-agent.sh.
      Dashboard launches 10-16: 3 knowledge rounds succeeded (3 valid audits), 1 lost
      to a nodemon restart (vault edits with no audit), 1 codex step failed on a model
      the account rejects, 1 codex reviewer step succeeded (contract met).
    evidence: ["runs/*/run-records (11 tasks ever)", "AGENTS.md:110-140", "docs/claude.md:13-17", "office.config.yaml:39-43,269-276", "launches/*.json 2026-10-16"]
    resolved_at: 2026-10-16

  - id: I2
    type: investigation
    title: "Capability inventory: main (launcher, prompt, contract check, chain, CliRunPanel) vs branch task/TASK-EAR-404 adapters — what each does, with tests"
    status: resolved
    depends_on: []
    outcome: >-
      Keep candidates: detached file-backed launcher with a lost state (only design that
      survived a tree kill, tested); server-built prompt with the adapter contract;
      contract check instead of exit 0; branch's stdin prompt (no ps exposure or Windows
      command-line limit), protocol-event failure detection, flag-then-login probe with
      a reason, Claude positive tool allowlist; main's Windows .cmd shim resolution and
      codex model pin; typed path -> realpath -> .git validation; localOnly; the
      persisted knowledge chain. Liabilities: Start here runs from the workspace root
      with --skip-git-repo-check; claude step allows Bash with prefix-only denies
      (bypassable); cursor-agent --trust; PATH-only availability; no time limit;
      mtime-based contract check (another session's edit counts) that also runs for
      failed launches and never prunes; no guard across /api/launch and /api/cli;
      Windows Stop ignores taskkill's result; plain-text output (no progress); branch:
      in-memory runs, codex regex /logged in/i also matches "Not logged in", generic
      client prompt, raw JSONL in a pre, base predates Start here.
    evidence: ["dashboard/server/src/services/officeLauncher.ts", "taskContract.ts:20-37", "routes/launch.ts:19-114", "routes/cli.ts:30-43", "scratchpad ear404-branch patches (P1)"]
    resolved_at: 2026-10-16

  - id: R1
    type: research
    title: "Current noninteractive contracts of the installed claude, codex and cursor-agent CLIs: streamed output, login/status probes, permission and tool controls, extra writable dirs, git-repo checks"
    status: resolved
    depends_on: []
    outcome: >-
      All three are installed and logged in; each has a print mode, streamed JSON and a
      login probe. claude 2.1.285: -p, --output-format stream-json
      (--include-partial-messages), `claude auth status` (JSON loggedIn), --restricted
      (no shell/code tools, file tools confined to working dirs, refuses
      bypassPermissions), --tools, --allowed/--disallowed-tools, --permission-mode,
      --permission-prompts none, --strict-mcp-config, --no-session-persistence,
      --add-dir, --max-budget-usd; cwd = process cwd. codex 0.157.1: exec, --json
      (JSONL), `codex login status` (one text line, no JSON), -s read-only|workspace-write,
      -C/--cd, --add-dir, --ignore-user-config (the only MCP isolation lever),
      --ephemeral, -m; -a/--ask-for-approval is top-level only (not on exec);
      --skip-git-repo-check exists; config model gpt-6.1-sol is not in the account
      catalog (auto, gpt-5.6-sol/terra/luna listed), so -m must be explicit.
      cursor-agent 2026.10.01: -p has all tools incl. write and shell unless --mode
      plan|ask; stream-json; `cursor-agent status --format json` (contains PII); no
      tool allow/deny lists, no MCP isolation, no ephemeral sessions, no budget cap.
      Avoid: claude bypassPermissions/--dangerously-*; codex danger-full-access,
      --dangerously-*, --search; cursor-agent -f/--yolo, --sandbox disabled,
      --approve-mcps, --trust.
    evidence: ["claude --help / auth status, codex --help / exec --help / login status, cursor-agent --help / status (2026-10-16, read-only); spot-checked by the conductor"]
    resolved_at: 2026-10-16

  - id: D2
    type: decision
    title: "Run execution model: how an unattended step is hosted (process model, restart survival, time limit, prompt transport, output format)"
    status: resolved
    depends_on: [D1, R1]
    outcome: >-
      A detached, file-backed process per step (evolving today's launcher, which
      survived a nodemon tree kill): prompt over stdin, the CLI's streamed JSON
      (claude stream-json, codex --json JSONL, cursor-agent stream-json) translated by
      the server into readable live progress, a per-step time limit, and failure decided
      from the CLI's protocol events as well as the exit code. Not a Terminal tab per
      step, not run-agent.sh.
    evidence: ["I2 keep list", "R1 streamed-output flags", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: R2
    type: research
    title: "Open: which apps can be opened on a task with a folder and a prompt (Claude Code desktop/CLI, Codex app, Cursor deeplink, a Terminal tab running the CLI), verified on this Mac"
    status: resolved
    depends_on: []
    outcome: >-
      Documented prefill-only deep links that set the folder exist for three targets,
      opened with /usr/bin/open (execFile, no shell, no Automation permission):
      Claude desktop Code tab `claude://code/new?q=&folder=` (about 14,000 chars; always
      asks to confirm the folder), Claude Code CLI in the last-used terminal
      `claude-cli://open?cwd=&q=` (5,000 chars; handler registered here), Codex desktop
      (ChatGPT.app, com.openai.codex) `codex://new?prompt=&path=` (or threads/new).
      Cursor's prompt deeplink cannot set a folder (and has '&' truncation reports).
      CLIs without a deep link (codex, cursor-agent) need a Terminal tab via osascript
      `do script`: Automation permission prompt, double escaping, and the prompt is
      sent immediately. None of the links were opened during research; the schemes are
      registered (plists checked by the conductor).
    evidence: ["support.claude.com/en/articles/14729294", "code.claude.com/docs/en/deep-links", "learn.chatgpt.com/docs/reference/commands", "cursor.com/docs/reference/deeplinks", "app Info.plist CFBundleURLSchemes (2026-10-16)"]
    resolved_at: 2026-10-16

  - id: D15
    type: decision
    title: "Open mechanism: which hand-off targets V1 offers and how the hand-off is recorded on the task"
    status: resolved
    depends_on: [R2, D6]
    outcome: >-
      Open offers Claude desktop (claude://code/new?q=&folder=), Claude Code in the
      terminal (claude-cli://open?cwd=&q=) and the Codex app (codex://new?prompt=&path=),
      opened with /usr/bin/open via execFile, on the task's worktree with the same prompt
      prefilled (not sent; capped at 5,000 characters, the smallest limit). Cursor stays as
      'prompt only, open the folder yourself'. The hand-off (target, time, launch id) is
      recorded so the task shows it was opened.
    evidence: ["R2", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D3
    type: decision
    title: "Where a step runs: target repository selection and validation, how the agent also reaches the run's office files, worktree or not"
    status: resolved
    depends_on: [D2, I1]
    outcome: >-
      A git worktree per task per repository, created or reused by the dashboard at
      .worktrees/<repo>-<TASK> on branch task/<TASK>..., as the step's working directory;
      runs/<TASK> is added as the only other writable directory (claude/codex/cursor
      --add-dir). The target repositories are proposed from task.md and confirmed by the
      operator before a Run; a multi-repo task gets one worktree per repo. Worktrees
      left behind need a cleanup path (part of D14).
    evidence: ["I1 (shared main checkouts, api-gateway on task/TASK-EAR-386, worktree_exclusive false)", "R1 (--add-dir on all three CLIs; codex -C)", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D4
    type: decision
    title: "Which agents V1 offers, and how 'usable' is decided (installed, compatible, logged in, model allowed)"
    status: resolved
    depends_on: [D2, R1]
    outcome: >-
      Run offers claude, codex and cursor-agent (operator chose to include cursor-agent;
      how tightly it is confined is D5). A CLI is selectable only when it is installed,
      its help lists every flag the adapter uses, its login probe says logged in
      (`claude auth status` JSON loggedIn, `codex login status` text, `cursor-agent
      status --format json` isAuthenticated; read only that field, never log the PII),
      and the model to be used is allowed (codex: in the account catalog; -m always
      explicit). Unusable CLIs show the reason.
    evidence: ["R1", "I2 (branch probe shape, codex regex flaw)", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: R3
    type: research
    title: "Sandbox semantics per CLI for steps that must run shell commands (tests, builds): Claude Code bash sandbox settings (filesystem and network limits via --settings), codex workspace-write (writable roots, network default), cursor-agent --sandbox enabled; can each confine writes to the worktree + runs/<TASK> and block network/git push?"
    status: resolved
    depends_on: []
    outcome: >-
      From docs only (no live run). claude: Seatbelt sandbox for Bash via per-run
      --settings {sandbox.enabled, failIfUnavailable, allowUnsandboxedCommands:false,
      network allowedDomains [] + strictAllowlist}; writes = cwd, temp, --add-dir; a
      linked worktree may write the main repo's .git so git commit works; dontAsk +
      --permission-prompts none; Edit/Write, hooks and MCP run outside the sandbox
      (repo hooks still run in -p). codex: -s workspace-write writes cwd + /tmp +
      --add-dir, network off by default (sandbox_workspace_write.network_access), but
      .git and a worktree's gitdir are read-only, so in-sandbox git commit should fail
      (commit outside the agent). cursor-agent: --sandbox enabled (Seatbelt,
      workspace_readwrite, network default deny plus an unpublished package-manager
      list), extra paths only via a sandbox.json file, headless behaviour documented only
      in a forum reply; local config has its sandbox disabled. All three: Go caches
      (GOCACHE ~/Library/Caches/go-build, GOMODCACHE ~/go/pkg/mod) sit outside the
      worktree, so confined go test needs redirected caches and pre-fetched modules.
    evidence: ["code.claude.com/docs/en/sandboxing", "learn.chatgpt.com/docs/agent-approvals-security", "cursor.com/docs/reference/sandbox", "local ~/.claude, ~/.codex, ~/.cursor config keys (2026-10-16)"]
    resolved_at: 2026-10-16

  - id: P1
    type: prototype
    title: "Throwaway spike: run each CLI once with the D5 envelope in a scratch worktree (outside production paths) and check: writes outside worktree + runs dir refused, network refused (git push, curl), go test / npm test pass with redirected caches, claude git commit in a linked worktree, codex commit refused"
    status: resolved
    depends_on: [D5]
    outcome: >-
      Ran once per CLI on 2026-10-16 in a throwaway repo under ~/.p1-spike (outside /tmp,
      which codex's sandbox allows; deleted afterwards), one worktree and runs dir each,
      same six steps. claude (-p, --settings sandbox enabled/failIfUnavailable/no
      unsandboxed retry/no domains, dontAsk, --permission-prompts none, --add-dir):
      worktree and runs writes OK, outside write refused (operation not permitted), go
      test OK, network refused (proxy 403), git commit refused by dontAsk. codex (exec -m
      gpt-5.6-sol -s workspace-write -C, --add-dir, network_access=false): same, and
      commit refused (index.lock not permitted). cursor-agent (-p --trust --sandbox
      enabled --workspace, .cursor/sandbox.json with the runs path and network deny):
      writes OK, outside refused, go test OK, network refused (CONNECT 403), but git
      commit succeeded. So all three hold the envelope for writes and network; cursor-agent
      can commit locally, so the dashboard must detect an agent commit (HEAD moved) and
      flag it, since D5 keeps commits to the dashboard. cursor-agent qualifies for Run.
    evidence: ["P1 spike outputs 2026-10-16 (claude.out, codex.out, cursor.out; files checked on disk)"]
    resolved_at: 2026-10-16

  - id: D5
    type: decision
    title: "Permission envelope per agent: write scope, tools, network, git push/merge, production guardrails"
    status: resolved
    depends_on: [D2, D4, R1, R3]
    outcome: >-
      One envelope for every CLI, using each one's macOS sandbox: writes only in the
      task worktree and runs/<TASK>, network off, local test/build commands allowed (the
      dashboard points Go caches at writable locations and expects modules present); if
      the sandbox cannot start, the step fails rather than running unsandboxed. Agents
      never commit, push, merge or deploy: after the contract check passes, the dashboard
      commits the step's diff on the task branch (local commit, no push). cursor-agent is
      offered for Run only if the P1 spike shows its sandbox holds; otherwise plan mode
      only.
    evidence: ["R3", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D6
    type: decision
    title: "Governance: server-built prompt with the adapter contract, run-agent.sh dispatch, or something else; how outputs and status come back and are verified"
    status: resolved
    depends_on: [D1, I1]
    outcome: >-
      The dashboard is the runtime adapter (docs/runtime-adapter-contract.md): the
      agent only writes runs/<TASK>/<role>-output.yaml from a server-built prompt; the
      dashboard holds the task's ownership lease (scripts/task-ownership.rb) for the
      whole step, then runs validate-yaml.rb -> enforce-output-contract.rb ->
      sync-status-from-output.rb itself and records launch id, CLI and model as
      provenance. The dashboard writes status.yaml only through those governed scripts,
      as run-agent.sh does; it never edits it directly. Replaces the mtime-based
      contract check.
    evidence: ["I2 liabilities (mtime check, agent-run sync)", "I3 adapter scripts and lease", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D7
    type: decision
    title: "Observability: streamed output format, live progress, history retention, where results show"
    status: resolved
    depends_on: [D2, R1]
    outcome: >-
      Follows D2: the server turns each CLI's streamed JSON into readable live progress
      (assistant text, tool calls, results) shown in the run's Launch card, Running now and
      the chain timeline; raw logs stay on disk, 10 kept per task; the final state shows
      the contract result and the dashboard's commit.
    evidence: ["D2", "I2 (raw JSONL unreadable, plain text shows nothing until the end)"]
    resolved_at: 2026-10-16

  - id: D8
    type: decision
    title: "Concurrency and ownership: one active step per task, interplay with run-agent.sh ownership leases, detecting another session on the task"
    status: resolved
    depends_on: [D2, D6]
    outcome: >-
      Follows D6/D13: one step at a time per task (queue rule) and the task's ownership
      lease held by the dashboard for the whole step, so run-agent.sh dispatches and other
      leased writers are fenced; one guard across every launch path (no second path like
      the old /api/cli). Interactive sessions take no lease, so the 'status.yaml changed
      recently' warning stays, and an Open hand-off is recorded so a later Run warns.
    evidence: ["D6", "D13", "I2 (no guard across /api/launch and /api/cli)", "I3 (leases)"]
    resolved_at: 2026-10-16

  - id: D9
    type: decision
    title: "Platforms in V1: macOS only, or Windows too (and how it is verified)"
    status: resolved
    depends_on: [D2, I1]
    outcome: >-
      macOS first. V1 is designed and verified on macOS; code must not close the door on
      Windows (node wrapper, no shell coupling), and on Windows Run is disabled with a
      clear reason instead of failing silently. Windows support is a follow-up verified
      on a real Windows machine.
    evidence: ["I1 (dashboard used on this Mac)", "R2/R3 (deep links and sandboxes are macOS-specific)", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: I3
    type: investigation
    title: "What run-agent.sh and office scripts already provide for intake/open, the auto pipeline, parallel dev lanes, ownership leases, loop limits and runner fallback — reusable for chaining, queueing and parallel runs?"
    status: resolved
    depends_on: []
    outcome: >-
      (a) Open: `open <ID> --preset` -> scripts/open-task.rb is a real atomic claim
      (mkdir, lock, rollback, exit 4 when the id exists, no git side effects); ids are
      max+1 over the checkout's runs/ listing, so they must be claimed where all runs
      are visible (main), and intake previews reserve nothing (event-gateway.rb:431-456
      solved the same race with a locked mapping file). (b) Chain: `<ID> auto` loops
      steps via the pure scripts/decide-next-step.rb (role next_action, reviewer verdict
      fallback, fixed map, completion gates); stops on unresolved gates (exit 0),
      blocked/done, changes_requested loops at loop_guard.max_iterations 8, free-roam 3,
      validation_failed retries, execution-budget escalation; but it always restarts at
      pm, re-runs itself per step, is Codex-first, and Claude may never be its runner
      (docs/claude.md). The five adapter-contract scripts let an external driver chain
      without auto. (c) Queue/schedule: none exists; a dashboard would have to own it.
      (d) Parallel: only two dev lanes inside one task; across tasks separate processes
      work (lease + .lock per task) but worktree_exclusive is false, so tasks can edit
      the same repo checkout. Conflicts: git auto-sync (off now) would pull/push from
      the served checkout; no lease spans a whole auto run; dashboard must only write
      decision.yaml (applied at the next non-pm dispatch).
    evidence: ["run-agent.sh:335-351,611-625,1899-1907,2370-2426", "scripts/open-task.rb:76-220", "scripts/decide-next-step.rb:50-89", "office.config.yaml:39-54,121-129,255-276,515-516", "docs/runtime-adapter-contract.md:80-123"]
    resolved_at: 2026-10-16

  - id: D11
    type: decision
    title: "New task from the dashboard: what the operator types, who writes task.md, how the id is claimed (main checkout), preset/gate choice, and whether a first step starts right away"
    status: resolved
    depends_on: [I1, I3, D6]
    outcome: >-
      The operator types a short request and picks the prefix and gate preset; the
      dashboard claims the id with scripts/open-task.rb in the office's main checkout
      (where the dashboard runs, so every existing run is visible), then runs a pm step
      that writes task.md (problem, scope, acceptance, target repositories) and stops for
      the operator to read and confirm before any chain starts.
    evidence: ["I3 (open-task.rb atomic claim; ids are max+1 over the checkout)", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D12
    type: decision
    title: "Role chaining: what drives the next step (next_action), where a chain must stop (human gates, authorization, changes_requested loops, failures), step limits, and which agent runs each role"
    status: resolved
    depends_on: [D2, D6, I3]
    outcome: >-
      The next role comes from scripts/decide-next-step.rb (role next_action, reviewer
      verdict fallback, completion gates). A chain stops at every point that needs a
      human: a gate needing a person or an authorization, a blocked task, a failed step,
      an unmet contract, a reviewer asking for changes more than twice, a per-chain step
      cap (about 6), and anything that would merge, push, deploy or approve; those stay
      the operator's. Agents per role: the reviewer is always a different agent from the
      one that wrote the step; default Claude writes (pm, dev, dev-2, debugger, devops)
      and Codex reviews, swappable to Codex writes / Claude reviews per chain; stored in
      config and overridable per Run.
    evidence: ["I3 (decide-next-step.rb, auto stop rules)", "operator answers 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D13
    type: decision
    title: "Scheduling and queueing: triggers (time, after another step), where the queue lives so it survives restarts, ordering and limits"
    status: resolved
    depends_on: [D2, D8]
    outcome: >-
      One queue for every Run, kept in a file so it survives restarts, advanced by a
      server timer (like the knowledge chain). A global concurrency cap (default 2) and
      one step at a time per task. Two triggers: start at a time, or start after another
      task's step or chain ends. It only advances while the dashboard server runs (no
      launchd/OS scheduler in V1).
    evidence: ["I3 (no queue or scheduler exists)", "knowledgeChain.ts pattern", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D14
    type: decision
    title: "Parallel tasks: isolation per task (worktree per task or not), creation and cleanup, concurrency limits, collisions on shared repos"
    status: resolved
    depends_on: [D3, D8]
    outcome: >-
      Isolation comes from D3 (a worktree per task per repo) and the D13 cap. The
      dashboard lists its own worktrees that are removable (task done or aborted, branch
      fully merged or pushed, no uncommitted files) and removes one only when the operator
      confirms; it never touches worktrees it did not create.
    evidence: ["D3", "D13", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

  - id: D10
    type: decision
    title: "Fate of today's code and artifacts: keep, replace or remove Start here, the launcher, knowledge re-check rounds and CliRunPanel"
    status: resolved
    depends_on: [D1, D2, D6, D7]
    outcome: >-
      Evolve the good parts, drop the rest. Keep: the detached file-backed launcher
      (restart survival, lost state), localOnly, the server-built prompt, Windows CLI lookup,
      the codex model pin, and the knowledge re-check chain (moved onto the central queue).
      Rewrite: the Start dialog and the contract check (mtime-based check replaced by D6).
      Drop: the Advanced Codex CLI free-prompt panel and the old cliRunner (one launch path
      only), and the current Start-here argv (workspace root, --skip-git-repo-check, Bash
      prefix denies, cursor --trust).
    evidence: ["I2", "operator answer 2026-10-16"]
    resolved_at: 2026-10-16

fog:
  - item: "Remote or multi-user execution from a served dashboard"
    why_not_a_node: "The dashboard is used on localhost by one operator today"
  - item: "Token or cost budgeting per step and per chain"
    why_not_a_node: "No cost data yet; becomes phrasable once D2/D4/D12 fix which agents run unattended and how long"
  - item: "Notifications when a chain stops or a scheduled step finishes"
    why_not_a_node: "Depends on D12/D13 deciding where chains stop and how results are surfaced"

deferred: []
```

## Checkpoints

```yaml
checkpoint:
  written_at: 2026-10-16
  map: "ai-dev-office/docs/start-task-redesign-map.md"
  destination: "Start or open task decision-complete as a V1 spec (confirmed 2026-10-16, V1 expanded: intake, chaining, scheduling, parallel)"
  resolved:
    - "R1: all three CLIs have print mode, streamed JSON and a login probe; cursor-agent has the weakest permission controls"
    - "I1: chat-first (108/110 tasks never used run-agent.sh); Claude main conductor; work on task branches in shared checkouts"
    - "I2: keep launcher/prompt/contract + branch probe/stdin/protocol checks; drop workspace-root cwd, Bash prefix denies, PATH-only availability"
    - "I3: open-task.rb and decide-next-step.rb reusable; no queue exists; cross-task parallel needs isolation"
    - "D1: both Run (unattended, primary) and Open (hand-off to an operator session)"
    - "D2: detached file-backed process, stdin prompt, streamed JSON rendered live, time limit, protocol-event failure"
    - "R2: claude://code/new, claude-cli://open, codex://new set folder + prefill; Cursor deeplink cannot set a folder"
    - "D6: dashboard is the adapter: holds the lease, runs validate/enforce/sync itself; agent writes only the role output"
    - "D3: worktree per task per repo at .worktrees/<repo>-<TASK>; runs/<TASK> added as the only extra writable dir; repos proposed from task.md, confirmed by the operator"
    - "D4: Run offers claude, codex, cursor-agent; selectable only when installed + flags + logged in + model allowed"
    - "D12: chain stops at every human point (gates, authorization, failure, >2 change requests, ~6 steps, merge/push/deploy/approve); reviewer always a different agent (default Claude writes, Codex reviews; swappable)"
    - "D11: request -> open-task.rb claims the id in the main checkout -> pm step writes task.md -> operator confirms before a chain"
    - "D13: file-backed queue + server timer; cap 2 concurrent, 1 step per task; triggers at-time or after-another; only while the dashboard runs"
    - "D9: macOS first; Run disabled with a reason on Windows; Windows is a verified follow-up"
    - "R3: all three have a Seatbelt sandbox (worktree writes, network off) per docs; codex cannot commit in a worktree; Go caches outside the worktree; cursor least verified"
    - "D5: one sandbox envelope for all CLIs (worktree + runs dir, no network, tests allowed, fail if no sandbox); dashboard commits the step diff locally; cursor-agent Run gated on P1"
    - "D7: streamed JSON rendered live in Launch card / Running now / chain timeline; raw logs on disk, 10 per task"
    - "D8: one step per task + dashboard-held lease; one launch path; recent-change warning; Open hand-offs recorded"
    - "D14: dashboard proposes removable worktrees it created (done/aborted, merged or pushed, clean); operator confirms"
    - "D15: Open = Claude desktop, Claude Code terminal, Codex app via deep links on the worktree; Cursor prompt-only"
    - "D10: keep launcher/localOnly/prompt builder/Windows lookup/model pin/knowledge chain; rewrite Start dialog + contract check; drop /api/cli free prompt and old Start-here argv"
    - "P1: all three CLIs held writes + network in a real run; claude/codex refused commits, cursor-agent committed (dashboard must flag agent commits); cursor-agent qualifies for Run"
  findings_to_keep:
    - "TASK-EAR-404 aborted 2026-10-16; its branch deleted; adapter design summarised above for I2"
  frontier: []   # decision-complete; spec in docs/start-task-redesign-spec.md
  blocked: ["D1 waits on I1", "D2..D14 wait on D1/R1/I1/I3"]
  fog: ["remote execution", "cost budgeting", "notifications"]
  next_action: "Hand the spec (docs/start-task-redesign-spec.md) to task planning; implementation not started"
```
