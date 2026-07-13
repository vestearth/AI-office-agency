# TASK-EAR-106: VIP Level inactive status not honored on front-end + Manage VIP redesign

Bugfix/general/high; `dev`. Repos: `Games-Labs-User` (backend), `Games-Labs-backoffice` (FE). No proto change in the shipping scope; a Missions change is only needed for the optional hard-progression variant (see below).

> Rev 2 — incorporates Codex review (see "Review findings incorporated"). The naive User-side level clamp from rev 1 is **withdrawn**; it desyncs Missions EXP.

## Problem (reported)

Manage > VIP Level > Status = Inactive in back office does not reach the app: inactive VIP levels are still displayed on the VIP page and users can still upgrade into them. Expected: inactive levels hidden and not upgradeable; a user's own level must not change just because a level's status flipped.

## Root cause (verified in code)

The **write path persists status correctly** (backoffice edit → `optional bool status` → handler `HasStatus`+`Status` → `UpdateLevel` saves it; `level_admin_test.go`). Enforcement is missing on the **read / progression** side in `Games-Labs-User`. Note `BuyVipLevel` (fast-pass) **already gates** on status (`service.go:442`) — the gap is list + detail + stats + turnover-progression, not "everywhere."

1. Public `ListVipLevels` (`service.go:500`) — `levelCfg.List()` with no status filter → inactive shown.
2. Public `GetVipLevel` (`service.go:538`) — no status check.
3. `GetLevelStats` (`service.go:221`) — exposes `nextCfg` (next level's config/EXP) with no status check; the "next level to reach" can point at an inactive level.
4. Turnover auto-progression `UpdateLevelProgress` (`service.go:264`) — no status awareness. Missions computes level from thresholds and cannot see status: `LevelProgressConfig` (`clients/user/client.go:106`) carries only `{Level, TurnoverRequired}`.

## EXP model (why a User-side clamp is wrong — verified)

Missions holds **residual** EXP within the current level. On turnover it adds EXP then loops, subtracting each crossed level's threshold (`level_service.go:303-317`: `userLevel.Points -= req; userLevel.Level = nextLevel`), and sends `(finalLevel, residualExp)` to User. Missions reloads level+EXP from `GetProfile` each event. Therefore if User stores a *clamped-down* level while keeping the residual EXP, the already-consumed threshold EXP is lost and re-charged next event → desync / double-charge. **Enforcement must not alter Missions' stored (level, exp) pair.**

## Decisions

- **Read-side hiding is the primary fix** and is User-only, low-risk, independently deployable. Closes the visible bug (not displayed) and, with the existing fast-pass gate, the "can't upgrade via VIP page" case.
- **Progression = display-mask, EXP-safe (DECISION LOCKED 2026-07-13).** The hard variant below is deferred to a separate task and not built here. `UpdateLevelProgress` keeps storing Missions' `(level, exp)` verbatim (no clamp → no desync), but:
  - the privilege-grant loop **skips inactive levels** (no privileges for an inactive level);
  - user-facing reads (`GetLevelStats`, `GetVipLevel`, `ListVipLevels`) present the **highest active level ≤ stored level** and hide inactive.
  - `GetProfile` (Missions' loader) stays **raw** — only user-facing reads are masked, so Missions math stays correct. When a skipped level is later reactivated, display/priv self-heal.
- **A user's current level is preserved.** Reads never reduce a user below a level they already hold beyond masking an inactive one to the active level below; nothing rewrites their stored level.
- **Inactive is set out-of-band, not via the back-office UI.** The UI only ever writes Active. Inactive comes from direct DB edit or the internal `/level-configs` PUT route (`level_config_handler.go`) — not the mobile path. "Default cannot be inactive" is DBA guidance, not enforced in code.
- **Optional hard variant (only if product wants the stored level to never be inactive):** move progression into Missions — feed active-only thresholds and make the `level+1` loop skip gaps (summing skipped thresholds). This needs a Missions change + status in the level-progress feed. Out of the shipping scope unless requested.

## Scope

### Backend — Games-Labs-User (ship first, deployable alone)
- `ports.ListLevelConfigsFilter`: add `ActiveOnly bool`.
- `repositories/level_config.go`: `levelConfigListWhere` appends `status <> 'inactive'` when `ActiveOnly`; add `HighestActiveLevelAtMost(ctx, level) (int, error)` (`… WHERE level <= $1 AND status <> 'inactive' ORDER BY level DESC LIMIT 1`; define the no-row floor → return 0, callers treat as "no active level yet").
- `ListVipLevels`: `ActiveOnly: true` (public only; admin `ListLevelConfigs` and `/level-configs` GET stay unfiltered so ops still see inactive).
- `GetVipLevel`: return `LevelConfigNotFound` for inactive, **unless** it is the caller's own current level (preserve current-level detail).
- `GetLevelStats`: resolve `currentCfg` to the user's stored level; resolve `nextCfg` to the next **active** level above the masked current; never emit an inactive `nextCfg`.
- `UpdateLevelProgress`: store `(level, exp)` verbatim; in the grant loop, **skip inactive levels** in `(prevLevel, level]` (grant only active).
- `BuyVipLevel`: unchanged (already gates). Note it only checks `currentLevel+1`; if that is inactive, fast-pass is simply unavailable — acceptable.

### Frontend — Games-Labs-backoffice
- `VipLevelWizard.vue`: remove Status toggle, Reset button, VIP list header link; lock Type to a read-only badge (create = Custom, edit = existing kind); Default edit read-only until an Edit button is pressed.
- `useVipLevelAdminList.ts`: **omit `body.status` entirely** on save (delete the `body.status = payload.status !== 'Inactive'` line, `:60`) so proto presence is false and the backend preserves existing status.
- `index.vue`: keep the Status column as a read-only badge.

## CRITICAL gotcha (refined per Codex)

Do **not** merely hide the toggle. If the save payload sends `status` at all — including an accidental `undefined`, since `undefined !== 'Inactive'` is truthy → `status: true` — the backend's presence logic overwrites `existing.Status` to active (`grpc.go:614`, `service.go:811`), silently reactivating any DB-set inactive level on the next edit. The FE must send **no** `status` field.

## Review findings incorporated (Codex)

- #1 root cause: reworded — `BuyVipLevel` already gates; gap is list/detail/stats/progression.
- #2 EXP desync: naive clamp withdrawn; replaced by store-verbatim + display-mask + priv-skip.
- #3 FE gotcha: sharpened to "omit `body.status` entirely" (the `undefined` truthy case).
- #4 `GetLevelStats` leak: added to scope. Downgrade risk: addressed by never rewriting stored level. `/level-configs` second surface: documented (not mobile path; ops-only). Type immutability across callers: optional hardening only. Undefined floor: `HighestActiveLevelAtMost` returns 0.
- Concurrency/snapshot: `UpdateLevelProgress` read-then-write race is **pre-existing**, not introduced here; noted as risk, out of scope unless it proves to bite the masking.

## Acceptance

- Public `ListVipLevels` excludes inactive; admin `ListLevelConfigs` still returns all.
- `GetVipLevel` → not-found for inactive except the caller's own current level; current level still resolves when inactive.
- `GetLevelStats` never returns an inactive `nextCfg`; a user on a now-inactive level is masked to the highest active level below without changing stored progression or EXP.
- Turnover progression stores Missions' `(level, exp)` verbatim (no EXP desync across events); inactive-level privileges are not granted; reactivating a level restores its display/privileges.
- `BuyVipLevel` still blocks an inactive next level.
- Back office sends no status on create or edit; editing a DB-set inactive level does not reactivate it. Reset + VIP list removed; Type read-only; Default edit read-only until Edit; list status badge read-only.
- Tests + backoffice prod-preview smoke (`:3010`) pass; staging gateway smoke confirms inactive hidden from public VIP list/detail.

### Test matrix (from Codex)
Multi-call progression through an inactive level (no double-charge across events); consecutive inactive levels; user's current level inactive (preserved, masked); inactive first/base level and inactive top level (floor/cap); status flipped mid-progression; edit-does-not-reactivate; `GetLevelStats.nextCfg` skips inactive; privileges not granted for a skipped inactive level.

## Out of scope

No proto/gateway change in shipping scope. The optional hard-progression variant (Missions active-only ladder + gap-skipping loop + status in the level-progress feed) is a separate decision/task. No data migration. No wizard redesign beyond the listed items. Mobile ladder-gap rendering is a note for the mobile team.
