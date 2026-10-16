# TASK-VS-033: TestAdminDailyCountsUsesBangkokDates fails on a reused repository test DB

Describe the scope and acceptance criteria here before work starts.

## Context (2026-10-16, found during TASK-VS-032)

`internal/repositories/verification_usage_test.go` `TestAdminDailyCountsUsesBangkokDates`
commits 5 verifications at fixed 2037-09-29/30 timestamps via `repo.Save`, then asserts the
global (not tenant-scoped) `AdminDailyCounts` returns exactly Total 3 / Verified 1 /
Rejected 1 / Other 1. Rows are never cleaned up, so every earlier run on the same DB adds
3 to the window: observed `Total:27 Verified:9 Rejected:9 Other:9` after 9 runs. Passes on
a fresh DB only; fails the same on main (e3c1b62) and dc72d23.

Done = passes 20x on a DB that already ran the full repository suite, the assertion still
catches a UTC-instead-of-Bangkok day boundary (seen failing), full suite green. Do not
weaken the exact-count assertion (test-integrity); isolate the rows instead (e.g. tx
rollback, cleanup, or a window no other run uses).
