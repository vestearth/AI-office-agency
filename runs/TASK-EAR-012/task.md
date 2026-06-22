# TASK-EAR-012 — Missions: support "unlimited" restore-streak (remove hard 3/month cap)

## Symptom (QA)

`GET /api/v1/missions/check-in/calendar` returns `restoreQuote.available = false`
for a user who still has a restorable missed day. Real capture (TestQA.json,
month `2026-06`, today `2026-06-22`):

```json
"restoreQuote": {
  "available": false,
  "status": "unavailable",
  "reason": "monthly_restore_limit_reached",
  "restoresUsed": 3,
  "maxRestoresPerMonth": 3,
  "nextRestoreNumber": 4
}
```

Days 1, 2, 3 are `isRestored: true` (3 restores already used); day 4 is
`missed` + `canRestore: true`. The user hit the monthly cap of 3.

## Root cause

The product intent (per operator) is that streak restore has **no monthly
limit**. The code enforces a hard cap of **3 restores/month** and provides **no
way to express "unlimited"**:

- Single live enforcement point — `internal/services/check_in_calendar_service.go:600`
  ```go
  if restoreCount >= cfg.Restore.MaxRestoresPerMonth { // 3 >= 3 -> blocked
      quote.Reason = "monthly_restore_limit_reached"
      return quote
  }
  ```
  Both GET quote and POST restore flow through `buildRestoreQuote`
  (`RestoreStreakWithResult` -> `GetRestoreStreakQuote` -> `buildRestoreQuote`),
  so this one guard governs everything.
- `MaxRestoresPerMonth = 0` (the natural "unlimited" sentinel) is coerced to 3
  in THREE places, so it can never reach the guard as 0:
  - `check_in_calendar_service.go:546` (normalizeCheckInConfig)
  - `internal/repositories/mission_repo.go:442` (Upsert)
  - `internal/repositories/mission_repo.go:501` (default when no row)
  Plus defaults: `check_in_calendar_service.go:45` and migration 023
  (`max_restores_per_month INTEGER NOT NULL DEFAULT 3`).
- Even if 0 survived, `restoreCount(0) >= 0` is always true -> every restore
  blocked = the OPPOSITE of unlimited.

`RestoreStreak` (`internal/services/mission_service.go:780`) is dead code — no
route or test calls it; both wired routes
(`internal/handlers/mission/http/mission.go:491`,
`internal/handlers/mission/grpc/server.go:210`) call `RestoreStreakWithResult`.

## Change-impact analysis

**Impact surface**

| Layer | File:line | Role |
| --- | --- | --- |
| Enforcement | check_in_calendar_service.go:600 | the only live cap guard |
| Normalize | check_in_calendar_service.go:546-548 | 0 -> 3 coercion (kills sentinel) |
| Default cfg | check_in_calendar_service.go:45 | default 3 |
| Repo upsert | mission_repo.go:442-443 | 0 -> 3 coercion |
| Repo default-row | mission_repo.go:501 | default 3 when no row |
| DB schema | migrations/023_check_in_calendar.sql:34 | DEFAULT 3, CHECK (>= 0) |
| Admin cfg | internal/handlers/adminmission/grpc/checkin.go | get/set value via proto |
| Response contract | RestoreStreakQuote.MaxRestoresPerMonth / RestoreStreakResult | mobile reads this |

**Dependents / clients**

- Mobile app: reads `restore_quote` (`available`, `reason`,
  `max_restores_per_month`, `restores_used`). README states mobile must NOT infer
  restore state client-side — it renders backend fields. So `max=0` must have an
  agreed meaning ("unlimited") in the app, or the app may render "0 of 0".
- Wallet: each restore calls `wallet.Debit` in Diamond
  (`check_in_calendar_service.go:432`). Unlimited restores = unbounded Diamond
  spend per user/month. Price ladder only defines steps 1-3; `restorePrice`
  returns the last step (10 Diamond) for restore #4+. No crash, but confirm the
  economy intent of charging 10/restore indefinitely.
- Existing data: the affected campaign already has `max_restores_per_month = 3`
  persisted. A code change alone will NOT fix live users — needs a data
  migration (or admin re-save) to set existing rows to the unlimited sentinel.

**Risk: HIGH** — touches missions reward flow + wallet/Diamond economy +
cross-client (mobile) contract + persisted data. Not a local change.

## Open decisions (blocking — for PO)

1. Is the policy truly **unlimited**, or **configurable with a high default**?
2. Default for NEW campaigns: unlimited (0) or keep a numeric default?
3. Mobile contract: agree `max_restores_per_month = 0` (or absent) = "unlimited"
   and that the app hides the "N of M" counter in that case.
4. Backfill existing campaigns to unlimited, or only going forward?

## Proposed diff (sentinel: `MaxRestoresPerMonth <= 0` = unlimited)

NOTE: proposed, NOT applied. Assumes decisions = unlimited + default unlimited +
backfill existing.

### 1. Enforcement guard — only enforce a positive cap

`internal/services/check_in_calendar_service.go:600`
```diff
-	if restoreCount >= cfg.Restore.MaxRestoresPerMonth {
+	if cfg.Restore.MaxRestoresPerMonth > 0 && restoreCount >= cfg.Restore.MaxRestoresPerMonth {
 		quote.Reason = "monthly_restore_limit_reached"
 		return quote
 	}
```

### 2. Stop coercing 0 -> 3 in normalize (let sentinel persist)

`internal/services/check_in_calendar_service.go:546-548`
```diff
-	if cfg.Restore.MaxRestoresPerMonth == 0 {
-		cfg.Restore.MaxRestoresPerMonth = defaults.Restore.MaxRestoresPerMonth
-	}
+	// 0 (or negative) means unlimited restores — do not coerce to a default.
+	if cfg.Restore.MaxRestoresPerMonth < 0 {
+		cfg.Restore.MaxRestoresPerMonth = 0
+	}
```

### 3. Stop coercing 0 -> 3 in repo upsert

`internal/repositories/mission_repo.go:442-443`
```diff
-	if restore.MaxRestoresPerMonth == 0 {
-		restore.MaxRestoresPerMonth = 3
-	}
+	// 0 means unlimited — persist as-is.
+	if restore.MaxRestoresPerMonth < 0 {
+		restore.MaxRestoresPerMonth = 0
+	}
```

### 4. Default-when-no-row -> unlimited

`internal/repositories/mission_repo.go:501`
```diff
-		return &models.CheckInRestoreConfig{CampaignID: campaignID, Enabled: true, Currency: models.CurrencyDiamond, MaxRestoresPerMonth: 3, PriceLadder: defaultCheckInRestorePriceLadder()}, nil
+		return &models.CheckInRestoreConfig{CampaignID: campaignID, Enabled: true, Currency: models.CurrencyDiamond, MaxRestoresPerMonth: 0, PriceLadder: defaultCheckInRestorePriceLadder()}, nil
```

### 5. Default config -> unlimited

`internal/services/check_in_calendar_service.go:42-51` (Restore block)
```diff
 		Restore: models.CheckInRestoreConfig{
 			Enabled:             true,
 			Currency:            models.CurrencyDiamond,
-			MaxRestoresPerMonth: 3,
+			MaxRestoresPerMonth: 0, // 0 = unlimited
 			PriceLadder: []models.CheckInRestorePriceStep{
```

### 6. Data migration — backfill existing campaigns (if PO says backfill)

New `migrations/0XX_restore_unlimited.sql`:
```sql
-- Restore streak is unlimited: 0 = no monthly cap.
UPDATE check_in_restore_configs SET max_restores_per_month = 0
WHERE max_restores_per_month = 3;  -- scope to the prior baked default only
ALTER TABLE check_in_restore_configs ALTER COLUMN max_restores_per_month SET DEFAULT 0;
```
(CHECK constraint `>= 0` already permits 0 — no constraint change needed.)

## Acceptance

- `GOWORK=off go test ./...` passes in Games-Labs-Missions.
- New test: with `MaxRestoresPerMonth = 0` and `restoreCount = 99`, a missed
  restorable day yields `restoreQuote.available = true` (never
  `monthly_restore_limit_reached`).
- Regression test: with `MaxRestoresPerMonth = 3` and `restoreCount = 3`, quote
  still returns `monthly_restore_limit_reached` (configurable cap still works).
- Existing restore/quote tests still pass (adjust any that assert the old
  default of 3).
- Mobile sign-off on `max_restores_per_month = 0` = unlimited display.

## Verification performed

- Read all enforcement/coercion/default sites listed above.
- Confirmed the single live guard; confirmed both routes use
  `RestoreStreakWithResult`; confirmed `RestoreStreak` (mission_service.go:780)
  has no live caller.
- Confirmed `restorePrice` has a safe fallback for restore #4+ (no crash when
  unlimited).

## Verification NOT performed

- Did not query the live DB to confirm whether this user's `3` came from a
  persisted config row or the baked default (recommend
  `SELECT enabled, max_restores_per_month FROM check_in_restore_configs WHERE campaign_id = <id>`).
- Did not run the build/tests (analysis only; no code applied).
- No mobile-side confirmation of `max=0` handling.
