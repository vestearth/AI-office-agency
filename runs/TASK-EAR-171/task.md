# TASK-EAR-171 — Guard `entry_ref` on the pool save path (unblocks gate condition A2)

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-29

## Epic

Canonical game-classification (TASK-EAR-140..153). Direct follow-up to
TASK-EAR-167's ruling. **This is a hard blocker on TASK-EAR-151** — gate
condition A2 (TASK-EAR-168) cannot be made durable without it.

## Context

TASK-EAR-167 traced the 16 `weekly_activity_pool_entries` rows holding
`entry_ref='FISHING'` and ruled out both earlier explanations. Full evidence:
`runs/TASK-EAR-167/findings.md`. What it established:

- **TASK-EAR-166's fix does not reach this surface.** The generator emits only
  `entry_type` `"game"` and `"special_item"`
  (`schedule_generator.go:375-394`) and can never produce a category pool
  entry. The epic has a second, distinct hole.
- **The only live writer is the admin HTTP save, and it validates nothing
  relevant.** `POST /api/v1/admin/weekly/plans/full` →
  `weekly_admin.go:435` → `mission_repo.go:3313`. Its validator
  (`validateWeeklyActivityConfig`, `weekly_admin.go:171-181`) checks only
  `len(act.Pool) == 0`; it never inspects `entry_type` or `entry_ref`.
- **"Inert" was true of the data, not the code.** `games.game_type` is
  free-text `VARCHAR(50)` with no FK and no CHECK, and Games-Labs-Provider
  ships `GameTypeFishing = "fishing"` (`constants.go:34`) as a live vendor
  token. One typo or provider passthrough makes those rows start scoring
  silently through the fuzzy path.
- **Pool entries are strictly more exposed to the fuzzy path than rules are.**
  The pool branch's fuzzy loop is gated only on `evt.GameType != ""`
  (`activity_match.go:111`), whereas the `TURNOVER_GAME_TYPE` branch gates its
  fuzzy arm on either side's category being empty (`:55`). Every pool entry is
  containment-tested against every turnover event.

## The precise gap — verified, not assumed

| surface | `entry_type` validated? | `entry_ref` validated? |
| --- | --- | --- |
| daily (`daily_plan_repo.go:282`, `isValidDailyPoolEntryType`) | ✅ yes | ❌ no |
| weekly (`mission_repo.go:3356-3372`) | ❌ **no** | ❌ no |

The weekly loop only trims, lowercases, and skips empty values before
inserting. It is strictly weaker than the daily side. Note the method that
*does* validate (`ReplaceWeeklyActivityPoolEntries`, `:3477`) is **dead code** —
its only callers are `weekly_pool_test.go`.

## Objective

Make it impossible to persist a category pool entry whose `entry_ref` is not a
canonical game category, on **both** cadences — so gate condition A2 stays true
once satisfied instead of being re-broken by the next API call.

## Requirements

1. **Validate `entry_ref` for `entry_type='category'`** on the live save path,
   rejecting non-canonical values with `ErrInvalidInput` (→ 400). Cover
   **both** cadences: `validateWeeklyActivityConfig`
   (`weekly_admin.go:171-181`) and the daily equivalent
   (`validateDailyActivityConfig`, `mission_service.go:1978`, and/or the repo
   guard at `daily_plan_repo.go:282`).

2. **Reuse TASK-EAR-166's vocabulary — do not declare a third copy.**
   `resolveCategoryScope` / `categoryCanonicalCodes` in `schedule_defaults.go`
   already hold the canonical set and its normalization. The whole reason this
   epic kept recurring is that the same vocabulary was re-declared in several
   places and drifted. Reuse or extract; do not duplicate.

3. **Also close the weekly `entry_type` gap** while you are there — weekly
   accepts any `entry_type` string while daily does not. Mirror the daily
   check so the two cadences agree.

4. **Decide what to do with the dead `Replace*PoolEntries` methods.** Either
   delete them, or route the live path through them so the validation lives in
   one place. Do not leave a validated-but-dead method next to an unvalidated
   live one — that is what made this gap easy to miss. State which you chose
   and why.

5. **Surface the error properly.** The Backoffice reads `err.data.error`
   (JSON), so use the JSON error writer rather than plain text — see
   TASK-EAR-166's `writeError` change and the `serverErrorMessage` helper
   added in Games-Labs-backoffice#58. Check whether the weekly-plan save
   handler already returns JSON errors; if it uses `http.Error`, that has the
   same blind spot.

## ⚠️ Do NOT clean up the existing FISHING rows in this task

Code before data — the epic's own recorded lesson, and here there is a
specific trap:

- Pool-row deletes do **not** cascade (the `ON DELETE CASCADE` runs *from*
  `weekly_activities`, not into pool entries), **but**
- if `FISHING` is the **sole remaining entry** on a `TURNOVER_GAME_POOL`
  activity, deleting it leaves an empty pool: the matcher can then never match
  (mission unachievable for live users mid-week) **and** the next Backoffice
  save of that plan 400s on `weekly_admin.go:173`.
- The Backoffice weekly editor also **carries non-game entries forward on
  every save** (`weekly/edit/[id].vue:304`), so a cleanup applied before this
  guard deploys can be re-inserted by any stale editor tab.

Data cleanup belongs in a follow-up, after this deploys, and must check the
per-activity remaining pool count first. TASK-EAR-167's `findings.md` carries
the operator queries.

## Acceptance criteria

- A category pool entry with a non-canonical `entry_ref` is rejected at save
  time on **both** cadences, with a 400 carrying a JSON error the Backoffice
  can display.
- Weekly `entry_type` validation matches daily's.
- The canonical set is referenced from one place, not re-declared.
- Tests cover: canonical refs accepted (all five), a non-canonical ref
  rejected on **each** cadence, an invalid `entry_type` rejected on weekly,
  and existing valid saves unaffected.
- `go build ./...`, `go vet ./...`, `go test ./...` clean.
- No commit/push/PR without operator confirmation.

## Out of scope

- Cleaning up the existing FISHING rows (follow-up, after this deploys).
- Retiring the fuzzy fallback (TASK-EAR-151).
- The unconditional pool fuzzy loop noted in TASK-EAR-167 — narrowing that is
  a matcher change and belongs with TASK-EAR-151, not here.
- `games.game_type` being unvalidated free text on the Games-Labs-Game side —
  real, but a different service and a different task.
