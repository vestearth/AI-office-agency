# TASK-EAR-338: VIP one-time reward becomes claimable

## Type
feature

## Priority
high

## Scope
### Target Services
- `shared-lib` — userpb RPCs + `reward_status` + user error codes 3039/3040
- `Games-Labs-User` — ledger migration, grant/claim/list, admin skip, env switch
- `api-gateway` — wire format via shared-lib bump (after publish)

### Explicitly Out Of Scope
- Item 4 of mobile's request (`fastPass` on list/detail) — done in TASK-EAR-337
- Push notifications
- Reward expiry
- `Games-Lab-Android/` edits

## Locked decisions (D1–D7, 2026-09-08)
See `status.yaml`. Summary: only the Reward row pends; one pending item per level, any claim order; snapshot amounts+currency; Buy and turnover behave the same; admin SetUserVipLevel creates no reward; red-dot via `total_pending`; the initial rollout keeps the switch OFF until the mobile Claim screen is minimum supported.

## Staging activation update (2026-09-15)

Games-Labs-User PR #40 merged to `staging` at `7415bfa`. Deploy STAGING run
`34952844136` completed with `VIP_REWARD_CLAIM_ENABLED=true` rendered into the
task definition and ECS rollout `COMPLETED`. Staging is ready for an App/Tester
device E2E check; this is not yet confirmation that a real player has created,
claimed, and re-claimed an eligible reward. Production remains out of scope.

## App staging observation (2026-09-16)

Mobile reported a VIP 2 to VIP 3 upgrade after the switch was enabled. The VIP
3 catalog response returned `reward: null`, and the authenticated reward list
returned `items: []` with `totalPending: 0`. This matches the service contract:
a target level with no configured reward creates no reward ledger row. It does
not indicate an account-age issue and does not verify the positive claim path.
Retest with a target level that has a non-null, positive reward configured
before the level upgrade; configuring a reward after the upgrade does not
backfill the already-completed level.

## Acceptance criteria
- [ ] `user_vip_level_rewards` migration is idempotent and unique on `(user_id, level)`
- [ ] `VIP_REWARD_CLAIM_ENABLED` is a STRING `"true"`/`"false"`, default OFF, listed in `ecs/env.names` + staging/prod workflows
- [ ] Switch ON: BuyVipLevel and gameplay UpdateLevelProgress insert pending, do not pay
- [ ] Switch OFF: pay immediately and insert a claimed row
- [ ] Admin path grants avatars but no reward row and no payout
- [ ] GET `/api/v1/users/me/vip-level/rewards` lists items ascending by level + `total_pending`
- [ ] POST `/api/v1/users/me/vip-level/rewards/{level}/claim` pays once; re-claim is already-claimed; identity from JWT `userid` metadata
- [ ] `BuyVipLevelResponse.data.reward` kept; `reward_status` added
- [ ] int64 amounts are JSON strings on the wire
