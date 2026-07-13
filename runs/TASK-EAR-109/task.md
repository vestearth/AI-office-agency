# TASK-EAR-109: Implement stable User VIP catalog identity

Parent `TASK-EAR-100`; blocked by published `TASK-EAR-107`. Epic: Store Items canonical catalog rollout. Feature/backend/high; owner `dev-2`.

## Outcome

Give every User-owned VIP level an immutable UUID catalog identity while preserving its numeric progression level. Expose that UUID through the published User/AdminUser responses and profile lookup, backfill existing levels deterministically, and update Store Items lookup consumers to submit the UUID rather than the numeric admin route ID.

## Scope

- User level model/repository/service/handlers, migration runner, tests and published shared-lib bump.
- Backoffice VIP row mapping plus Store Avatar/Pass selectors so new catalog writes use the stable UUID field.
- No Order files; this lane is parallel-safe with TASK-EAR-108 after TASK-EAR-107 publishes.

## Acceptance criteria

- Every existing and newly created level has a non-empty immutable unique UUID catalog ID; numeric `level` remains the progression key.
- GetProfile and VIP/Admin list/get responses return the correct catalog UUID without changing existing numeric route behavior.
- Backoffice Store Item selectors show human-readable VIP levels but send the UUID catalog ID to Order.
- Missing/inactive level semantics are explicit and tests cover backfill, create/update immutability and profile/admin mapping.
- User and Backoffice focused tests/builds plus User readonly Go build pass with a published shared-lib version and no replace.

## Dependencies and rollout

Start only after TASK-EAR-107 is published. Deploy/smoke the User provider and the selector compatibility before TASK-EAR-110. TASK-EAR-108 may run concurrently because file ownership does not overlap.

Published TASK-EAR-107 dependency: `github.com/SparqLab/shared-lib@v0.0.0-20260713083006-64c2276be266` (PR 16 merge commit `64c2276be26640d20f0ab94532bb88031cd98099`).

Published TASK-EAR-111 AdminUser list extension: `github.com/SparqLab/shared-lib@v0.0.0-20260713093515-91c6b7788cac` (PR 17 merge commit `91c6b7788cac6860ac1561d0f9b26a87df2628fd`).
