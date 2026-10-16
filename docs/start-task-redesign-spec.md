# Start or open task — V1 spec

Implementation-ready spec from the decision map
[`start-task-redesign-map.md`](start-task-redesign-map.md) (decision-complete
2026-10-16; every node resolved with evidence). Decisions are the operator's
answers recorded on the map; this file restates them as one buildable design.
Nothing here is implemented yet.

## Destination

The operator's local dashboard (localhost, one operator) can **Run** a task's next
role step unattended, **Open** the same step in a session the operator drives, open
a **new task** from a request, **chain** roles until a human is needed, **queue or
schedule** steps, and run steps of **several tasks at once** — each step isolated,
sandboxed, verified by the office's own scripts, and visible while it runs.
Out of V1: multi-user or remote execution, Windows execution (designed for, not
enabled), cost budgeting, notifications.

## Locked decisions

| # | Decision | Why (evidence on the map) |
|---|---|---|
| D1 | Two actions on a task: **Run** (unattended, the engine for chains, queue and parallel work) and **Open** (hand-off to an operator-driven session). One prompt and one verification for both. | I1: 108/110 recent tasks were chat-driven; V1's chaining/queue/parallel need unattended runs. |
| D2 | A Run is a **detached, file-backed process** (today's launcher, kept): prompt over **stdin**, the CLI's **streamed JSON** rendered by the server as readable live progress, a **per-step time limit**, failure decided from the CLI's **protocol events** as well as the exit code. | I2: the only design that survived a nodemon tree kill; plain-text output showed nothing for 10 minutes. |
| D3 | A step runs in a **git worktree per task per repository** at `.worktrees/<repo>-<TASK>` on branch `task/<TASK>…`; `runs/<TASK>` is the **only other writable directory** (`--add-dir`). Target repositories are **proposed from task.md and confirmed** by the operator before a Run; a multi-repo task gets one worktree per repo. | I1: shared main checkouts (api-gateway sits on task/TASK-EAR-386), `worktree_exclusive: false`. |
| D4 | Run offers **claude, codex and cursor-agent**. A CLI is selectable only when it is installed, its help lists every flag the adapter uses, its **login probe** says logged in, and the **model is allowed** (codex: in the account catalog, `-m` always explicit). The reason shows when not. | R1 probes: `claude auth status` (JSON `loggedIn`), `codex login status` (text), `cursor-agent status --format json` (`isAuthenticated`; never log the rest, it is PII). |
| D5 | **One permission envelope** for every CLI via its macOS sandbox: writes only in the worktree and `runs/<TASK>`, **network off**, local tests/builds allowed (Go caches pointed at writable paths, modules expected present); if the sandbox cannot start, the step **fails**, never runs unsandboxed. **Agents never commit, push, merge or deploy**; the dashboard commits the step's diff locally on the task branch after verification. | R3 docs + P1 live spike: all three held writes and network; claude/codex refused commits; cursor-agent committed (see risks). |
| D6 | The dashboard is the **runtime adapter** (`docs/runtime-adapter-contract.md`): the agent writes only `runs/<TASK>/<role>-output.yaml`; the dashboard holds the task's **ownership lease** for the whole step, then runs `validate-yaml.rb` → `enforce-output-contract.rb` → `sync-status-from-output.rb` itself and records launch id, CLI and model. It writes `status.yaml` only through those scripts. | I2: the mtime contract check counted other sessions' edits; I3: the five adapter scripts and leases exist. |
| D7 | Live progress (assistant text, tool calls, results) in the Launch card, Running now and the chain timeline; raw logs on disk, 10 per task; the end state shows the verification result and the dashboard's commit. | D2. |
| D8 | **One step at a time per task**, the dashboard-held lease fencing run-agent.sh and other leased writers, **one launch path** (no second path like the old `/api/cli`). Interactive sessions take no lease: keep the "status.yaml changed recently" warning, and record Open hand-offs so a later Run warns. | I2: no guard across the two current paths. |
| D9 | **macOS first.** Code stays portable (node wrapper, no shell coupling); on Windows, Run is disabled with a clear reason. Windows is a follow-up verified on a real machine. | R2/R3 mechanisms are macOS-specific. |
| D10 | **Evolve, then drop.** Keep: the detached launcher, `localOnly`, the server-built prompt, Windows CLI lookup, the codex model pin, the knowledge re-check chain (moved onto the central queue). Rewrite: the Start dialog, the verification. Drop: the Advanced Codex CLI free-prompt panel and `cliRunner`, and today's Start-here argv (workspace root, `--skip-git-repo-check`, Bash prefix denies, `cursor-agent --trust` outside a dashboard worktree). | I2 keep/liability lists. |
| D11 | **New task**: the operator types a request and picks the prefix and gate preset → the dashboard claims the id with `scripts/open-task.rb` in the office's **main checkout** (where it runs) → a **pm step** writes task.md (problem, scope, acceptance, target repos) → **stops for the operator to confirm** before any chain. | I3: open-task.rb is an atomic claim; ids are max+1 over the checkout. |
| D12 | **Chains**: the next role comes from `scripts/decide-next-step.rb`; a chain **stops at every human point** — a gate needing a person or an authorization, a blocked task, a failed step, unmet verification, a reviewer asking for changes more than twice, a cap of about 6 steps, and anything that would merge, push, deploy or approve. **The reviewer is always a different agent from the writer**: default Claude writes (pm, dev, dev-2, debugger, devops) and Codex reviews, swappable per chain, in config, overridable per Run. | I3: decide-next-step.rb and auto's stop rules. |
| D13 | **One file-backed queue** for every Run, advanced by a server timer: global cap (default **2**), one step per task, triggers **at a time** or **after another task's step/chain ends**. Advances only while the dashboard runs. | I3: no queue or scheduler exists; knowledgeChain pattern works. |
| D14 | The dashboard lists **worktrees it created** that are removable (task done/aborted, branch merged or pushed, no uncommitted files) and removes one **only on the operator's confirmation**; it never touches worktrees it did not create. | — |
| D15 | **Open** targets: Claude desktop `claude://code/new?q=&folder=`, Claude Code in the terminal `claude-cli://open?cwd=&q=`, Codex app `codex://new?prompt=&path=`, opened with `/usr/bin/open` via `execFile`, on the task's worktree, prompt prefilled not sent (capped at **5,000** characters). Cursor stays "prompt only, open the folder yourself". The hand-off is recorded on the task. | R2: documented, schemes registered on this Mac; Cursor's deeplink cannot set a folder. |

## Per-CLI invocation (verified shape, P1)

Run from the task worktree; the dashboard sets `GOCACHE` (and similar caches) to a
writable path inside the worktree and passes the prompt on stdin.

- **claude**: `claude -p --model <m> --output-format stream-json --verbose --add-dir <runs/TASK> --permission-mode dontAsk --permission-prompts none --setting-sources user --no-session-persistence --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":true,"network":{"allowedDomains":[],"strictAllowlist":true}},"permissions":{"allow":["Edit","Write","Read"],"deny":["Bash(git push *)","WebFetch","WebSearch"]}}'`
- **codex**: `codex exec -m <catalog model> --json -s workspace-write -C <worktree> --add-dir <runs/TASK> -c sandbox_workspace_write.network_access=false -c approval_policy="never" --ephemeral -` (no `--skip-git-repo-check`)
- **cursor-agent**: `cursor-agent -p --output-format stream-json --sandbox enabled --trust --workspace <worktree>` with `<worktree>/.cursor/sandbox.json` = `{"type":"workspace_readwrite","additionalReadwritePaths":["<runs/TASK>"],"networkPolicy":{"default":"deny"}}`, `.cursor/` excluded in the worktree's `info/exclude`. `--trust` only ever on a dashboard-created worktree.

The stream-json flag for claude and the `-` stdin form for codex were not part of
the P1 spike (it used text output and an argument prompt); confirm them in the
first implementation slice.

## Flow of one Run

1. Operator picks role (default from `next_action` / `current_agent`) and CLI (D4
   usability shown) on a task; repos and worktrees confirmed (D3); prompt previewed.
2. Enqueue (D13). When it starts: acquire the lease (D6), create/reuse worktrees,
   write sandbox config, spawn the detached process (D2).
3. Stream progress (D7); enforce the time limit; Stop ends the tree.
4. On exit: protocol/exit result → if ok, validate → enforce → sync (D6); flag an
   agent commit (HEAD moved, P1); commit the worktree diff on the task branch (D5);
   release the lease; record provenance.
5. If part of a chain: `decide-next-step.rb` → next step or stop (D12).

## V1 scope / exclusions

In: Run, Open, new task, chains, queue + time/after triggers, parallel tasks with
worktrees, worktree cleanup proposals, knowledge re-check on the shared queue,
removal of `/api/cli` and the old Start-here argv.
Out (deferred on the map): multi-user/remote, Windows execution, cost budgets,
notifications.

## Open risks

- **cursor-agent can commit inside its sandbox** (P1). Mitigation: detect HEAD moves
  after a step and fail/flag it; the prompt says not to commit.
- **Claude hooks and MCP run outside the sandbox** (R3): repo hooks from a worktree's
  settings still run in `-p`. `--setting-sources user` narrows settings; whether it
  stops worktree hooks is undocumented — check in the first slice.
- **Go module downloads are blocked** with network off: a step needing new modules
  fails; the operator pre-fetches, or a later decision allows a module proxy.
- **Interactive sessions take no lease**: a Run can still collide with a chat-driven
  session on the same task; only the recent-change warning and recorded Opens guard it.
- **Deep links were not opened during research** (R2): verify each once by hand.
- **The queue only advances while the dashboard runs** (D13).

## Suggested implementation slices (for task planning)

1. Adapter core: CLI probes (D4), per-CLI argv + sandbox config (D5), stdin prompt,
   stream parsers + protocol failure (D2/D7), time limit — behind the existing
   launcher; spike-confirm stream-json/stdin flags and hook behaviour.
2. Worktrees (D3/D14): create/reuse, repo proposal from task.md, cleanup proposals.
3. Adapter governance (D6/D8): lease, validate/enforce/sync, provenance, dashboard
   commit, agent-commit detection; remove `/api/cli` and the Codex free-prompt panel.
4. Start dialog rewrite: Run and Open (D15), role/CLI/repos/prompt review.
5. Queue (D13): file-backed queue, cap, triggers; move knowledge re-check onto it.
6. Chains (D12): decide-next-step loop with stop rules and writer/reviewer pairing.
7. New task (D11): request → open-task.rb → pm step → confirm.

ai-dev-office is a meta repository, so these slices need no TASK run under the
workspace policy; the operator may still open one for tracking.
