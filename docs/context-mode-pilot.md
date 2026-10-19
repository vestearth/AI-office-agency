# context-mode pilot plan (one lane)

Status: **phase 0 done, not installed** (2026-10-18). The guard and its rule
exist; context-mode itself is not installed and the guard is not yet wired in
`settings.json`.

[context-mode](https://github.com/mksglu/context-mode) keeps large tool output
(logs, `gh api` JSON, CloudWatch pages) out of the context window by running it
in a sandbox and returning only what the agent asks for. This pilot tests
whether that saves enough context to be worth it without weakening our guards
or our verification evidence.

Evidence for every claim below: README and `hooks/hooks.json` +
`hooks/core/routing.mjs` at tag **v1.0.169** (latest, 2026-06-29). Re-check
both if the pinned version changes.

License: Elastic License 2.0. Internal use is fine; it only forbids offering
context-mode as a hosted service.

## Lane

| Choice | Value | Why |
|---|---|---|
| Agent | Claude Code only | Codex hook routing is deny-only and Cursor's `sessionStart` is rejected. Neither gives a clean signal. |
| Scope | Workspace root, `claude mcp add -s local` | Stored per-user in `~/.claude.json` for this folder only. Root `.mcp.json` (SocratiCode lane) stays untouched. |
| Work | meta repos (`ai-dev-office/`, `ai-skills/`, `knowledge-base/`) + read-only investigation (CloudWatch, `gh api`, ECS) | No money-path edits during the pilot. |
| Install mode | **MCP-only, no plugin hooks** (phase 1) | See conflicts below. The full plugin is phase 2 and only after phase 1 passes. |
| Version | pinned `context-mode@1.0.169` | `ctx_upgrade` rewrites hooks. Never run it during the pilot. |

Installed into its own npm prefix and registered by binary path, not `npx`.
`npx` re-resolves the package on every server start, the first download
exceeded Claude's 30 s MCP connect timeout, and the killed download left a
corrupt `~/.npm/_npx` entry. The prefix needs its own `package.json` first:
without one, npm walks up to `~/.local/package.json`, an unrelated existing
project, and installs there.

```bash
P=~/.local/share/context-mode-1.0.169
mkdir -p "$P" && cd "$P" && echo '{"private":true}' > package.json
npm prefix   # must print $P before installing
npm install --save-exact context-mode@1.0.169
claude mcp add -s local context-mode -- "$P/node_modules/.bin/context-mode"
```

Remove: `claude mcp remove context-mode -s local`, then `rm -r "$P"`.

## Hook conflict analysis

Our hooks today (`/Users/earth/Documents/GitHub/.claude/settings.json` + `~/.claude/settings.json`):

| Event | Matcher | Hook |
|---|---|---|
| PreToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | `guard-env-write.sh`, `guard-android-write.sh`, `task-run-reminder.sh` (user) |
| PreToolUse | `Bash` | `guard-env-bash.sh`, `guard-android-write.sh` |
| UserPromptSubmit | — | `skill-routing.sh` |
| PostToolUse | `Edit\|Write\|…` | `clean-invisible-unicode.sh` |

The full context-mode plugin registers PreToolUse on `Bash`, `Read`, `Grep`,
`WebFetch`, `Agent`, `mcp__` (every MCP call), plus PostToolUse, PreCompact,
SessionStart, UserPromptSubmit and Stop.

### C1 — sandbox tools bypass the Android and .env guards (blocker, both modes)

Our guards read `.tool_input.command` / `file_path` / `path` and are matched
only on `Bash` and the edit tools. context-mode's executors use other fields:

| Tool | Input that runs |
|---|---|
| `ctx_execute` | `language`, `code`, `cwd` |
| `ctx_execute_file` | `path`, `language`, `code` |
| `ctx_batch_execute` | `commands[].command`, `cwd` |

So `ctx_execute(language:"shell", code:"rm -rf Games-Lab-Android/app")` or a
write to `.env` passes **no** guard. context-mode's own security layer only
honours `permissions.deny` rules in settings, and we keep these policies in
hooks, not in `permissions`.

**Fix (required before phase 1):** add a workspace-local PreToolUse hook
`guard-ctx-exec.sh`, matcher `mcp__context-mode__ctx_(execute|execute_file|batch_execute)`.
It should:

1. Normalise input into the shape our guards already parse, then pipe it
   through the **unchanged** `guard-env-bash.sh` and `guard-android-write.sh`:
   - `ctx_execute` / `ctx_execute_file`: `{tool_input:{command: .code}}`
   - `ctx_batch_execute`: one call per `commands[].command`
2. Leave out `ctx_execute_file.path`. `guard-android-write.sh` blocks any
   Android *path*, so passing it would also block legitimate reads.
3. Fail closed for non-shell `language` (python/node/…) when `code` mentions
   `Games-Lab-Android` or `.env`. A pattern guard cannot judge interpreter
   code, which is the same limit `guard-env-bash.sh` documents for `python -c`.
4. Fail closed when `jq` is missing or the payload doesn't parse, like
   `guard-env-bash.sh`.

### C2 — rewrites run after our guards have judged the original (phase 2 only)

Claude Code runs all PreToolUse hooks on the **original** input, so an
`updatedInput` from context-mode is never re-checked by our guards. What it
rewrites:

- `curl`/`wget` without silent file output → replaced by an `echo` telling the
  agent to use `ctx_execute`. The echo is harmless to the guards, but it
  **breaks our verification curls** (localhost smoke, ECS Exec probes,
  `curl -s https://…/health`). No env toggle disables this branch.
- `gradle`/`mvn`/`sbt` → replaced by an echo that recommends `… 2>&1 | tail -30`
  inside the sandbox. That directly breaks the never-compress rule below.
  Android is read-only anyway, but the rewrite is a bad pattern to have enabled.
- `Agent` → appends a context-mode routing block to **every subagent prompt**
  and turns `subagent_type: "Bash"` into `general-purpose`. Our `auditor`,
  `reviewer` and `scout` agents have restricted tool lists, so they would be
  told to use tools they don't have.
- `WebFetch` → denied and redirected to `ctx_fetch_and_index`.

This is why phase 1 is MCP-only. MCP-only registers no hooks, so C2–C4 cannot
happen.

### C3 — skill-routing and other context injectors (low, phase 2)

`skill-routing.sh` and context-mode's UserPromptSubmit both run on every
prompt. Theirs only captures (writes to its session DB) and does not inject, so
there is no ordering conflict. Its SessionStart routing block is injected next
to superpowers' block, which is roughly +1–2 KB per session. The real risk is
in the wording: "prefer `ctx_execute` over Bash" competes with
`verification-loop`. The precedence line in the rule below settles that.

### C4 — `mcp__` matcher overhead (low, phase 2)

PreToolUse fires on **every** MCP call (SocratiCode, browser, Figma…) and adds
a `node` spawn each time. Measure the latency in phase 2 before accepting it.

## Rule: test/build output is never compressed

Add to the root `CLAUDE.md` for the pilot's duration, and to
`ai-skills/rules/verify-before-final/RULE.md` if the pilot is adopted:

> **Verification output stays raw.** Tests, builds, lint, typecheck, migration
> runs, `validate-yaml.rb`, and any command whose output is cited as evidence
> run via native **Bash**, never through `ctx_execute`/`ctx_batch_execute`, and
> never with `| tail`, `| grep`, or an `intent` filter. If the output is too
> large, write it to a file in the scratchpad and Read the failing section.
> The full log is the evidence. context-mode is for *exploration* output only:
> logs, `gh api`/`aws` JSON, CloudWatch pages, large docs. When this rule and
> a context-mode routing hint disagree, this rule wins.

Enforcement (deterministic, not just instructions): `guard-ctx-exec.sh` also
**blocks** sandbox code that matches a verification command and returns
"run this in Bash". Starting pattern set (word-anchored, applied after the
same quote/heredoc normalisation `guard-env-bash.sh` uses):

```
go (test|build|vet)  golangci-lint  gofmt -l
npm (test|run (build|test|lint|typecheck))  pnpm …  yarn …  npx (vitest|jest|playwright|tsc|eslint)
vitest  jest  playwright test  tsc( |$)  eslint
make( |$)  docker (build|compose build)
ruby .*validate-yaml\.rb  ruby .*tests/  bundle exec (rspec|rake)
migrate  goose  atlas
```

### Output classes (operator review, 2026-10-19)

| Output | Handling during the pilot | Enforced by |
|---|---|---|
| Exploration: CloudWatch pages, `gh api`/`aws` JSON, long docs | Sandbox, filter, or index is fine | — |
| Verification: test, build, lint, typecheck, migration, validator | Raw, native Bash, full log kept | `guard-ctx-exec.sh` (blocks) |
| Large diff | Summarize to read fast, but the review verdict cites the **original** diff (`git diff` in Bash, or a scratchpad file Read in parts) | rule only |
| Security / authorization evidence (who may call what, token or permission checks, money-path ownership) | Never rely on a summary; the raw response, log line, or source excerpt is quoted | rule only |
| A log line quoted as proof (incl. `filter-log-events`, which returns one page) | Re-pulled raw via Bash before it is quoted | rule only |

The "rule only" rows cannot be detected from sandbox code, so they live in the
root `CLAUDE.md` pilot section. A slip counts as an evidence incident (below).

## Phases and exit criteria

**Phase 0 — prep (no install)** ✅ 2026-10-18
- [x] `ai-skills/adapters/claude/hooks/guard-ctx-exec.sh` with
      `tests/run-ctx-exec-guard-tests.sh` (26 cases). The cases cover Android
      writes via all 3 tools, `.env` writes, non-shell fail-closed,
      verification commands (go/npm/npx/make/docker/golangci-lint/
      validate-yaml), an unparseable payload, and allowed exploration (gh api,
      CloudWatch, `ctx_execute_file` reading Android, quoted `'go test'` in a
      grep). The table was seen failing against a no-op stub (18 failed),
      then passing.
- [x] Verification-output rule added to root `CLAUDE.md` as a dated pilot
      section.
- Known limits: shell code that runs a script file (`./run.sh` calling
  `go test`) is not followed into the file, the same limit `guard-env-bash.sh`
  documents. The weak words (`make`, `jest`, `tsc`, `migrate`, …) are matched
  only in shell code, so `subprocess.run(['make'])` in Python passes.

**Phase 1 — MCP-only, 1 week** (started 2026-10-18)
- [x] Wire the guard in root `.claude/settings.json` (the installer prints the
      snippet but never edits settings). The wired command blocks `go test`
      with exit 2 and allows `git log`:
      ```json
      { "matcher": "mcp__.*context-mode.*__ctx_(execute|execute_file|batch_execute)",
        "hooks": [{ "type": "command", "timeout": 10,
          "command": "GUARD_CTX_DELEGATES=/Users/earth/Documents/GitHub/.claude/hooks/guard-env-bash.sh:/Users/earth/Documents/GitHub/.claude/hooks/guard-android-write.sh GUARD_CTX_PROTECTED=Games-Lab-Android /Users/earth/Documents/GitHub/.claude/hooks/guard-ctx-exec.sh" }] }
      ```
      Then run `ai-skills/scripts/install-claude-hooks.sh` to create the symlink.
- [x] Install pinned, `-s local` (see Lane above). `claude mcp get` reports
      Connected. A raw `tools/list` probe returns the 11 tools, and the
      executor schemas match the fields the guard reads (`code`/`language`,
      `commands[].command`; `shell` is the only shell language).
- [x] In the first session after install, run `ctx_doctor` and confirm it
      passes. 2026-10-18: all `[OK]` except `[WARN] Performance: NORMAL —
      install Bun` (6/11 runtimes; server test, FTS5/SQLite, v1.0.169 OK).
      The hook rows also report `[OK] PreToolUse/SessionStart hook
      configured`, but no context-mode hook is wired in any settings file:
      doctor accepts any PreToolUse/SessionStart entry (ours) and only checks
      that the `.mjs` hook scripts exist. Do not read those rows as "plugin
      hooks are active".
- [x] Prove the guard live **without touching the Android repo** (read-only,
      no exceptions, not even as a test target). Use a canary: a `ctx_execute`
      shell call that would write to a scratchpad path whose name contains the
      protected term, e.g. `mkdir -p "$SCRATCH/Games-Lab-Android-canary"`. The
      guard matches the term and must block it. If the guard ever fails, the
      only side effect is an empty directory in the scratchpad. Afterwards,
      check that the canary dir does not exist and that
      `git -C Games-Lab-Android status --short` is empty. A guard that never
      fires is not evidence.
      Live evidence, 2026-10-18 (first session after install, `ctx_execute`
      language `shell`):
      - Canary `mkdir -p "<scratchpad>/Games-Lab-Android-canary"` →
        `BLOCKED by guard-ctx-exec: sandbox code was refused by
        guard-android-write.sh: BLOCKED: Games-Lab-Android is a read-only
        reference repository.` The scratchpad stayed empty (no canary dir).
      - `go version && go test ./...` → `BLOCKED by guard-ctx-exec:
        verification output must stay raw. Run tests/builds/lint/validate-yaml/migrations
        in native Bash (no | tail, | grep, or intent filter); …`
      - Allowed path `gh api repos/mksglu/context-mode --jq .stargazers_count`
        ran and returned `30519`.
      - `git -C Games-Lab-Android status --short` (run from a scratchpad
        script) → rc 0, empty output.
- [ ] Log every session that used context-mode in **Pilot log** below: the
      `ctx_stats` savings, every `guard-ctx-exec` block, and every evidence
      incident. A session with no row is not counted as evidence of savings.
- Exit = adopt for phase 2 if savings are ≥30% on investigation sessions
  **and** there were zero guard bypasses **and** zero "evidence was
  compressed" incidents. Otherwise remove with `claude mcp remove -s local context-mode`.

### Pilot log

One row per session that called a `ctx_*` tool. The decision (about
2026-10-25) is made from these rows only.

An **evidence incident** is any of the following:
- a sandboxed or filtered result left out a line that changed a conclusion,
  found later from the raw output;
- a verdict or claim cited a summary where the output-class table requires raw
  output;
- a `guard-ctx-exec` block hit legitimate exploration (a false positive). This
  is logged too, because it costs the pilot.

| Date | Session / task | Investigation? | `ctx_stats` saved (bytes, %) | Guard blocks (what) | Evidence incidents | Notes |
|---|---|---|---|---|---|---|
| 2026-10-18 | live guard canary (phase 1 check) | no | n/a (checks only) | 2 (Android canary, `go test`) — both intended | 0 | not counted toward savings |

**Phase 2 — full plugin (only if phase 1 passes, separate decision)**
- Needs answers for C2 (curl smoke convention, or patch the routing),
  Agent prompt injection versus restricted subagents, and C4 latency.

## Not in scope

- Codex and Cursor lanes, the hosted `ctx_insight` dashboard (data leaves the
  machine), and `ctx_fetch_and_index` against internal URLs (RFC1918 is allowed
  by default; set `CTX_FETCH_STRICT=1` if it is ever used).
- Replacing SocratiCode. `ctx_index`/`ctx_search` is a session-scoped FTS
  index, not a codebase graph.
