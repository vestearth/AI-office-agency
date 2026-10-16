# TASK-VS-031: SlipsManage scoped counts: stop unbounded all-history COUNT per filter change

- Type: performance / reliability (slip-admin and/or slip-api; approach to be decided)
- Created: 2026-10-16 by the Claude conductor lane at operator request. Claude opens
  this run only; implementation goes to another lane.
- Gates: preset `production`.
- Follow-up of TASK-VS-027 (scoped COUNT indexes 061/062). Related but separate:
  TASK-VS-030 (`COALESCE(channel)` → `channel = $n`; touches the same `adminVerificationWhere`
  in slip-api `internal/repositories/verification.go`, so do not edit that function here
  without rebasing on VS-030).

## Problem

slip-admin SlipsManage (origin/prod f28053b, `app/features/slips/ui/SlipsManage.vue`)
sends shop/branch/channel filters **without any date range**:
- `loadStats()` (:83-100) fires 5 parallel `slipsApi.list` calls (status all/verified/
  rejected/not_found/duplicate, `limit: 1`) on every shop/branch/channel change (:102);
- `load()` (:150-161) lists the page; slip-api `AdminListVerifications`
  (reports.go:98-120, origin/prod 822a04f) runs `ListAll` and `adminVerificationCount`
  concurrently for every list call.
So one filter change = 6 COUNTs over the tenant's whole history.

slip-api: `from`/`to` are optional (`parseOptionalPaymentRange`, reports.go:1054), and any
merchant/branch/channel filter skips the closed-day count cache and goes to an uncached
`CountAll` (reports_summary.go:30-31) with a 10 s budget.

Size (prod, 2026-10-16, TASK-VS-027 `vs027-followups-prod-results.md`): ~4.39M live rows,
357,643 inserts in the last 24 h; the dominant merchant/branch holds ~80% of rows. After
061/062 a 15-day dominant-branch verified count takes ~450 ms as an Index Only Scan with
~446k heap fetches (`prod-explain-plans-after.txt`). All-history counts for that tenant scale
with the table and are the likeliest next 10 s timeout. Not measured: no all-history timing,
UI latency or failure has been captured yet — first step below.

## Scope

1. Measure first (script: `explain-slipsmanage-alltime-prod.sql` in this run): read-only prod EXPLAIN (ANALYZE, BUFFERS) of the all-history
   dominant-merchant and dominant-branch counts (status '' and each status), run by the
   operator in DBeaver (BEGIN READ ONLY … ROLLBACK), plus CloudWatch latency of
   `/v1/admin/verifications` requests carrying merchant/branch filters.
2. Decide the approach (operator/review) and record it here:
   a. slip-admin: give SlipsManage a default date range (e.g. this month, Bangkok days
      aligned) for list + stats, with a visible range picker; or
   b. slip-api: extend the closed-day count store to merchant/branch scopes so scoped
      counts read cached closed days + a live tail; or
   c. replace the 5 stats calls with one grouped status-count endpoint (contract: additive).
   Options can combine; prefer the smallest change that bounds the work per request.
3. Implement the chosen option with tests; keep existing API behaviour for callers that do
   not send a range (ReportSlipVerified / UsersManage already send from/to).

## Decisions

- 2026-10-16, operator: the SlipsManage summary cards (admin.up-slip.com
  `?view=slips&tab=history`, menu KBANK → "ประวัติสลิป") must keep showing **all-time
  totals**. Option (a) as a default date range is therefore out (a range picker may still be
  added, but the default stays all-time).
- Resulting order (Claude conductor recommendation, subject to the measurement in step 1):
  (c) first — one grouped status-count call instead of 5 separate counts; then (b) scoped
  closed-day counts only if the measured all-time count for the dominant tenant is still too
  close to the 10 s budget. (b) likely needs a scoped aggregate table + idempotent migration
  + backfill, and touches `adminVerificationWhere` (rebase on TASK-VS-030).

## Step 1 result (2026-10-16 10:34, `prod-explain-results-2026-10-16.md`)

- The dominant tenant is now ~100% of the table: all-time merchant count = 4,478,904 rows
  (3 × 1,492,968) vs reltuples 4,473,830. All counts are Index Only Scans; no seq scan.
- Slowest single count 749 ms (first run, 22k buffers read); repeat 457 ms. Merchant 5 counts
  sum 1,219 ms vs grouped 550 ms (~2.2× less SQL time, sequential, not concurrent API).
- Measured just after an autovacuum (98.8% all-visible, 58k heap fetches). Just before the
  next insert-vacuum (~650k inserts) heap fetches would be ~10× higher; not measured.
- Rough linear headroom to 10 s at the current rate: ~60–98M rows ≈ 5–9 months at
  357,643 rows/day. Only valid while the 255 MB status indexes stay cache-resident;
  concurrent API latency (6 parallel queries, 2 workers each) not measured.

Claude conductor recommendation: (b) is not justified now. (c) is a cheap, optional
reduction; otherwise park the task with a re-measure trigger (any 10 s timeout on
`/v1/admin/verifications` with a merchant/branch filter, or reltuples > ~20M).
Operator decision 2026-10-16: **implement option (c) only.** (b) stays out unless a
re-measure trigger fires (any 10 s timeout on `/v1/admin/verifications` with a
merchant/branch filter, or reltuples > ~20M). No default date range (all-time totals stay).

## Implementation scope for (c)

slip-api (origin/prod 822a04f paths), additive only:
- New `GET /v1/admin/verifications/status-counts` taking the same filters as
  `/v1/admin/verifications` except status/limit/offset (`merchantId`, `branchId`/`branchIds`,
  `channel`, optional `from`/`to`), returning `{ total, verified, rejected, notFound,
  duplicate }` (wire naming per the existing admin JSON style; int64 rules as for other
  counts).
- One SQL per request: `SELECT status, COUNT(*) FROM verifications WHERE <adminVerificationWhere
  without status> GROUP BY status`; total = sum. Reuse `adminVerificationWhere`
  (verification.go:793); do not copy it. Same 10 s budget as `CountAll`. Unfiltered (global)
  requests may reuse the closed-day store if trivial; otherwise uncached is acceptable.
- Wire it like the sibling admin routes: router.go (near :456, admin-only middleware),
  middleware/metrics.go route label (:96-103) and middleware/audit.go path case (:321-329).
- Tests: repository (counts per status incl. channel + multi-branch filters, matches
  per-status `CountAll`), handler (validation, admin-only), plan test that the grouped
  scoped query is an Index Only Scan on `verifications_(merchant|branch)_status_created_idx`.

slip-admin (origin/prod f28053b):
- `features/slips/services/slips.ts`: add `statusCounts(query)`.
- `SlipsManage.vue` `loadStats()` (:83-100): replace the 5 `slipsApi.list(limit:1)` calls with
  one `statusCounts` call; keep the cards, labels and the `statsRunId` stale-response guard.
- `load()` keeps its own list + total (out of scope).

Deploy order: slip-api first (new route unused until the admin ships), then slip-admin.
Rollback: revert slip-admin (falls back to 5 counts); slip-api route can stay.
Coordination: TASK-VS-030 edits `adminVerificationWhere` (channel predicate) — whichever
merges second rebases; both changes are compatible.

## Acceptance

- Before/after evidence for the dominant tenant: the counts SlipsManage triggers finish well
  inside the 10 s budget (prod read-only EXPLAIN ANALYZE or request logs).
- Regression test for the chosen path (seen failing first): e.g. scoped count served from the
  closed-day store, or SlipsManage requests carry a bounded range.
- Contract changes, if any, are additive; slip-admin and slip-api deploy order stated.
- Staging: SlipsManage with dominant shop/branch filter loads list + stats without errors.

## Deploy order and rollback

Depends on the option: slip-admin-only → normal frontend deploy, rollback = revert. If a new
API field/endpoint is used, deploy slip-api first, then slip-admin; rollback in reverse.
No schema change is expected; if one appears it ships with an idempotent migration.

## Implementation — option (c) (Claude, 2026-10-16)

Conductor session asked this session to implement directly (operator drives all sessions).

- **slip-api PR #78** (cb0d2c3, `task/TASK-VS-031-status-counts`, base origin/main 104a547):
  `GET /v1/admin/verifications/status-counts` (AdminAuth) → `{total, verified, rejected,
  not_found, duplicate}` (existing `AdminVerificationStatusCounts` JSON). Same params as the
  list; `status`/`limit`/`offset` ignored; `merchant_id`/`branch_ids` must be UUIDs (helper
  `validateAdminScopeIDs`, shared with bank-flows). Shop/branch/channel → one
  `GROUP BY status` (`CountAllByStatus`, reuses `adminVerificationWhere`, 10 s). Platform-wide
  → cached per-status `adminVerificationCount` (unchanged cost for the unfiltered page).
  Router, metrics label, audit event `admin_verification_status_counts`.
- **slip-admin PR #16** (75397f3, base origin/main 82ff9a8): `slipsApi.statusCounts()`;
  `loadStats()` = 1 request instead of 5. All-time default, cards, stale guard unchanged.
- Evidence: RED ev-002 (route 404 + missing methods); GREEN ev-003; slip-api suite (repo +
  migration DSNs) ev-004, race ev-005, vet ev-006, readonly build ev-007; slip-admin
  typecheck ev-008, build ev-009, contract-negative typecheck (wrong field → TS2551) ev-010.
- Dropped: a grouped-query plan assertion — in a rolled-back fixture the visibility map is
  empty so PostgreSQL picks `(scope, created_at)`; failed 15/15 after one pass. Prod plan
  already shows Index Only Scan on the status indexes (step-1 items 7, 11).
- Not verified: browser run against a live slip-api (no slip-admin test runner) — staging
  acceptance.
- Contract: additive only. **Deploy order: slip-api #78 first, then slip-admin #16.**
  Rollback: revert slip-admin; slip-api route may stay. Old slip-admin + new slip-api is
  harmless; new slip-admin + old slip-api shows "—" on the cards.

## Review (independent reviewer subagent, 2026-10-16)

- Round 1 (cb0d2c3 / 75397f3): APPROVE WITH NITS. W1: platform-wide path ran 4 counts
  sequentially; before warm-up each falls back to an uncached 10 s CountAll → could pass the
  20 s write timeout (old code ran 5 in parallel). W2: test did not assert the platform-wide
  call pattern. Nit: total as sum of statuses relies on the status CHECK on prod.
- Fix dc88fe1: total + 4 statuses run concurrently; total from the status-less count
  (COUNT(*)); test asserts 5 per-card counts (RED on cb0d2c3 ev-011). Suite/race/vet/build
  ev-012..ev-015.
- Round 2: APPROVE WITH NITS, race-free (Go 1.25 loop vars, per-slot writes), errors.Join
  keeps error mapping. Remaining nits (non-blocking): no early cancel on one failed count
  (same as before); warm-cache path tested only indirectly; plan assertion for the grouped
  query to add when TASK-VS-030 changes `adminVerificationWhere`.
- STOP: merge/deploy waits for operator approval (via the conductor session).

## Deployed (2026-10-16, operator batch approval authz-001/authz-002 via conductor)

- slip-api #78 merged 500356a → staging f318a8b (`slip-api-staging:137`, run 38894714319)
  → prod f1ff0df (`slip-api-production:96`, run 38895982824, 5/5).
- slip-admin #16 merged 0512744 → staging 3ff65fc (`slip-admin-staging:71`, run 38897276050)
  → prod 7c0eedb (`slip-admin-production:59`, run 38897897517). slip-api reached prod first.
- Re-verified by this session (ev-017): branch tips, CI runs success, ECS images and
  rollouts COMPLETED. Live route: unauthenticated GET → 401 on staging and prod, unknown admin
  path → 404 (ev-019). Deployed admin bundles (staging + prod) contain the status-counts call
  (ev-020).
- production_acceptance pending: as of 12:09:51Z no `/v1/admin/verifications*` request on
  staging since 11:45:31Z or prod since 12:07:52Z (ev-018). Needs an admin to open
  ประวัติสลิป with a shop/branch filter; then check status 200, latency, and one
  status-counts request per filter change instead of five list requests.
- Re-check 12:11:14Z (ev-021): the only status-counts lines on staging/prod are this
  session's own unauthenticated probes (401 at 12:10:09Z); still no admin request.
