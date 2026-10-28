# TASK-VS-055 decision memo: bank-flow transfers timeouts (2026-10-28, Claude)

Read-only work only: production logs, production catalog reads, and a local synthetic Postgres.
No slip-api or slip-admin source, schema or config was changed. Evidence ids refer to
`evidence.yaml` in this run.

## 1. What 30 days of production logs show (ev-001)

`/ecs/slip-api-production`, 2026-09-29 00:00Z to 2026-10-28 09:52Z, every day read to its last page.

| endpoint | requests | 5xx | 5xx since 2026-10-15 (after TASK-VS-022/024) |
|---|---:|---:|---:|
| `/bank-flows` (summary) | 426 | 61 | 0 |
| `/bank-flows/transfers` (list) | 379 | 17 | 9 |

The 9 transfer failures since 2026-10-15 fall into two classes:

1. **List timeout:** `list bank flow transfers: timeout` (2× on 10/15, 1× on 10/28). The page query hit its own 15 s deadline.
   - On 10/28 at 03:23:58Z the same page was retried and succeeded in **12,774 ms**. So the page query runs close to its budget; this was not a one-off blip.
2. **Count timeout:** `count bank flow transfers: timeout` (6× on 10/21, all between 06:28 and 06:34 UTC).
   - The service runs this COUNT only when `q` is set, or when the range is not on Bangkok day edges or is longer than 93 days.
   - Six failures in 6 minutes fit search typing, since slip-admin debounces search by 200 ms.
   - This is likely, not proven: the access log does not record the filters.

Not a timeout cause, recorded for later:
- Transfers p50 on 10/28 was about 1.4 s.
- Every unsearched transfers request recomputes today's open-day summary live (`cachedBankFlowSummary` → `BankFlowSummary` for today).

## 2. Mechanism behind class 1 (from source, slip-api origin/prod 1dd7ab3)

**How the page query runs:**
- It scans `verifications_verified_created_idx` in `created_at DESC, id DESC` order.
- Direction and bank are applied *after* the index, as computed CASE expressions.
- It stops after `offset + limit` matches.
- When fewer than `offset + limit` rows match in the range, it reads **every verified row in the range**.

**How large that is:**
- Production holds 9.52M verified rows (ev-004).
- The table grew from about 4.4M rows on 10/17 (TASK-VS-040) to 9.84M on 10/28, about 400k+ rows/day. A 30-day range therefore covers most of the table.
- Codex measured 2.6 s for about 460k rejected rows.
- At that rate, a full 30-day scan would take on the order of 50 s.

**What triggers it:** in slip-admin, clicking a small bank bucket in the KBank flow summary, or paging deep. That is the likely shape of the 10/15 and 10/28 failures.

## 3. Options for class 1 (bank / page)

### A. Expression index plus implied predicates (schema change) — recommended

**The change:**
- **Migration 067:**
  - `CREATE INDEX CONCURRENTLY IF NOT EXISTS verifications_bank_flow_pair_idx ON verifications ((<bank code of sending_bank>), (<bank code of receiving_bank>), created_at DESC, id DESC) WHERE status = 'verified'`.
  - It uses the INVALID-only drop guard and `DROP INDEX CONCURRENTLY` Down from migrations 061–063.
  - `<bank code>` is exactly the `bankFlowCodeSQL` CASE.
- **Query:**
  - When `bank` is set, add to `base`:
    - `from_code = '004' AND to_code = $bank` for out;
    - `to_code = '004' AND from_code = $bank` for in.
  - The existing direction/bank filter already implies these predicates, and the original predicates stay. The rows returned are therefore identical.

**Local proof of concept (ev-003):**
- Setup: PostgreSQL 18.3, 2M synthetic rows, bank frequencies from production `pg_stats`, same CTE and CASE text as production.
- The local planner picked bitmap scan + sort where production uses an ordered scan, so the absolute timings are not production timings.

| scenario | current SQL | rewritten SQL + index | same rows |
|---|---:|---:|---|
| out 073 (rare), page 1 | 1,647 ms | 0.65 ms | yes |
| out 069, offset 5000 | 1,795 ms | 33.5 ms | yes |
| in 088 (rare), page 1 | 1,851 ms | 0.68 ms | yes |
| out 014 (common), page 1 | 1,914 ms | 0.23 ms | yes |

"Same rows" means `EXCEPT ALL` is 0 in both directions. The index without the rewrite was not used to filter (1.7–2.8 s), so **both parts are required**.

**Cost:**
- **Disk:** the local index was 1.22× the size of `verifications_verified_created_idx` (71 MB vs 58 MB). That is about 0.8 GB on production (674 MB × 1.22, ev-004). RDS has 173 GB free (ev-006).
- **Writes:**
  - The table already carries 16 indexes (10 GB).
  - This adds one more btree insert per verified row. Rows are never updated (`n_tup_upd` = 0), so only inserts pay.

**What it does not fix:**
- direction-only filters without a bank
- search (class 2)

**Contract:** OFFSET stays. An offset of 5000 took 33 ms locally, so slip-admin needs no change.

**Deploy risk — the main caveat:**
- Migrations run at boot, before the HTTP listener (`cmd/main.go:76` vs `:315`).
- Migration 063 took **1m8s** at boot on about 4.4M rows (ev-005; table size from TASK-VS-040).
- This index covers 9.52M rows and evaluates two CASE expressions per row. The build time is estimated at several minutes; it has not been measured.
- A booting task is replaced after about 150 s: container `startPeriod` 60 s plus 3 × 30 s checks, with an ALB grace of 90 s (ev-005).
- What happens if the build runs past that:
  - The killed `CONCURRENTLY` build leaves an INVALID index.
  - The next boot drops it and starts over, so the deploy loops. The circuit breaker is off.
  - The old tasks keep serving, so there is no outage, but the deploy never finishes.
- **Mitigation:** pre-build the index out of band in a quiet window with the exact text from the PR, then `ANALYZE verifications`.
  - The migration then does nothing on production (`IF NOT EXISTS`).
  - It still builds on staging and on fresh test databases.

**Order:**
- **Deploy:** index and ANALYZE first, then the code.
  - Without the index, the added predicates have no statistics, so the planner falls back to default selectivity.
  - That could move common-bank pages off today's fast ordered scan. This must be covered by a plan test.
- **Rollback:** revert the code first, then `DROP INDEX CONCURRENTLY`.

**Upkeep:**
- The CASE text lives in both Go and the migration. A test must pin the two as equal; an immutable SQL function is the alternative.
- Adding a bank alias later requires a new index migration.

### B. No schema: seek by day using the cached per-day counts

- **How:** the service reads per-day (direction, bank) counts from the closed-day cache and narrows `created_at` to the days that hold rows `[offset, offset+limit)`.
- **Helps:** deep pages, and it skips empty days.
- **Does not help:** a bucket whose few matches are spread over many days. The query still scans each of those days (about 400k verified rows/day).
  - Example: 20 matches over 15 days ≈ 6M rows, about 34 s at the measured rate.
- **Other gaps:** today's open day is not cached, and the change adds service and repository code plus cache edge cases.
- Not recommended as the fix.

### C. Keyset (cursor) pagination

- This is an API contract change for slip-admin.
- It fixes deep pages only, not small buckets.
- Not recommended now.

### D. Diagnostics — recommended with A in every case

Log the shape of each transfers request, privacy-safe:
- direction and bank code
- `has_search` and the search length (never the text)
- offset and limit
- range in days
- whether the cached path was used
- per-stage milliseconds (summary / count / list)

The next timeout then names its own cause.

Ruled out by task.md and not options: raising timeouts, or disabling planner features.

## 4. Class 2 (search): a separate decision

**Why a B-tree cannot help:**
- Search runs `strpos` over five text columns, plus merchant and branch name `EXISTS`, for every verified row in the range.
- The COUNT runs before the page.

**Options:**
- **S1 (recommended now):** leave it as is and ship the diagnostics from D. There was one burst in 30 days; measure first.
- **S2:** add a slip-admin guard (minimum length, longer debounce, abort the previous request).
  - It cuts down bursts, but a search for a rare term still fails.
- **S3:** cap the count, for example at 1,000.
  - This is a contract change, and a rare term still scans the whole range.
- **S4:** `pg_trgm` GIN indexes.
  - This means an extension plus multi-GB indexes on the hot insert path, all for an admin search. Not recommended.
- **S5:** limit the search range, for example to 7 days or less. This is a UX and contract change.

## 5. Recommendation

1. **Class 1:** A + D, keeping OFFSET. Pre-build the index on production in a quiet window before the code deploys.
2. **Class 2:** S1 now; revisit with the data from D.
3. **Noted, out of scope:** the live open-day summary computed on each transfers request.

## 6. Decisions needed (Earth)

- **D1:** class-1 approach — A + D (recommended), B, C, or D only.
- **D2:** production pre-build — who runs it and when.
- **D3:** search — S1 now (recommended), or S2 as well.
- **D4:** pagination contract — keep OFFSET (recommended).

## 7. Decisions (Earth, 2026-10-28, answered in chat)

- **D1:** option **A + D**. Migration 067 expression index `verifications_bank_flow_pair_idx`, implied bank predicates, and privacy-safe request-shape diagnostics.
- **D2:** **Earth pre-builds** the production index in DBeaver (auto-commit), in a quiet window, using the exact SQL from the PR, then runs `ANALYZE verifications`. The code deploys only after that.
- **D3:** search → **diagnostics first** (S1). No slip-admin change in this task.
- **D4:** keep OFFSET (implicit in D1; no contract change).
- **Implementer:** Claude, in this session. Branch from the latest slip-api main; PR into main; no merge or deploy.
