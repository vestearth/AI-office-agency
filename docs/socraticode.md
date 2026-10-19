# SocratiCode Context Provider

`run-agent.sh` can inject a SocratiCode context section into role prompts for code-impacting work.
SocratiCode is the codebase intelligence layer: evidence discovery, navigation,
symbol/context search, flow mapping, graph inspection, and impact analysis.
**Repository evidence remains authoritative** — SocratiCode is navigation only.

SocratiCode discovers where evidence likely lives. It does not decide what is true.
SocratiCode-assisted does not mean SocratiCode-authoritative: use it first to
discover, but verify every conclusion and code change against source evidence
(repo files, tests, CI, runtime logs, config, current contracts, runtime behavior).
Use SocratiCode early. Trust evidence finally.

## Codebase truth

- Repository files, tests, CI evidence, runtime logs, real config/env, current API/product contracts, and actual runtime behavior win over index summaries
- Treat search/symbol/graph output as navigation aids, not final proof
- Agents must read actual files before implementation or review claims

## Configuration layers

1. `SOCRATICODE_PRIMARY_PROJECT` / `SOCRATICODE_FALLBACK_PROJECT` env vars
2. `office.config.yaml` → `context_provider.project_paths`
3. Profile overlay (`profiles/*.yaml`) and `profiles/*.local.yaml`
4. `office.config.local.yaml`

Set paths in local config — never hardcode machine paths in committed framework docs.

## Default runner behavior

When `context_provider.enabled` is true (see profile/config):

- Adds `--- AI CONTEXT INDEX ---` to the prompt when lookup succeeds
- Logs `context_provider` event in `meta.yaml`
- Falls back to repo inspection (`rg`, files on disk, tests) without failing the run when optional
- Skips injection for non-code tasks
- Applies to `pm`, `dev`, `dev-2`, `reviewer`, `debugger`, `free-roam` (not `devops` by default)

Agent outputs may include concise `context_sources`; do not paste large search dumps into YAML handoffs.

## Discovery flow

1. Run `codebase_status` with primary project path; retry with fallback if unusable
2. Use `codebase_search`, `codebase_symbol`, `codebase_symbols`, graph tools as needed
3. Read repository files before claims
4. Verify against source, tests, and command output

If both paths fail or SocratiCode is unavailable, say so explicitly and fall back to direct inspection.

## Tool routing

| Tool | Use when |
|------|----------|
| `codebase_status` | Start investigation, verify index readiness |
| `codebase_search` | Locate implementation, endpoints, configs, protos |
| `codebase_symbol` / `codebase_symbols` | Inspect or list specific symbols |
| `codebase_graph_*` | Dependencies, impact, cycles (when exposed) |

**Cursor:** MCP server `user-socraticode` when available (see target project Cursor rules).

**Codex:** SocratiCode MCP when exposed; else CLI wrapper.

Graph tools may exist in backend/CLI but not in session MCP — use `scripts/socraticode-tcp-wrapper.sh` and record fallback in `context_sources.socraticode`.

## Backends

| Backend | Config | Access |
|---------|--------|--------|
| Remote | `SOCRATICODE_PRIMARY_PROJECT`, `SOCRATICODE_REMOTE_*` | MCP or `socraticode-tcp-wrapper.sh` |
| Local Docker | `SOCRATICODE_LOCAL_PROJECT` / `SOCRATICODE_FALLBACK_PROJECT` | `socraticode-remote.sh` → local MCP proxy, or `npx -y socraticode` |

`SOCRATICODE_BACKEND=local` skips remote entirely.

### Portable path defaults

Committed scripts **must not** hardcode a machine home path. Local root resolves as:

1. `SOCRATICODE_LOCAL_PROJECT`
2. `SOCRATICODE_FALLBACK_PROJECT`
3. `SOCRATICODE_ROOT` / `SOCRATICODE_GRAPH_ROOT` (where applicable)
4. Parent directory of `ai-dev-office/` (derived from the script location)

Remote canonical path defaults to `D:\llm` (`SOCRATICODE_REMOTE_CANONICAL_PROJECT` / `SOCRATICODE_PRIMARY_PROJECT`). The local MCP proxy remaps that value onto the resolved local root so agents can keep sending the primary `projectPath` when remote is down.

Host MCP entrypoint: symlink or copy `scripts/socraticode-remote.sh` to the editor MCP command path (e.g. `~/.local/bin/socraticode-remote`). Optional watch daemon: `scripts/socraticode-local-watch.mjs`.

Wrapper routing (remote first, local fallback):

- `context`, `codebase_status`
- `codebase_search`, `codebase_symbol`
- `codebase_graph_*`

Additional env: `SOCRATICODE_LOCAL_PROJECT`, `SOCRATICODE_GRAPH_ROOT`.

### Index freshness (checked 2026-10-19, server v1.16.1)

The local index is **one project for the whole workspace root**: collection
`codebase_llm`, an explicit project id, about 8.3k files. That root is not a
Git repository. This decides which upstream freshness options apply:

| Option | Applies here? | Why |
|---|---|---|
| `SOCRATICODE_WATCHER=auto` (native file watcher) | **No**, deliberately off | Per-file debounce fans a bulk change into one embedding run per file. It pinned Docker Ollama at ~1000% CPU (2026-08-14) and starved the interactive server (2026-07-30). The proxy sets `manual`. |
| `SOCRATICODE_WATCHER=git` | **No** | `readGitState` throws "Git refresh unavailable: this project is not a Git working tree" for the root, so it would never refresh. |
| `SOCRATICODE_BRANCH_AWARE=true` | **No** | Ignored when a project id is set. At the root there is also no branch to detect. |
| `scripts/socraticode-local-watch.mjs` (LaunchAgent `co.sparqlab.socraticode-local-watch`) | **Yes**, this is the freshness mechanism | Polls `codebase_update` every 300 s (`SOCRATICODE_UPDATE_INTERVAL_MS`), one run at a time. The index is at most one interval behind. |

Before relying on a result:

1. Edits from the last ~5 minutes may be missing. `codebase_status` /
   `codebase_list_projects` show "Last indexed". Read the file for anything
   just changed.
2. Worktrees outside the root (for example under a session scratchpad) are not
   indexed. Search hits always describe the root checkout's branch, not the
   worktree's.
3. The remote leg (`d:\llm`) is a different, stale checkout. Revalidate every
   remote hit against the local file.
4. Rule 1 still holds: the file is the truth; a search hit is a pointer.

## Response shape (examples)

Use env placeholders in queries — not fixed checkout paths.

`codebase_status`:

```json
{
  "type": "success",
  "method": "codebase_status",
  "message": "Codebase is indexed and ready",
  "status": "active"
}
```

`codebase_search`:

```json
{
  "type": "success",
  "method": "codebase_search",
  "query": "ValidateToken",
  "projectPath": "${SOCRATICODE_PRIMARY_PROJECT}",
  "count": 1,
  "results": [{ "file": "internal/auth/service.go", "line": 39, "snippet": "func ValidateToken(" }]
}
```

Invalid project path should fail clearly:

```json
{
  "type": "error",
  "method": "codebase_graph_stats",
  "error": "Invalid projectPath: /does/not/exist"
}
```

## Smoke checks

```bash
ai-dev-office/tests/smoke/socraticode-graph.sh
ai-dev-office/tests/integration/context-provider.sh
```

## Related docs

- [config-profile-merge-contract.md](config-profile-merge-contract.md)
- [codex.md](codex.md) / [cursor.md](cursor.md)
