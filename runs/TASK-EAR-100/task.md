# TASK-EAR-100: Make Mobile consume the canonical Store Items catalog

Parent `TASK-EAR-096`; blocked by `TASK-EAR-098`. Epic: Store Items canonical catalog rollout. Feature/backend/high; `dev-2`.

Replace Missions duplicate Pass/Avatar catalog reads with the TASK-EAR-096-approved canonical Order API contract while preserving Missions-owned purchase/grant/inventory behavior. Never trust client `price_diamonds`; resolve item, price, status, VIP and sale window server-side. Define stable ID compatibility, idempotency and retry behavior; do not access Order DB directly.

Affected: `shared-lib/proto/missionspb/missions.proto` only if the approved client response must change (then publish first); `Games-Labs-Missions/internal/services/store_service.go`, `internal/handlers/mission/http/store.go`, repository/client wiring and tests; downstream dependency files if changed.

Acceptance: Mobile list/buy use one catalog; no duplicate seed/catalog authority; server-authoritative price; inactive/expired/ineligible rejected; stable owned-item identity preserved; duplicate submit safe; list-buy-inventory tests and readonly build pass.

## Registered dependency split — 2026-07-13

| Task | Outcome | Dependency | Execution |
| --- | --- | --- | --- |
| `TASK-EAR-107` | Publish complete Order catalog/alias and stable User VIP identity contracts | none | first, sequential publication gate |
| `TASK-EAR-108` | Implement/deploy Order catalog lookup, aliases and deterministic legacy backfill | published `TASK-EAR-107` | may run in parallel with `TASK-EAR-109` |
| `TASK-EAR-109` | Implement/deploy stable User VIP catalog UUID and Store Item selector compatibility | published `TASK-EAR-107` | may run in parallel with `TASK-EAR-108` |
| `TASK-EAR-110` | Integrate Missions list/buy/inventory and durable retry semantics; retire duplicate authority | deployed `TASK-EAR-108` and `TASK-EAR-109` | final sequential lane |

Order remains catalog owner, User remains VIP identity owner, and Missions remains debit/grant/inventory owner. No child may introduce a direct cross-service database read.
