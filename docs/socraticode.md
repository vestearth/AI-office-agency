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
| Local Docker | `SOCRATICODE_FALLBACK_PROJECT` | `npx -y socraticode` or local MCP |

`SOCRATICODE_BACKEND=local` skips remote entirely.

Wrapper routing (remote first, local fallback):

- `context`, `codebase_status`
- `codebase_search`, `codebase_symbol`
- `codebase_graph_*`

Additional env: `SOCRATICODE_LOCAL_PROJECT`, `SOCRATICODE_GRAPH_ROOT`.

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
