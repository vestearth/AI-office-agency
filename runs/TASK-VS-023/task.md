# TASK-VS-023: Keep KBANK summary visible when transfer list times out

Production 2026-10-14 14:11 Bangkok: bank-flow summary returned 200 while transfers returned 500 after 15s; slip-admin hides the entire summary because both requests share one error state. Scope slip-admin KbankFlowSummary.vue and existing translations only. Keep the summary and CSV available; show a list-specific error and retry. Verify typecheck/build and the failed-transfer UI state.

## Handoff

- Implementation PR [#13](https://github.com/SparqLab/slip-admin/pull/13) merged into `main` as `510dabd`.
- Promotion PR [#14](https://github.com/SparqLab/slip-admin/pull/14) merged `main` into `staging` as `fd721b8`. [Deploy STAGING run 38532919207](https://github.com/SparqLab/slip-admin/actions/runs/38532919207) passed; ECS `slip-admin-staging:66` is stable at desired/running 1/1 with image `staging-sha-fd721b8` (ev-005 to ev-007).
- Local mock UI: summary 200, transfers 500; summary count and CSV remained visible, and the list showed its own error and Refresh control.
- Typecheck `ev-001`/`ev-003` and build `ev-002`/`ev-004` passed. Authenticated staging KBANK 7-day view showed summary 99, enabled Export CSV, and loaded Transfers after deploy; `staging_acceptance` passed. A live staging transfer 500 did not occur during this check.
- Production PR [#15](https://github.com/SparqLab/slip-admin/pull/15) was prepared with only the three TASK-VS-023 files; production-branch typecheck `ev-008` and build `ev-009` passed. Before it was merged, another actor merged all of `staging` into `prod` as `4cf34ef`, including this exact patch and a separate Overview layout change. PR #15 was closed as redundant.
- [Deploy PRODUCTION run 38536484692](https://github.com/SparqLab/slip-admin/actions/runs/38536484692) passed. ECS `slip-admin-production:56` is stable at desired/running 1/1 with image `production-sha-4cf34ef` (ev-010 to ev-013). Authenticated production KBANK 7-day view showed summary 1,699,680, enabled Export CSV, and loaded Transfers. A live transfer 500 did not occur during this check.
- The production API transfer query timed out at 14:11 Bangkok before this rollout. This frontend change keeps the summary visible when that happens; it does not change the API query. Backend remediation remains TASK-VS-024.
