# office-intake Skill Guide

## Purpose

Turn rough user requests into a PM-ready task preview before files are created.

## Inputs

- User request
- Optional affected service, error log, or desired task id
- Existing `runs/` task ids for next-id selection

## Output

- Proposed task id and short name
- Task type and priority guess
- Known scope and unknowns
- One concise clarification question when required
- Recommended next command, usually `./ai-dev-office/run-agent.sh TASK-NNN pm`

## Parallel Intake Guidance

- Recommend parallel PM planning only when work is clearly split by service, layer, or non-overlapping files.
- If shared files are likely involved (`go.mod`, `go.sum`, `.proto`, generated proto files, or `shared-lib/**`), recommend sequential planning unless one agent can own that shared-file work first.
- If the request is ambiguous, keep the recommendation sequential and ask for the missing scope.

## Command

```bash
./ai-dev-office/run-agent.sh intake "Fix wallet callback failure"
```

Intake never creates `runs/<TASK-ID>`. In single-user mode it is non-mutating — it only previews the task metadata.

**Multi-user mode caveats** (see [../multi-user-git.md](../multi-user-git.md)):
- With `git_sync.enabled`, intake first `git pull --rebase`es the office repo to see the latest team state (soft-fail; it does touch repo state).
- Once `office.team.yaml` has any entry under `prefixes:`, intake requires a registered prefix (env `OFFICE_TASK_PREFIX` or `office.task_prefix` in `office.config.local.yaml`) and exits non-zero with guidance otherwise — so the preview is produced only for registered users.
