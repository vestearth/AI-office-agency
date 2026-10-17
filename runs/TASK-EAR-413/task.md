# TASK-EAR-413: Dashboard chain smoke test 413 (slice 6)

Throwaway smoke test of dashboard role chains (start-task redesign slice 6): claude writes, codex reviews, decide-next-step.rb picks the next role, the chain stops at done or by the operator; after-chain trigger. Repo: ai-dev-office. Scope: the dev step adds one line to smoke/dashboard-run-smoke.txt in the task worktree and writes a valid dev-output.yaml with next_action.agent reviewer; the reviewer reviews that one line. Operator-approved 2026-10-17; aborted after the test, worktree and branch removed.
