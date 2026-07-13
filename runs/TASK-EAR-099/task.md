# TASK-EAR-099: Wire Backoffice Store Items vertical slices

Parent `TASK-EAR-096`; blocked by `TASK-EAR-098`. Epic: Store Items canonical catalog rollout. Feature/frontend/high; owner `dev-2`.

Replace all Store Items, Collection, Avatar and Pass seed/local UI mutations with AdminOrder APIs. Deliver sequentially: Collections + Avatar first, then Pass using only TASK-EAR-096-approved fields. Load real VIP/Game lookups, upload images on explicit submit, re-fetch after writes, and preserve loading/error/empty states.

Affected files: `Games-Labs-backoffice/app/pages/admin/manage/store/items.vue`, `store/avatar/edit/[id].vue`, `store/pass/edit/[id].vue`, `app/composables/useImageUpload.ts`, and a focused Store Items API composable/tests.

Acceptance: real UUID list/create/get/update; reload and second session see DB state; no seed/mock persistence; Pass fields never silently drop; active eligible Avatar/Pass appears through Website APIs; lint/typecheck/build and browser smoke pass or exact blockers are recorded.

