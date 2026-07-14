# TASK-EAR-116: Validate configured wallet currencies at save (close the restore-Point class)

Type `bugfix`; workstream `backend`; priority `medium`; owner `dev`.
Related `TASK-EAR-115` (fixed Point restore routing). This closes the underlying class-level gap.

## Outcome

Config currencies are not validated at save: `normalizeCheckInConfig`/`normalizeCheckInReward`
only default empties, and the global `UpdateConfig` reward-currency setters
(`mission_service.go:1611-1650`) assign without checking. So an admin can configure a currency
the wallet path can't handle (that is how QA set restore=Point). EAR-115 fixed Point specifically;
this rejects any non-`{COIN,DIAMOND,POINT}` currency at save so the whole class is closed —
a restore set to THB (or a reward set to a typo) fails fast at config time instead of at runtime.

## Scope

- `internal/services/event_admin.go` — generalize `validEventCurrency` -> `validWalletCurrency`
  (case-insensitive COIN/DIAMOND/POINT), reused everywhere. No event behavior regression.
- `internal/services/check_in_calendar_service.go` — `UpdateCheckInConfig` validates restore +
  daily + milestone reward currencies; returns `ErrInvalidInput` on an unsupported value.
- `internal/services/mission_service.go` — add `ValidateConfigCurrencies(cfg)` for the global
  reward currencies (daily-login / daily-mission / watch-ad / monthly / boost).
- `internal/handlers/adminmission/http/{handler.go,activities.go}` — call `ValidateConfigCurrencies`
  before `UpdateConfig` (both are twins), returning HTTP 400 on an unsupported value.

Validate-only (reject); downstream Credit/Debit/redeem already normalize casing/aliases.
POINT stays valid for restore (works via redeem after EAR-115) and rewards (Credit accepts it).

## Acceptance criteria

- Saving a check-in config with restore currency THB (or any non coin/diamond/point) returns an
  invalid-input error; COIN/DIAMOND/POINT are accepted.
- Same for check-in daily + milestone reward currencies.
- Saving global mission settings with an unsupported reward currency returns HTTP 400; empty
  fields (no change) and valid values pass.
- `go build ./...` and focused tests pass.

## Plan

1. Generalize the currency helper to `validWalletCurrency` (case-insensitive).
2. Validate check-in restore + reward currencies in `UpdateCheckInConfig`.
3. Add `ValidateConfigCurrencies` and call it in both admin settings handlers before UpdateConfig.
4. Focused unit tests for each; verify build + tests; open a Missions PR against staging.

## Risks

- Existing staging/prod configs with an already-invalid currency would now fail on the next
  save. Mitigation: only COIN/DIAMOND/POINT are rejected-out; valid configs are unaffected, and
  an invalid one was already broken at runtime.

## Source evidence

- `check_in_calendar_service.go` normalizeCheckInConfig/normalizeCheckInReward (default-only, no validate)
- `mission_service.go:1611-1650` reward-currency setters (assign without validation)
- `event_admin.go:59` validEventCurrency (the good pattern to generalize)
- `handlers/adminmission/http/handler.go:382`, `activities.go:785` (UpdateConfig callers)
