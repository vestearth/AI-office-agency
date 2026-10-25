# TASK-VS-049 decision memo: bounded history contract

**Decided by Earth on 2026-10-26** (AskUserQuestion in the Claude side session), choosing from three options.

## Options shown

1. **Cursor page + server-side filters (chosen).**
   - Keyset pagination on `(created_at, id)` with an opaque `next_cursor`.
   - Optional `from` / `to` / `channel` filters, applied on the server.
   - Response `{items, has_more, next_cursor, limit}`. There is no `total`: a COUNT over millions of rows is the same slow query.
   - The current FE keeps working, because `mapBranchPackageHistory` already reads `record.items`. It shows only the first page until it adopts the cursor.
2. **Cap at the newest N rows, keep the bare array.**
   - Needs no FE change.
   - High-volume branches would see only the last few minutes. "เดือนก่อน" would be empty and the CSV export would be cut short, with nothing telling the user.
3. **Group deductions per day.**
   - Easiest for a person to read.
   - A GROUP BY over a month of `quota_history` for this branch (about 17M rows) has the same timeout. It would need a rollup table, a trigger and a backfill, like TASK-VS-048, which is too big for this fix.

## Scope (Earth)

- The slip-api PR into `main` goes first. It stops the 500 without breaking the deployed FE.
- slip-front-end adoption goes in a separate PR under the same task:
  - send `from`/`to`/`channel` from the month and channel filters;
  - follow `next_cursor`.
- No staging or prod promotion without Earth's approval.

## Contract

```
GET /v1/branch-packages/history?merchant_id=&branch_id=
    &limit=50                 default 50, max 200
    &from=<RFC3339>&to=<RFC3339>   optional; from inclusive, to exclusive
    &channel=api|line         optional
    &cursor=<next_cursor>     optional, opaque

200 {"items":[...row shape unchanged...],"has_more":bool,"next_cursor":"...","limit":50}
```

- **Sort order is unchanged:** `created_at DESC`. At the same timestamp a deduction sorts before a grant, then `id DESC`.
- **Cursor:** the last item's `(created_at, kind, id)`.
- **Deductions:** at most `limit+1` rows are fetched through `quota_history_branch_created_idx` or `quota_history_merchant_created_idx`.
- **Grants** (`branch_package_events`, a small table) are filtered by the same cursor and filters in memory, then merged.

## Amendment (Earth, 2026-10-26, after review): no server `channel` filter

- **Finding:** the independent review found that no `quota_history` index covers `channel`.
  - `?channel=line` on a busy api branch scans the whole branch history for 51 matches and times out.
  - A `from`/`to` window does not help: one month of that branch is about 17M rows.
- **Options:**
  1. Drop `channel` from the server contract (chosen).
  2. Keep it, and add migration 066: `CREATE INDEX CONCURRENTLY (branch_id, channel, created_at DESC, id DESC)`, NO TRANSACTION. That means a large index build on the hot table at boot, plus one more index write per verification.
- **Result:**
  - The server ignores `channel`; the FE filters the loaded rows on the client.
  - A channel-accurate ledger, if wanted, is a separate task that adds the index under a planned deploy window.
