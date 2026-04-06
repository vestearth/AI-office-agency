# TASK-015: Fix Case-Sensitive Path Mismatch — Github vs GitHub

## Type
bugfix

## Priority
high

## Description
macOS APFS stores the workspace root as `Documents/Github` (lowercase "h") but
Cursor's workspace config, IDE state, and at least one source file reference
`Documents/GitHub` (uppercase "H"). On APFS the names resolve to the same
inode at runtime, but Cursor's strict path validation rejects the mismatch,
producing "invalid workspace folder path (expected 1, got 0)" and preventing
the IDE from loading the workspace.

Additionally, `Games-Labs-Missions/migrations/run.go` contains a hardcoded
absolute debug-log path that embeds the incorrect casing and should be removed
entirely from source control.

## Scope
- Local filesystem: rename `Documents/Github` → `Documents/GitHub` (one-time
  shell command, not a repo change — Dev guides the user through this step).
- `Games-Labs-Missions/migrations/run.go` — remove/replace the hardcoded
  absolute path on line 21.

## Current State
- `ls /Users/earth/Documents/` returns `Github`.
- Every IDE config, `AGENTS.md`, CI workflow, and `run-agent.sh` references
  `/Users/earth/Documents/GitHub`.
- `Games-Labs-Missions/migrations/run.go:21` contains:
  ```go
  const debugLogPath = "/Users/earth/Documents/GitHub/Games-Labs-Missions/.cursor/debug-12731a.log"
  ```
  This constant should not exist in production source; it is leftover debug
  scaffolding.

## Acceptance Criteria
- `/Users/earth/Documents/GitHub` is the canonical path that `ls` resolves
  (uppercase H) — confirmed by running `ls /Users/earth/Documents/`.
- Cursor opens the workspace without "invalid workspace folder path" errors.
- `Games-Labs-Missions/migrations/run.go` no longer contains any hardcoded
  absolute path or `debugLogPath` constant.
- `go build ./...` passes in `Games-Labs-Missions`.
- No other Go source file in the repo contains a hardcoded `/Users/earth/`
  absolute path.

## Next Action
Run `dev` to fix `migrations/run.go` and produce the rename shell command for
the user to execute. Hand off to `reviewer` for build verification.
