# TASK-EAR-100: Make Mobile consume the canonical Store Items catalog

Parent `TASK-EAR-096`; blocked by `TASK-EAR-098`. Epic: Store Items canonical catalog rollout. Feature/backend/high; `dev-2`.

Replace Missions duplicate Pass/Avatar catalog reads with the TASK-EAR-096-approved canonical Order API contract while preserving Missions-owned purchase/grant/inventory behavior. Never trust client `price_diamonds`; resolve item, price, status, VIP and sale window server-side. Define stable ID compatibility, idempotency and retry behavior; do not access Order DB directly.

Affected: `shared-lib/proto/missionspb/missions.proto` only if the approved client response must change (then publish first); `Games-Labs-Missions/internal/services/store_service.go`, `internal/handlers/mission/http/store.go`, repository/client wiring and tests; downstream dependency files if changed.

Acceptance: Mobile list/buy use one catalog; no duplicate seed/catalog authority; server-authoritative price; inactive/expired/ineligible rejected; stable owned-item identity preserved; duplicate submit safe; list-buy-inventory tests and readonly build pass.

