# TASK-VS-026 Verification Evidence — aws-tracking error census

Captured 2026-10-15 by a Claude conductor session at the operator's request, from the
aws-tracking reliability page ("Error ที่เจอบ่อยใน log") cross-checked against CloudWatch.
Recorded as **ev-012** in `evidence.yaml` (local only, not synced): exit 0,
executed_at 2026-10-15T04:20:14Z, artifact `evidence/ev-012.log`
sha256 `e15a526e23eb4d131ebba32ac995ba317f2b3a2a12be6c75d2a1d0d97f04660b`.

Command (read-only AWS reads with profile vestearth; the script also stays local under runs/):

```bash
python3 ai-dev-office/runs/TASK-VS-026/aws_tracking_error_census.py
```

Output (ev-012.log, verbatim):

````text
# aws-tracking error census (read-only)
generated_at: 2026-10-15T04:20:14+00:00
source: CloudWatch Logs + ECS (profile vestearth); aws-tracking UI groups the same ERROR lines

## Prod build
- task definition: slip-api-production:87  image sha: f2005fa  rollout: COMPLETED (created 2026-10-14T17:03:47.489000+07:00)
- image contains TASK-VS-025 merge 1208435 (and VS-022 #63, VS-024 #64): True

## Prod slip-api ERRORs since 2026-10-14T10:04:00+00:00 (VS-025 deploy)
- log lines: 29 over 10 page(s); unique failed requests/events: 18

| failures | last (ICT) | duration ms | signature |
|---|---|---|---|
| 6 | 10-15 10:43 | 15788-17631 | GET /v1/admin/verifications/bank-flows/transfers -> 500 list bank flow transfers: timeout: context deadline exceeded |
| 5 | 10-15 00:44 | 458-2520 | POST /v1/slips/verify -> 502 bank verifier unavailable |
| 3 | 10-15 10:43 | 10001-10003 | GET /v1/admin/verifications -> 500 count verifications: count verifications: timeout: context deadline exceeded |
| 2 | 10-14 20:43 | - | persist duplicate slip attempt failed: generate verification id: context canceled |
| 2 | 10-15 08:50 | 10001-10002 | GET /v1/admin/verifications/daily -> 500 admin daily verifications: admin daily verifications: timeout: context deadline exceeded |

Classification given to the operator (2026-10-15):
- bank-flows/transfers 500 at ~15-17s: still failing after VS-024 (its fix covers unsearched day-aligned ranges only).
- GET /v1/admin/verifications COUNT 500 at 10s: not touched by VS-021..025.
- GET /v1/admin/verifications/daily 500 at 10s: not touched by VS-021..025.
- POST /v1/slips/verify 502 bank verifier unavailable: upstream blip, handled as designed by VS-018 (free, retryable).
- persist duplicate slip attempt failed / context canceled: low impact, audit row lost on client cancel.
- Pre-deploy summary and bank-flows summary timeouts do not recur after the deploy.
- Admin report pages only; no customer verification path besides the upstream 502.

## Staging slip-api: Postgres connection slots exhausted (SQLSTATE 53300) on 2026-10-14
- 1093 log lines over 24 page(s), 15:07-16:41 ICT, DB upslip-postgres-dev
  sample: FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute
- slip-api-staging deployments completed that day (service events, ICT):
  - 16:43 (service slip-api-staging) (deployment ecs-svc/5379728252648074382) deployment completed.
  - 15:13 (service slip-api-staging) (deployment ecs-svc/3170562049709917443) deployment completed.
  - 14:19 (service slip-api-staging) (deployment ecs-svc/0265104031816573883) deployment completed.
  - 12:26 (service slip-api-staging) (deployment ecs-svc/9766034838386258932) deployment completed.
  - 11:40 (service slip-api-staging) (deployment ecs-svc/2060579384023822416) deployment completed.
  (VS-024 #64 merged 15:03 ICT; VS-025 #65 merged 16:31 ICT; the exhaustion window opens with the deploy completed at 15:13 (first build after #64) and closes with the one completed at 16:43 (after #65). Correlation only: rds:DescribeDBInstances is denied for vestearth.)
- staging ERROR lines in the last 6h: 0
- Suggested follow-up: at VS-025 prod acceptance, check that the boot warm-up does not exhaust DB connections.
````
