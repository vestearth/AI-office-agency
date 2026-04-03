# TASK-012: Rename Level System Naming from Points to Turnover

## Type
refactor

## Priority
high

## Description
Standardize the naming used by the level progression system so that lifetime turnover used for level-up is no longer exposed as `points`.

This rename is intended to prevent confusion with future `Spendable Points` used for rewards redemption. The change must stay consistent from database schema through internal code and outward-facing API contracts in `Games-Labs-User`.

## Scope
### Target Service
- `Games-Labs-User`

### Impacted Areas
- User stats API: `GET /users/{id}/stats`
- Admin level config API: `PUT /level-configs/{level}`
- Database schema / migration `006`
- Internal variables, comments, validation text, and error wording related to level progression

## Objectives
1. Rename user stats response keys:
   - `points` -> `level_up_turnover`
   - `points_to_next_level` -> `turnover_to_next_level`
2. Keep `coin_turnover` unchanged.
3. Rename admin level config contract:
   - `points_required` -> `turnover_required`
4. Ensure `level_configs` schema uses `turnover_required`.
5. Ensure internal wording consistently refers to level-up turnover, including error messages.
6. Document downstream impact for Frontend and DevOps before deploy.

## Current State
Most of the implementation already appears to be present in `Games-Labs-User`, including:
- `level_up_turnover`
- `turnover_to_next_level`
- `turnover_required`
- `insufficient level-up turnover: have X, need Y`

However, there is still at least one residual wording mismatch in migration `006` where a seed comment still refers to `points`. This means the task should receive a final consistency pass before going to review.

## Acceptance Criteria
- `GET /users/{id}/stats` no longer returns `points`
- `GET /users/{id}/stats` no longer returns `points_to_next_level`
- `GET /users/{id}/stats` returns `level_up_turnover`
- `GET /users/{id}/stats` returns `turnover_to_next_level`
- `coin_turnover` remains unchanged
- `PUT /level-configs/{level}` accepts `turnover_required` instead of `points_required`
- Admin level config responses return `turnover_required`
- Database schema / migration `006` uses `turnover_required`
- Internal code/comments consistently use turnover terminology for level progression
- Validation and business errors use `insufficient level-up turnover: have X, need Y`
- Frontend-visible API contract changes are documented for downstream consumers before deploy

## Technical Notes
- This is an API contract change, not only an internal refactor.
- Rename only the level progression concept; do not rename unrelated fields such as `coin_turnover`.
- Preserve existing business logic and calculations. Only naming and wording should change.
- Perform a final grep pass for legacy `points` references in relevant level-system code and migrations before review.

## Coordination Notes
- Frontend must update:
  - `points` -> `level_up_turnover`
  - `points_to_next_level` -> `turnover_to_next_level`
  - `points_required` -> `turnover_required`
- DB Admin / DevOps should ensure migration `006` is deployed in the correct order because schema wording changed.

## Next Action
- Run `dev` for a final cleanup / verification pass, then hand off to `reviewer`.
