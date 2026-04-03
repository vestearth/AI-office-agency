# TASK-012: Rename Level System Naming from Points to Turnover

## Overview
Standardize the naming used by the level progression system so that "lifetime turnover used for level-up" is no longer exposed as `points`.

This change is required to avoid confusion with future `Spendable Points` that will be used for reward redemption. The rename must be applied consistently from database schema through internal code and outward-facing API contracts.

## Type
refactor

## Priority
high

## Target Service
Games-Labs-User

## Target Files
- `Games-Labs-User` level/stats handlers, services, models, DTOs, and serializers related to user stats and level configs
- `Games-Labs-User` admin level config handlers and request/response payload definitions
- `Games-Labs-User` migration script `006`
- Any shared response/request structs exposed by the service for:
  - `GET /users/{id}/stats`
  - `PUT /level-configs/{level}`

## Description
The current level system uses the term `points` for accumulated turnover used to determine VIP / level progression. This is misleading because the product roadmap will also introduce `Spendable Points` for redemptions and rewards.

To make the contract explicit, all naming for level progression should be changed from `points` to `turnover`, while preserving the existing meaning:

1. **User Stats API**
   Endpoint: `GET /users/{id}/stats`
   - Rename `points` -> `level_up_turnover`
   - Rename `points_to_next_level` -> `turnover_to_next_level`
   - Keep `coin_turnover` unchanged

2. **Admin Level Config API**
   Endpoint: `PUT /level-configs/{level}`
   - Rename `points_required` -> `turnover_required`
   - Apply this rename to both request payload and response payload

3. **Database Schema**
   In `level_configs`
   - Rename column `points_required` -> `turnover_required`
   - Confirm migration script `006` reflects the new column name

4. **Internal Code / Business Wording**
   In `Games-Labs-User`
   - Rename internal variables and comments to match level-up turnover terminology
   - Update related validation / business wording
   - Update error message to:
     - `insufficient level-up turnover: have X, need Y`

## Acceptance Criteria
- [ ] `GET /users/{id}/stats` no longer returns `points`
- [ ] `GET /users/{id}/stats` no longer returns `points_to_next_level`
- [ ] `GET /users/{id}/stats` returns `level_up_turnover`
- [ ] `GET /users/{id}/stats` returns `turnover_to_next_level`
- [ ] `coin_turnover` remains unchanged
- [ ] `PUT /level-configs/{level}` accepts `turnover_required` instead of `points_required`
- [ ] Admin level config responses return `turnover_required`
- [ ] Database schema / migration `006` uses `turnover_required`
- [ ] Internal code/comments consistently use turnover terminology for level progression
- [ ] Validation or insufficient-balance style errors use `insufficient level-up turnover: have X, need Y`
- [ ] Frontend-visible API contract changes are documented for downstream consumers before deploy

## Technical Notes
- This is a contract change, not only an internal refactor.
- Rename only the level progression concept; do not rename unrelated fields such as `coin_turnover`.
- Preserve existing business logic and calculations. Only the naming contract should change.
- Ensure JSON keys, binding structs, DB mappings, and response serializers all stay aligned.

## Coordination Notes
- Frontend must update JSON key usage from:
  - `points` -> `level_up_turnover`
  - `points_to_next_level` -> `turnover_to_next_level`
  - `points_required` -> `turnover_required`
- DB Admin / DevOps should note that migration `006` includes a renamed schema field and should be deployed in the correct order.

## Assigned Agent
`dev`
