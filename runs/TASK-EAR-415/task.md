# TASK-EAR-415: Dashboard New task smoke test (slice 7)

## Problem

Slice 7 of the start-task redesign adds the dashboard's New task flow: the
operator opens a task from the dashboard, the pm step plans it, and the
operator confirms before any further step. The flow needs one throwaway run from
start to finish to show that it works. The repository change is only a marker
for that run. The task is aborted after the test (operator-approved 2026-10-17).

## Scope

In:
- One line `slice 7 new-task smoke` in `smoke/dashboard-run-smoke.txt` in the
  ai-dev-office task worktree. The file is not on `main`: `ai-dev-office/smoke/`
  does not exist there and no branch history has it, because the earlier smoke
  tasks (TASK-EAR-410, TASK-EAR-412) were aborted and their worktrees removed.
  "Append" therefore creates the file with this one line. If the file is in the
  worktree already, the line is added at its end and the existing lines stay as
  they are.

Out:
- Any other file in ai-dev-office or any other repository.
- Commit, push, PR, merge, or deploy. The dashboard verifies the change and the
  task is aborted afterwards.
- Completion gates. The task was opened with none, because it is a throwaway.

## Acceptance criteria

- `smoke/dashboard-run-smoke.txt` in the ai-dev-office task worktree has a line
  that is exactly `slice 7 new-task smoke`
  (`grep -qx 'slice 7 new-task smoke' smoke/dashboard-run-smoke.txt` exits 0).
- If the file existed before, all its earlier lines are unchanged and the new
  line comes last.
- `git status --short` in the worktree shows only `smoke/dashboard-run-smoke.txt`
  (or `?? smoke/`) as changed.

## Target repositories

Repo: ai-dev-office

## Plan

1. dev: in the ai-dev-office task worktree, append `slice 7 new-task smoke` to
   `smoke/dashboard-run-smoke.txt`, creating `smoke/` and the file if they do not
   exist. Change nothing else. Leave the change uncommitted.
2. dev: run `cat smoke/dashboard-run-smoke.txt` and `git status --short`, and
   record them as claims in dev-output.yaml. Hand off to reviewer.
3. reviewer: check the one line and that nothing else changed. Then the operator
   aborts the task.

## Risks and open questions

- The file is not on `main`, so the dev step creates it instead of appending to
  it. This is what TASK-EAR-412 did. If the operator expected an existing file,
  nothing is lost: the acceptance check is the same either way.
- The worktree must not be the shared `main` checkout. The dev step writes only
  in its task worktree, and the abort removes the worktree and branch.
- No questions for the operator.
