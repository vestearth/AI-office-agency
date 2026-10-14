# TASK-VS-024: Bank-flow transfers total from cached summary + boot warm-up of admin day caches

## Symptom (prod 2026-10-14, after TASK-VS-022)
slip-admin KBank flow with the 7 days / This month presets showed its skeleton for 15s, then "request failed".
- `/bank-flows` summary: 200 in ~1.1s (VS-022 cache).
- `/bank-flows/transfers`: 500 at 15001ms (07:44:24 `count bank flow transfers: timeout`,
  07:50:38 `list bank flow transfers: timeout`). It ran COUNT(*) over the whole range plus the page query
  on one shared 15s deadline. `KbankFlowSummary.vue` `load()` awaits both requests.
- The VS-022 cold fill on the request path failed once (07:43:16, task 86b06f50): the day 2026-10-10 query
  took >15s with 4 fills running in parallel, and the response took 29.5s, past the 20s WriteTimeout.

## Fix (SparqLab/slip-api#64)
- Transfers without a search take the total from the cached per-day summary, so only the page query runs.
- The page query (`BankFlowTransferItems`) gets its own deadline.
- `WarmAdminDayCaches` runs at boot: Overview month counts and the all-merchant KBank flow for this month
  or the last 7 days.
- Fill parallelism goes 4 -> 2.
- SQL and contract are unchanged.

## Related
TASK-VS-023 (another session): slip-admin#13 keeps the summary visible when transfers fails. It complements
this fix; there is no dependency either way.

## Evidence notes
- ev-001: suite + race + real-Postgres repo tests, green.
- ev-002: on origin/main the new tests fail to compile (new API: BankFlowTransferItems / WarmAdminDayCaches).
  The behavioural "before" is the prod log above (VS-022 ev-004 plus the 07:50Z transfers 500).

## Acceptance (prod)
- After deploy, each task logs `admin day caches warmed` with a duration.
- KBank flow 7 days and This month return summary and transfers 200 in a few seconds, with no
  `count/list bank flow transfers: timeout` for unsearched day-aligned ranges.
