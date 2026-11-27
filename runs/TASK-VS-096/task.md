# TASK-VS-096: Promote VerifySlip replay and quota reporting to Production

Operator approved TASK-VS-094/095 plus 8e1fe73. Promote the reviewed slip-api staging tree, verify the already deployed Portal and confirm a production 8404 same-key retry within 30 seconds has no additional quota_history deduction.

## Production release

- Earth approved TASK-VS-094, TASK-VS-095, and the auto-renew change `8e1fe73` on 2026-11-24.
- API: tested staging `2ee65aa`, reviewed tree `ed1167823a083917ba0641f97542ef4a70025558`, merged to prod as `d1ec5ad` via [#189](https://github.com/SparqLab/slip-api/pull/189). The reviewed merge tree has no migration or workflow changes.
- API [production workflow](https://github.com/SparqLab/slip-api/actions/runs/45341060002) succeeded. ECS revision `:172` reached 3/3 and completed at 13:42:29 ICT. Rollback revision `:171`. Environment, secret references, and other task fields match. Evidence `ev-001` through `ev-003`.
- Portal already carried both tasks on live revision `:108`, image `5345513`. The later independent TASK-VS-093 Portal rollout also contains the same two task commits.
- API traffic check 13:35:56–13:47:14 ICT found 3,651 completed verify HTTP requests, 0 HTTP 5xx and 0 application ERROR lines. All traffic in this check was on the payload endpoint. 52 bank 8404 quota decisions and no verified replay pair. Evidence `ev-005`.
- Screened candidate `7334f353` / `b266300b` was 29.03 seconds apart and returned two HTTP 422 responses. Read-only SQL proved the persisted bank outcomes were 8404 and 6501, with separate ledger deductions. This was not a replay acceptance case.
- Production acceptance remains open pending an authenticated test pair or a matching live request pair with enough evidence to confirm the same key. Earth can use a Production test account and supply the request IDs or times.

## Acceptance decision — 2026-11-24

Earth accepted the verified Staging result for TASK-VS-095 and waived the additional Production replay test to avoid live verification costs. On Staging, the second request returned the stored 8404 after 8.28 seconds and had no new quota_history deduction. Production rollout and traffic checks stand as deployment evidence. The same-key replay was verified on Staging.
