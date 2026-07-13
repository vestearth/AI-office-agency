# TASK-EAR-104: Wire Backoffice Promotion Coupon to AdminOrder

Parent `TASK-EAR-101`; blocked by `TASK-EAR-103`. Feature/frontend/high; `dev`.

Replace Coupon seed/localStorage behavior with AdminOrder List/Get/Create/Update/Delete and real Package, VIP and Special Item lookups. Use server search/date/pagination, real UUIDs, approved status/cap/quota fields, loading/error/empty states and re-fetch after each write.

Affected: `Games-Labs-backoffice/app/pages/admin/manage/promotion/coupon.vue`, `promotion/coupon/edit/[id].vue`, a coupon API composable and focused tests.

Acceptance: both coupon types persist across reload/second session; no localStorage key or seed IDs; lookup filtering uses eligible active records; server pagination/filtering; stable errors surfaced; Backoffice checks and staging browser CRUD smoke pass.

