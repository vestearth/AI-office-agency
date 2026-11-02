# TASK-VS-057: Split KBank 8500 out of upslip-prod-api-target-5xx (our-5xx metric math + per-bank 8500 alarms)

upslip-prod-api-target-5xx pages for bank-side outages: on 2026-10-30/31 evenings every target 5xx was a KBank 8500 (destination bank) 502. Make that alarm count only our 5xx and move 8500 to its own per-bank alarms (TASK-VS-028 item 2 design).

- Type: observability / infra config (CloudWatch only — no service code, no deploy)
- Created: 2026-10-31 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: `implementation_verification` → `production_apply` → `production_acceptance`
  (+ `knowledge_closeout`). No staging chain: the alarms exist only in prod.
- Related: TASK-VS-028 (`runs/TASK-VS-028/alarm-proposal.md` — item 2 per-bank alarm,
  cost-deferred at closeout 2026-10-19), TASK-VS-018 (8500 → free retryable 502),
  TASK-VS-043 (slip-system unavailable-cause log lines).

## Trigger (read-only investigation, 2026-10-31)

`upslip-prod-api-target-5xx` went OK → ALARM at 18:59 ICT, OK at 19:26, ALARM again
at 19:35. Every 5xx was `502 bank verifier unavailable` on `/v1/slips/verify`, and each
hour's ALB target 5xx equals slip-system's KBank `statusCode=8500` line count exactly:

| Hour (ICT) | ALB target 5xx | slip-system 8500 lines | Top sending banks |
|---|---|---|---|
| 10-30 17:00 | 508 | 508 | 014 SCB, 006 KTB, 030 GSB |
| 10-30 18:00 | 637 | 637 | 014, 006, 030 |
| 10-30 19:00 | 534 | 534 | 014, 006, 030 |
| 10-30 20:00 | 2,294 | 2,294 | 014 1,065, 030 451, 006 334 |
| 10-31 17:00 | 387 | 387 | 014, 006, 030 |
| 10-31 18:00 | 2,875 | 2,875 | 014 1,061, 006 911, 030 472, 011 175 |

- Many sending banks at once (014, 006, 030, 011, 025, 034, 002), almost none for 004
  (KBank's own slips) → KBank's interbank path, not ours.
- Our side was healthy: last deploy 05:17 ICT; API CPU ~5 %; RDS normal; p95 ~1 s;
  ELB 5xx 0. The 18:50 scale-out 3 → 5 is the scheduled `slip-api-peak-start` action.
- The single merchant in the 5xx (`84006774…`) is the only verify caller (881/881
  requests, 18:54–18:56 sample), not a merchant-specific fault.
- Counts from paginated `filter-log-events` (all pages) and `get-metric-data` with the
  `vestearth` profile; no AWS writes. Raw extracts not kept (request ids only).

## Why the split

The alarm answers "is our API broken?" but also pages for every bank outage, where the
right action is to tell KBank and merchants, not roll back. After the split:

| Alarm | Counts | Action when it fires |
|---|---|---|
| `upslip-prod-api-target-5xx` (redefined, same name) | target 5xx **minus** 8500 | ours: deploy / rollback / infra |
| `upslip-prod-bank-unavailable-<code>` (new, per bank) | 8500 for that sending bank | bank side: notify KBank / merchants |

**Do not exclude every `bank verifier unavailable` 502.** The same message covers
`oauth`, `circuit_open`, `rquid_mismatch`, `attempt_budget`, `bank_network`, `bank_http`,
`bank_decode`, `invalid_amount`, `concurrent_wait` (`slip-system/internal/models/bank.go`
~199); several of those are ours (attempt budget, Redis wait, KBank credentials). Only
8500 is the bank saying so. slip-api cannot tell 8500 apart in its log today: the gRPC
`BANK_UNAVAILABLE` reason is mapped back to `Unavailable` in
`slip-api/internal/adapters/slipsystemadt/adapter.go:84–110` and not logged.

## Scope (option A — no code change)

All changes go in `SparqLab/upslip-infra` `scripts/setup-prod-alarms.sh` (default branch
`main`, last change dec90b8 2026-09-28; not cloned on the conductor's machine). It is
idempotent `put-metric-alarm`; this adds two metric filters and replaces one alarm.

1. **Total 8500 metric filter** on `/ecs/slip-system-production`:
   - name `upslip-prod-kbank-8500-total`, pattern
     `"kbank destination bank unavailable" "statusCode=8500"`
   - → `Upslip/Bank` `KBankDestinationUnavailableTotal`, value 1, no dimensions.
   - Dry run (filter-log-events, same syntax): 10-31 18:00 ICT = **2,875**, 10-30 20:00 = **2,294**
     — both equal ALB target 5xx.
2. **Per-bank 8500 metric filter** (TASK-VS-028 design, pattern corrected):
   - name `upslip-prod-kbank-8500-by-bank`, pattern
     `[date, time, w1="kbank", w2="destination", w3="bank", w4="unavailable:", code="statusCode=8500", m1, m2, m3, m4, m5, m6, bank="sendingBank=*", ...]`
   - → `Upslip/Bank` `KBankDestinationUnavailable`, value 1, dimension `SendingBank=$bank`
     (value looks like `sendingBank=014`).
   - **The VS-028 pattern no longer matches (0 hits):** since TASK-VS-043 the line ends with
     `request_id="…"`, and the space-delimited parser splits the quoted
     `statusMessage="Internal system error - Destination Bank"` into 6 tokens. The corrected
     pattern matched 2,875/2,875 for 10-31 18:00 ICT.
   - A dimension cannot be summed by an alarm, which is why step 1 is a separate filter.
3. **Per-bank alarms** `upslip-prod-bank-unavailable-<code>` for 006 KTB, 014 SCB, 004 KBANK,
   002 BBL, 025 BAY, 030 GSB, 011 TTB, 034 BAAC — Sum 300 s ≥ 50, 2 of 2, `notBreaching`,
   alarm + OK actions `upslip-prod-alerts` (Lark via `upslip-prod-alarms-to-lark`). Snippet:
   `runs/TASK-VS-028/alarm-proposal.md` (replace its filter pattern with step 2's).
   10-31 18:00 averages: 014 ≈ 88 / 5 min, 006 ≈ 76 → both would fire; 030 ≈ 39 would not.
4. **Redefine `upslip-prod-api-target-5xx`** with `--metrics` (metric math), same name,
   threshold 20, period 60, 3 of 3, `notBreaching`, same actions:
   - `m1` = `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count` (`LoadBalancer=$LB`, `TargetGroup=$TG_API`), Sum, `ReturnData=false`
   - `m2` = `Upslip/Bank` `KBankDestinationUnavailableTotal`, Sum, `ReturnData=false`
   - `e1` = `FILL(m1, 0) - FILL(m2, 0)`, `ReturnData=true` — alarm on `e1`. A negative minute just does not breach.
   - Update `--alarm-description` to say 8500 is excluded and where it is counted instead.

## Deploy order and rollback

1. Save the current definition as evidence:
   `aws cloudwatch describe-alarms --alarm-names upslip-prod-api-target-5xx --output json`.
2. Create both metric filters, then the per-bank alarms, then redefine target-5xx last
   (before the first 8500 after creation `m2` has no data; `FILL` makes that 0, so
   the alarm behaves as it does today).
3. Rollback (no service impact): re-run the original single-metric `put` block for
   `upslip-prod-api-target-5xx` (git revert the script and re-run); `delete-alarms` the
   per-bank alarms; `delete-metric-filter` both filters.

## Constraints and traps

- **Permissions:** `vestearth` is denied `logs:PutMetricFilter`, `DescribeMetricFilters`,
  `TestMetricFilter`, `StartQuery` (Logs Insights) and `cloudwatch:DescribeAlarmHistory`.
  The script needs an admin account (README: viewDev can `PutMetricAlarm`; filters may need more).
- **Cost (operator approval at `production_apply`):** 9 custom metric series (1 total +
  ~8 banks) ≈ US$2.70 / month, 8 alarms US$0.80, target-5xx goes from 1 to 2 metrics (+US$0.10)
  → about **US$4 / month**. This is the cost VS-028 deferred.
- **Subtraction holds only while one 8500 line = one 502** (verified hourly 10-30 and 10-31).
  Before slip-system 23e8fae the proxy retried and it was ~3 : 1 (VS-028). If 8500
  retries come back, `e1` goes negative and hides real 5xx in that minute.
- **Minute-boundary skew:** slip-system logs before slip-api answers, so a request at a minute edge
  can land in neighbouring minutes for `m1` and `m2`. Threshold 20 absorbs ±1.
- **Log-format coupling:** both filters depend on the plain-text line in
  `slip-system/internal/core/services/kbank_normalize.go:31`. Changing it (e.g. VS-028 open choice 3,
  JSON) silently zeroes the filters. Step 2 also depends on the 6-word KBank status message.
- **Metric filters do not backfill:** acceptance needs a staged alarm state and a real 8500 burst.
- Prod is live (VerifySlip is not cost-gated) but this changes monitoring only; no task
  definitions or services are touched.

## Acceptance

- `implementation_verification`: script diff reviewed; both filter patterns dry-run with
  `filter-log-events` (all pages) still match an 8500 hour 1 : 1 with ALB target 5xx; the
  per-bank pattern's bank split sums to the total.
- `production_apply`: operator approved the cost and ran the script with an admin account;
  `describe-alarms --alarm-name-prefix upslip-prod-bank-unavailable-` lists 8, target-5xx
  shows `Metrics` with `m1`/`m2`/`e1`; both filters exist (check with the admin account).
- `production_acceptance`:
  - `set-alarm-state --state-value ALARM` on one per-bank alarm reaches Lark naming the bank, then returns to OK.
  - During the next real 8500 burst the per-bank alarm(s) fire, target-5xx stays OK, and
    `Upslip/Bank` total ≈ ALB target 5xx for that hour.

## Open choices for the operator

1. Thresholds: per-bank 50 / 5 min × 2 — or stricter/looser.
2. Bank list: add 069 KKP, 022 CIMB, 024 UOB, 073 LH? (dimension metric captures every
   bank anyway; only alarms are per listed bank).
3. An aggregate alarm on `KBankDestinationUnavailableTotal` (KBank-wide, many banks at once)?
4. Later, more robust: slip-system logs the 8500 line as JSON (`sendingBank` field), or slip-api logs
   the `BANK_UNAVAILABLE` reason (then the our-5xx count can come from slip-api's own log).
   Either is a code change and would need its own run; update both filters in the same change.
