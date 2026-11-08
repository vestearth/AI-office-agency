# TASK-VS-063: 8404 not-found quota rule: 1 slip, 1 quota

Opened 2026-11-08 by the Claude conductor from Earth's chat decisions. Implementation goes to
another lane; the conductor does not implement this run.

## Why

- **8404 never reaches the not_found rule.** KBank answers "transaction reference does not exist"
  with `statusCode=8404`. Both classifiers know only `404`/`4040`:
  - slip-system `internal/core/services/kbank_normalize.go` ~:67 stores 8404 as `rejected`;
  - slip-api `internal/models/verification.go` `bankVerificationStatus` ~:1019 maps it to HTTP 422.
  - So every 8404 is charged 1 quota (`SaveWithQuota`) and binds the `Idempotency-Key`. The
    not_found rule from `c913d3d` (2026-09-28: free, key not bound, `NOT_FOUND_COOLDOWN` 30 s)
    has not applied to real traffic since then.
- **KBank does not bill 8404** (KBank, 2026-11-04; recorded in TASK-VS-059). Changing the quota
  rule does not change the monthly KBank reconciliation: 8404 is in neither KBank's count nor our
  `verified` count.
- **Evidence, 2026-11-05 ICT (one day, counts only):**
  - SCB-sender (`014`): 82,640 verified, 12,267 rows with 8404. The 8404 share is 11.3–15.6 %
    in every hour, including 03:00, so it is not an intermittent bank fault.
  - **Proven-real slips** (8404 first, `verified` later on the same branch, channel and ref):
    1,757. All 1,757 got their 8404 at a slip age under 30 s (verified `trans_datetime` minus
    the 8404 `created_at`). None got 8404 at 30 s or later. Age when they later passed:

    | < 30 s | 30–60 s | 60–90 s | 90–120 s | 2–3 min | 3–5 min | 5 min + |
    |---:|---:|---:|---:|---:|---:|---:|
    | 63 | 128 | 982 | 372 | 124 | 54 | 34 |

  - **Never verified:** about 10,510 slips. How many are real slips checked too early (versus
    fake slips) is unknown. Comparing verified slip ages by sending bank (004 / 006 / 014 in the
    same branches: 84.9 % / 83.9 % / 77.9 % under 30 s) cannot settle it.
  - slip-api `slip_verify` log: 13,577 HTTP 422 from one branch, none faster than 30 ms. So no
    idempotency replays happened, and the merchant does not resend after a 422. The VS-059
    baseline also shows that about 99.9 % of verifies carry no `Idempotency-Key`.
  - 409 duplicates: 8,777. 30 took 100 ms or more (post-bank race: KBank billed, no quota). This is
    out of scope (decision 7).
- **Public promises** (slip-landing `app/components/manual/Results.vue`, `Roles.vue`,
  `package/MoneyFaq.vue`, `package/Compare.vue`): duplicates and unreadable slips are not charged.
  Nothing is published about not-found charging.

## Decisions (Earth, chat, 2026-11-08)

The slip key is branch + channel + `lower(sending_bank)` + `lower(trans_ref)`, the same key as
`verifications_branch_slip_verified_uidx`.

| # | Case | Ask KBank | Quota |
|---|---|---|---:|
| 1 | First 8404 for a slip | yes | 1 |
| 2 | Same slip within 24 h of the charged 8404, at least 30 s after the previous 8404, still 8404 | yes | 0 |
| 3 | Same slip within 24 h of the charged 8404, passes (`verified`, including receiver mismatch) | yes | 0 |
| 4 | Same slip resent within 30 s of the previous 8404, still 8404 | **yes, fresh call; never the stored answer** | +1 |
| 5 | Same slip resent within 30 s of the previous 8404, passes | yes | 0 |
| 6 | 8404 more than 24 h after the charged 8404 | yes | 1 (opens a new 24 h window) |

7. **All sending banks** follow the rule, not only SCB.
8. **No response change:** the merchant still gets HTTP 422 with `statusCode` 8404.
9. **Duplicates stay free in every case,** post-bank race duplicates included, as the site promises.
10. **Rule C never charges more than today's rule** in any case, so it needs no prior merchant
    consent. Rollout: deploy first, then notify the merchant (gate `merchant_notice`). The notice
    states the rule and advises waiting at least 60 s before resending an 8404, once.
11. **Refund of past 8404 charges is deferred** (gate `refund_decision`). The count query is
    below.
12. Other `rejected` codes stay charged at 1. `404`/`4040` not_found keeps its current
    behaviour.

## Scope

- **slip-api** (owner of quota):
  - Apply decisions 1–6 to bank verify results with `statusCode` 8404.
  - ~~8404 must not bind the `Idempotency-Key`~~ **Changed in review (2026-11-08):** an 8404 keeps
    its key for the 30 s repeat window. A same-key retry inside it replays the stored 8404 with no
    bank call and no charge, and after that the key is released so the retry reaches the bank.
    Not binding at all made a same-key retry under 30 s cost +1, more than the old rule, which
    contradicts decision 10. A same-key retry is the same request (often a transport failure), and
    Earth's condition was to charge only resends the merchant caused.
  - Decision 4 needs a fresh KBank call. `recentNotFound` / `NOT_FOUND_COOLDOWN` must not answer
    8404 from a stored row. Today it only matches `status = 'not_found'`, so check this if 8404
    rows become not_found.
  - Finding the charged 8404 and the previous 8404 for a slip needs an index-backed lookup. If a
    new index is needed, it is a migration (rule `schema-change-needs-migration`):
    - `verifications` is large, and goose runs before the listener. A 2m58s index build caused
      12 verify 504s on 2026-10-28.
    - So pre-build the index by hand, 01:00–05:00 Bangkok only, before the deploy. The migration
      stays `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
  - Concurrent first requests for the same slip are within 30 s of each other, so decision 4
    already covers them. Whichever row commits first is the charged 8404.
  - README: make lines ~255–256 (not_found) and ~281 ("a bank response consumes 1 quota,
    including … not-found") match the new rule.
- **slip-system:** decide in the design whether 8404 stays `rejected` in `kbank_normalize.go`, or
  becomes `not_found` and the quota rule lives in slip-api. Either way:
  - the merchant response must not change (decision 8);
  - admin status counts must stay explainable: rejected versus not_found totals, and the monthly
    reconciliation queries that filter 8404.
- **slip-landing:** on the "ธนาคารไม่พบรายการ" result, state that the first not-found costs 1 quota
  and that resending the same slip within 24 h is not charged again (except within 30 s). Advise
  waiting about 1 minute before resending a slip from a transfer that was just made.
- **Promotion:** main → staging → prod, each through a PR (`verifyslip-promote`). Gates are in
  status.yaml.
- **Out of scope:**
  - charging post-bank duplicates (decision 9);
  - the KBank count gap from timeouts and proxy retries (accepted as cost in VS-059 / VS-061);
  - executing any refund.

## Implementation (2026-11-08)

- **slip-api PR:** SparqLab/slip-api#125, branch `task/TASK-VS-063` (bf1b290 + review fixes d486b25).
- **Design:** state lives in `verification_not_found_slips` (migration 078, a small table only, with no
  index on `verifications`, so no prod pre-build). The decision, quota, state upsert and insert run
  in one transaction under a row lock. The verified lookup fails open (it charges as before).
- **Logs:** `bank 8404 quota decision charged=<bool>` and
  `verified inside a charged 8404 window; not charged` for acceptance counts.
- **Review:** an independent reviewer returned APPROVE with nits. All warnings were fixed with
  red-first tests.
- **Out of scope, found in review:** on `main`, `assertReceiverCheck` relabels any error (including a
  DB error) as verified + receiver mismatch.
- **Rollback:** revert the task definition first. Never run the 078 Down migration under live code.
- **Known limitation:** batch `quota_used` stays code-based.
- **No backfill:** 8404s charged before deploy have no state row, so acceptance counts start at
  the deploy time.
- **slip-landing PR:** SparqLab/slip-landing#15 (text only). Hold its staging/prod promotion until slip-api
  is live on prod.

## Acceptance

- slip-api tests cover every row of the decision table, plus:
  - another sending bank's 8404;
  - an unchanged duplicate (0 quota);
  - an unchanged other `rejected` code (1 quota);
  - unchanged 404/4040 not_found;
  - an unchanged HTTP 422 response body for 8404.
- A test proves a resend within 30 s calls the bank (the stub sees a second call), and a resend
  with the same `Idempotency-Key` after an 8404 also reaches the bank.
- Migration, if any: replay-safe and idempotent, with the index pre-built on prod by hand, and
  the deploy order and rollback stated in the PR.
- Production acceptance (one full ICT day after deploy, counts only):
  - charged versus free 8404;
  - verified within 24 h after a charged 8404 charged 0;
  - no change in 409 or other 422 quota.

## Measurement after deploy

- **Daily counts:** 8404 rows (charged / free), slips verified within 24 h after an 8404, and the
  never-verified share by sending bank.
- **Once the merchant resends after 60 s:** the share of resends that pass estimates how many of
  the never-verified group are real slips. That is the open question above.
- **Reconciliation queries:** filter 8404 by `status_code`, not `status`, from the deploy date.

## Refund count query (for `refund_decision`)

Read-only. Run per month on prod with `SET statement_timeout = '60s';`. It is approximate: it
ignores a 24 h window that restarts, and slips whose first 8404 falls in the previous month.
Both are rare, because 99.7 % of 8404 slips get one attempt.

```sql
WITH r AS MATERIALIZED (
  SELECT branch_id, channel, lower(sending_bank) AS bank, lower(trans_ref) AS ref, created_at,
         lag(created_at) OVER w AS prev_at,
         first_value(created_at) OVER w AS first_at
  FROM verifications
  WHERE status = 'rejected' AND status_code = '8404' AND trans_ref <> ''
    AND created_at >= '2026-10-01 00:00:00+07' AND created_at < '2026-11-01 00:00:00+07'
  WINDOW w AS (PARTITION BY branch_id, channel, lower(sending_bank), lower(trans_ref) ORDER BY created_at)
)
SELECT 'repeat_8404_30s_plus' AS kind, channel, count(*) AS n
FROM r
WHERE prev_at IS NOT NULL AND created_at - prev_at >= interval '30 seconds'
  AND created_at - first_at <= interval '24 hours'
GROUP BY 1, 2
UNION ALL
SELECT 'verified_after_8404', r.channel, count(*)
FROM r
JOIN verifications v
  ON v.branch_id = r.branch_id AND v.channel = r.channel
 AND lower(v.sending_bank) = r.bank AND lower(v.trans_ref) = r.ref
 AND v.status = 'verified' AND v.trans_ref <> ''
WHERE r.prev_at IS NULL
  AND v.created_at > r.first_at AND v.created_at <= r.first_at + interval '24 hours'
GROUP BY 1, 2
ORDER BY 1, 2;
```

Each counted row is one quota that rule C would not have charged. The quota goes back to the
channel's package (api / line).
