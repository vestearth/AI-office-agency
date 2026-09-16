# TASK-EAR-361 — Expose VIP turnover-to-points conversion on public GetVipLevel

## Type

mobile contract addition (additive, backward compatible)

## Request

The mobile "VIP Up!" dialog shows an **Earn Points** row, e.g.
"10,000 turnover = 1 point", for the level just reached. The mobile team asked
for the selected level's conversion on `GET /api/v1/vip-levels/{level}` in this
shape:

```json
"turnover": {
  "turnoverRequired": "10000",
  "point": "1"
}
```

## Current state (verified 2026-09-16 against source)

- The admin config already stores this as `level_configs.privileges.turnover`
  → `models.TurnoverPrivilege{TurnoverRequired, Point}`
  (`Games-Labs-User/internal/models/user.go:182`).
- `VipLevelDetail` (public, `shared-lib/proto/userpb/userpb.proto:283`) exposes
  only `points` (field 4), mapped from `Privileges.Turnover.Point` in
  `vipLevelDetailFromConfig`
  (`Games-Labs-User/internal/core/services/usersvc/service.go:946`).
  The conversion's `turnover_required` is not exposed.
- `shared-lib` already defines
  `message TurnoverPrevileges { int64 turnover_required = 1; int64 point = 2; }`
  (used by admin messages). Reuse it; do not add a new message.
- Pins: Games-Labs-User `shared-lib v0.0.0-20260914082431-cb776ca21368`,
  api-gateway `v0.0.0-20260911222256-2862b193ce03` (older).

## TRAP — two different "turnover_required" values

- `level_configs.turnover_required` = cumulative turnover (exp) needed to
  **reach** the level. NOT this field.
- `privileges.turnover.turnover_required` = conversion-rate denominator
  ("N turnover = point"). THIS is the field to expose.

Mapping the wrong source renders a plausible but wrong number, so the test must
use distinct values for the two.

## Contract

```proto
message VipLevelDetail {
  ...
  int64 fast_pass = 10;
  // Turnover-to-points conversion for this level (level_configs.privileges.turnover).
  // Absent when the level has no conversion configured.
  TurnoverPrevileges turnover = 11;
}
```

- JSON via gateway (camelCase): `turnover.turnoverRequired`, `turnover.point`;
  both int64 → **JSON strings**. State this in the mobile handoff.
- Keep `points` (field 4) unchanged for existing app builds.
- Not configured (`Privileges.Turnover == nil`) → field omitted, not zeros.

## Implementation order

1. **shared-lib** — add field 11, regenerate, PR; stop for merge and record the
   exact pseudo-version.
2. **Games-Labs-User** — bump shared-lib to that pseudo-version; add
   `Turnover *TurnoverPrivilege` to `models.VipLevelDetail`; populate in
   `vipLevelDetailFromConfig`; map in `vipLevelDetailToPB`
   (`internal/core/handlers/userhdl/grpc.go:339`). Tests: configured → both
   values mapped from privileges (with a level `turnover_required` that
   differs); nil → field absent. PR to `staging`.
3. **api-gateway** — bump shared-lib to the same pseudo-version (otherwise the
   typed proto drops the field). PR.

## Acceptance criteria

- Staging `GET /api/v1/vip-levels/{level}` for a level with configured
  privileges returns `data.turnover` =
  `{"turnoverRequired":"<n>","point":"<m>"}` matching the admin config, with
  `data.points` unchanged.
- A level without the conversion configured omits `data.turnover`.
- Focused and full Go tests, readonly builds, and diff checks pass in all three
  repos.
- Mobile handoff note sent (int64-as-string, omission rule).

## Out of scope

- Migrations (data already lives in `privileges` JSON), admin API changes,
  `ListVipLevels` (only if mobile asks), production deploy/scale-up, and the
  Android client repo.

## Deploy order / rollback

shared-lib → User → gateway. Additive field: after shared-lib, either service
order is safe (a gateway without the bump simply omits the field). Rollback =
revert the User mapper or gateway bump; no data change.
