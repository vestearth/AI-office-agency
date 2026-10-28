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

## 8. Production index pre-build (runbook for Earth, decision D2)

Run this **before** any slip-api deploy that contains migration 067. Once this index exists, migration 067 does nothing at boot (`IF NOT EXISTS`).

Do not let a boot build it. Migration 063 took 1m8s on about 4.4M rows. This index covers 9.52M rows and two CASE expressions per row. A booting task that is still building gets replaced after about 150 s, and the deploy then loops (section 3, option A).

### Where and when

- **Database:** RDS `upslip-postgres-prod` (PostgreSQL 18.3), the slip-api production database (the task's `POSTGRES_DB`). `CREATE INDEX` needs the role that owns `verifications`, which is the role slip-api migrates with.
- **Window:** a quiet window, for example 02:00–05:00 Bangkok. Migration 063 ran at 03:20 Bangkok.
- **Expected duration:** several minutes, not measured. `CONCURRENTLY` keeps reads and writes running, but adds I/O and CPU while it builds.
- **DBeaver settings:**
  - Use **Auto-Commit** mode. `CREATE INDEX CONCURRENTLY` fails inside a transaction block.
  - The session must not carry a short statement timeout.

### 1. Build (copy exactly; this is migration 067's statement)

```sql
SET statement_timeout = 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS verifications_bank_flow_pair_idx ON verifications (
    (CASE
        WHEN upper(btrim(sending_bank)) IN ('BBL', '002', '2') THEN '002'
        WHEN upper(btrim(sending_bank)) IN ('KBANK', '004', '4') THEN '004'
        WHEN upper(btrim(sending_bank)) IN ('KTB', '006', '6') THEN '006'
        WHEN upper(btrim(sending_bank)) IN ('TTB', '011', '11') THEN '011'
        WHEN upper(btrim(sending_bank)) IN ('SCB', '014', '14') THEN '014'
        WHEN upper(btrim(sending_bank)) IN ('CIMB', '022', '22') THEN '022'
        WHEN upper(btrim(sending_bank)) IN ('UOB', '024', '24') THEN '024'
        WHEN upper(btrim(sending_bank)) IN ('BAY', '025', '25') THEN '025'
        WHEN upper(btrim(sending_bank)) IN ('GSB', '030', '30') THEN '030'
        WHEN upper(btrim(sending_bank)) IN ('GHB', '033', '33') THEN '033'
        WHEN upper(btrim(sending_bank)) IN ('BAAC', '034', '34') THEN '034'
        WHEN upper(btrim(sending_bank)) IN ('KKP', '069', '69') THEN '069'
        WHEN upper(btrim(sending_bank)) IN ('LHB', '073', '73') THEN '073'
        WHEN upper(btrim(sending_bank)) ~ '^[0-9]+$' THEN right('00' || upper(btrim(sending_bank)), 3)
        ELSE upper(btrim(sending_bank)) END),
    (CASE
        WHEN upper(btrim(receiving_bank)) IN ('BBL', '002', '2') THEN '002'
        WHEN upper(btrim(receiving_bank)) IN ('KBANK', '004', '4') THEN '004'
        WHEN upper(btrim(receiving_bank)) IN ('KTB', '006', '6') THEN '006'
        WHEN upper(btrim(receiving_bank)) IN ('TTB', '011', '11') THEN '011'
        WHEN upper(btrim(receiving_bank)) IN ('SCB', '014', '14') THEN '014'
        WHEN upper(btrim(receiving_bank)) IN ('CIMB', '022', '22') THEN '022'
        WHEN upper(btrim(receiving_bank)) IN ('UOB', '024', '24') THEN '024'
        WHEN upper(btrim(receiving_bank)) IN ('BAY', '025', '25') THEN '025'
        WHEN upper(btrim(receiving_bank)) IN ('GSB', '030', '30') THEN '030'
        WHEN upper(btrim(receiving_bank)) IN ('GHB', '033', '33') THEN '033'
        WHEN upper(btrim(receiving_bank)) IN ('BAAC', '034', '34') THEN '034'
        WHEN upper(btrim(receiving_bank)) IN ('KKP', '069', '69') THEN '069'
        WHEN upper(btrim(receiving_bank)) IN ('LHB', '073', '73') THEN '073'
        WHEN upper(btrim(receiving_bank)) ~ '^[0-9]+$' THEN right('00' || upper(btrim(receiving_bank)), 3)
        ELSE upper(btrim(receiving_bank)) END),
    created_at DESC, id DESC
) WHERE status = 'verified';
```

### 2. Check that it is VALID (must return `t`)

```sql
SELECT indisvalid, indisready, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_index WHERE indexrelid = 'verifications_bank_flow_pair_idx'::regclass;
```

- **If `indisvalid` is `f`, the build was interrupted** (cancelled session, connection drop):
  1. Run `DROP INDEX CONCURRENTLY IF EXISTS verifications_bank_flow_pair_idx;`
  2. Run step 1 again.
- **Never deploy with an INVALID leftover.** The boot guard would drop it and rebuild it inside the health-check window.
- **Expected size:** about 0.8 GB (estimate: 1.22 × the 674 MB `verifications_verified_created_idx`).

### 3. Refresh statistics (gives the planner the bank-code expression stats)

```sql
ANALYZE verifications;
```

### 4. Tell Claude / the run

Record:
- start and end time
- the size from step 2
- whether any retry was needed

After that, the code can go main → staging → prod as usual. Staging builds the index at boot, on its small database.

### Rollback

- **Order:** revert the code first, then `DROP INDEX CONCURRENTLY IF EXISTS verifications_bank_flow_pair_idx;`.
- **Why the index goes last:** the added predicates have no statistics without the index.
- **Index on its own:** leaving the index in place after a code revert is harmless; it only costs one more insert per verified row.

### Record of the production pre-build (2026-10-28, Claude, at Earth's request)

Earth changed D2 in chat: Claude builds now, and merges #108 only once the index is valid. Staging and production promotion stay with Earth.

**Precheck:**
- The index was absent.
- `slipadmin` (the app role) owns `verifications`.
- No transaction was older than a few ms.
- goose was at version 66.

**How it ran:**
- `CREATE INDEX CONCURRENTLY` exactly as in migration 067, started detached (`setsid`) inside slip-api task `10bd1d5e…` through ECS Exec.
- `statement_timeout = 0`.

**Timing (ev-015, ev-016):**

| step | duration | at (Bangkok) |
|---|---|---|
| started | — | 17:54:31 |
| `CREATE INDEX` | **2m58s** | |
| `ANALYZE verifications` | 1m08s | |
| finished | — | 17:58:37 |

- The build was VALID first time, with no retry. Size: **458 MB**, 9.67M entries (the estimate had been ~0.8 GB).
- 2m58s is longer than the ~150 s window a booting task survives, which confirms that a boot-time build would have looped.

**Production plans after the build (ev-018, new query shape, read-only):**

| case | before (Codex) | after |
|---|---|---|
| out/073 page 1 | 2.6 s | 3.1 ms |
| out/073 offset 5000 | cancelled at 5 s | 43 ms |
| generic plan | — | 1.6 ms (`= $n`) |

All three used `verifications_bank_flow_pair_idx` with 0 rows removed by the filter.

**Customer impact caused by the build (ev-019, ev-020, ev-021):**
- **What happened:** `POST /v1/slips/verify` returned **12 × 504** (`context deadline exceeded`, about 3 s) between 17:56:02 and 17:56:03. All 12 came from one merchant and one branch.
  - These are the only verify 504s in the 7 days since 2026-10-21.
  - **11** of the 12 left no `verifications` row.
  - **1** was saved as `rejected` while the client got 504.
- **RDS at the same minutes:**

  | metric | normal | 17:55–17:56 |
  |---|---|---|
  | WriteLatency (max) | about 2 ms | 59 ms |
  | DiskQueueDepth | 0.1 | 7.3 |
  | ReadIOPS | about 20 | up to 1,039 |
  | CPU | — | up to 53 % |

- **Likely cause:** writing the index and its WAL saturated I/O, so verify inserts overran their 3 s deadline. This was not a lock: `CONCURRENTLY` does not block inserts.
- **Lesson:** low average CPU is not I/O headroom. Run index builds on `verifications` only in the 01:00–05:00 Bangkok window. With hindsight, the original D2 (a quiet window) was right, and my "build now" recommendation was wrong.

**#108:** merged into main as `ff38f76` at 11:03:10Z, after the index was valid.
- No deploy workflow ran; deploys trigger on `staging` / `prod` pushes only.
- `origin/staging` (227561c) and `origin/prod` (1dd7ab3) are unchanged.
