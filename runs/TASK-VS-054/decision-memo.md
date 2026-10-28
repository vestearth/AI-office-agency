# TASK-VS-054 decision memo: daily digest Collect (2026-10-28, Claude)

Earth said "ทำต่อได้เลย" after TASK-VS-055. The task already fixes the approach: reuse the coverage-aware hourly aggregates, with no new schema and no timeout increase. No further decision is needed from Earth unless review finds one. Evidence ids refer to `evidence.yaml` in this run. Codex's intake is in `investigation.md`, which is local and not tracked.

## 1. Thirty days of production digests (ev-001)

`/ecs/slip-api-production`, 01:00–04:05 UTC each day, 2026-09-29..2026-10-28. Every day was paged to its end.

- **Sent:** 19 digests, one per day since 2026-10-10. No day was missed.
- **Failed attempts:** 4, each followed by a successful retry 8–38 s later:

| date | time (UTC) | failing stage |
|---|---|---|
| 10/14 | 01:00:21 | `digest previous slips` |
| 10/22 | 01:00:24 | `iterate digest top merchants` |
| 10/25 | 01:00:26 | `digest previous slips` |
| 10/28 | 01:00:22 | `digest previous slips` |

- **Different stages fail.** One 15 s context covers the whole of `Collect`, so whichever stage is running when it runs out takes the blame.
- **Successful sends land 6–31 s after 01:00.** The loop ticks once a minute from process start, so `Collect` is regularly seconds long at 08:00 Bangkok, not just on the failing days. Codex's off-peak probe measured about 371 ms for the two raw slip counts.

## 2. Mechanism (slip-api main ff38f76, `internal/repositories/daily_digest.go`)

`Collect` runs four parts in sequence on one `context.WithTimeout(ctx, r.timeout)` (15 s):

1. today's slip counts (raw scan of about 400k `verifications` rows);
2. yesterday's slip counts (another about 400k rows);
3. top merchants: a raw `GROUP BY` over the day, joined to `merchants`;
4. the totals over users, merchants, branches, KYC, payments and credits.

The first three re-read every verification of the day. They are counts that `verification_usage_hourly` already holds for every covered hour; that table is migration 065, maintained by a trigger and backfilled (TASK-VS-048).

Codex's investigation found:
- 0 mismatches between rollup and raw on the two covered days;
- the two-day rollup read takes 0.217 ms, against about 371 ms raw.

## 3. Change

- **Rollup reads:**
  - The day slip counts and the top merchants read whole covered hours from `verification_usage_hourly`.
  - `verifications` is read only for hours before `covered_from` and for any partial hour.
  - This reuses `splitUsageRange` and its coverage rule, as the TASK-VS-053 scoped admin counts do.
  - The rollup and raw parts of each figure are one statement (a `UNION ALL`), so they share a snapshot.
  - Bangkok day bounds are half-open `[from, to)`. Each part is unchanged:
    - every status count;
    - the top-merchant ranking (`slips DESC, m.name`, top 3, joined to `merchants`);
    - claim, release and retry.
- **Per-stage deadlines:** each part gets its own `r.timeout`, so a slow stage cannot use up the next stage's budget.
  - The 45 s run deadline in `runDailyDigestLoop` still caps the whole run.
  - Errors keep naming their stage.
- **Not changed:** no schema, no timeout value and no message format.

## 4. Acceptance

- **Failing before the fix:** with the raw rows of a covered day removed behind the rollup trigger, `Collect` must still return that day's counts and top merchants. The old code returns zeros.
- **Parity:** `Collect` equals the old raw SQL with coverage none, full, partial (with stale rollup rows below coverage) and after the range. The cases include:
  - rows at -1 µs, exact midnight and +1 µs around both day edges;
  - every status;
  - a tie in the top merchants.
- **Full checks:** the full suite with both test DSNs and race, plus vet, a readonly build and an independent review.
- **Delivery:** a PR into main, merged only on Earth's go, with no deploy in this task.

## 5. Implementation and review (2026-10-28)

- **Branch:** slip-api `task/TASK-VS-054-digest-rollup` from main ff38f76.
  - ba0b535: rollup reads and per-part deadlines.
  - b2fe22f: review fixes.
- **PR:** SparqLab/slip-api#109 into main.
  - Merged on Earth's go at 2026-10-28 13:50Z, pinned to the reviewed head b2fe22f.
  - Merge commit: 9524b15. Its tree equals b2fe22f.
  - Not deployed. No workflow ran, and staging and prod are unchanged.
  - main now also carries TASK-VS-055 (ff38f76), so the next promotion ships both.
- **Review finding (independent reviewer agent, approve-with-nits):**
  - **Problem:** with a deadline per part, five parts could take 75 s inside the 45 s run. That would leave `SendText` (a 10 s Lark client) too little time. A send timeout after Lark had accepted the post would release the claim and post the digest twice.
  - **Fix:** `Collect` now ends within two stage budgets (30 s in production), still with a deadline per part.
  - **Also done:** the lock-based tests are serialized, and the synthetic test days are cleared first.
- **Evidence:**

| ev | kind | result |
|---|---|---|
| ev-002 | RED | rollup test on main: zeros |
| ev-003 | RED | final tests on main: rollup zeros, and `digest totals: timeout` at 502 ms with about 300 ms waits per part |
| ev-006 | RED | cap test on ba0b535: 1.216 s against a 1 s total |
| ev-007 | GREEN | full `-race` suite with both DSNs, plus the digest tests |
| ev-008 | static | vet, readonly build, gofmt, `git diff --check` |

- **No deploy-order constraint and no schema change.** The speed-up applies to days at or after production `covered_from` (2026-09-25 03:00Z per Codex's intake).
