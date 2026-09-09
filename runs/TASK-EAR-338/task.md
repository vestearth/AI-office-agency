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
See `status.yaml`. Summary: only the Reward row pends; one pending item per level, any claim order; snapshot amounts+currency; Buy and turnover behave the same; admin SetUserVipLevel creates no reward; red-dot via `total_pending`; rollout switch OFF until mobile Claim screen is minimum supported.

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
