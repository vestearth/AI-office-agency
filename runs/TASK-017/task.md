# TASK-017: Expose Missions via gRPC + grpc-gateway (missionspb) and register in api-gateway

## Type
feature

## Priority
medium

## Description
Missions APIs (missions, levels, store, admin) should be reachable through the same **api-gateway** entry point and documented alongside other services.

### Current implementation status (updated 2026-04-09)
Work was **implemented ahead of the formal dev-2 assignment** (in-repo Cursor agent). As of this update:

- **`shared-lib/proto/missionspb`**: `MissionsService` with `/api/v1/...` HTTP annotations; **`make buf`** artifacts present (`missions.pb.go`, grpc, grpc-gateway, Swagger JSON → `swagger.pb.go`).
- **`Games-Labs-Missions`**: `cmd/main.go` calls **`routes.RegisterAPIV1`**, passes mux into **`missiongrpc.Server`**, starts **gRPC** on **`config.GRPCAddr()`** (default **`:50056`**) and **HTTP** on **`MISSIONS_PORT`** / `:8086`. **Legacy root paths** (`/missions/...`, `/store/...` without `/api/v1`) **are no longer registered** — clients must use **`/api/v1/...`** on the Missions HTTP port or go through the gateway.
- **`api-gateway`**: **`missionspb.RegisterMissionsServiceHandlerFromEndpoint`** registered in **`gateway/grpc.go`**; **`missionspb.Swagger`** in **`gateway/docs/docs.go`** (`/missions/swagger/index.html`).
- **Deploy samples**: `api-gateway/k3s/configmap.yaml`, `api-gateway/.github/workflows/deploy.yml`, `Games-Labs-Missions/k3s/deployment.yaml` + **`service.yaml`** expose **gRPC 50056**; **`MISSION_API_URL`** is intended as **gRPC upstream** (e.g. `http://games-labs-missions-service:50056`).
- **`go.mod`**: **`replace github.com/SparqLab/shared-lib => ../shared-lib`** in **api-gateway** and **Games-Labs-Missions** for monorepo builds until a new **shared-lib** module version is published.

**Path strategy (locked):** Public contract is **`/api/v1/missions/...`**, **`/api/v1/levels/...`**, **`/api/v1/store/...`**, **`/api/v1/admin/...`**. Store webhook path is **`POST /api/v1/webhooks/store-payment`** (replaces old `/webhooks/payment` on Missions HTTP).

**Config note:** gRPC-Gateway dials **gRPC** (default **50056**), not HTTP **8086**. Env name remains **`MISSION_API_URL`** in gateway config; document clearly that it must be **host:port of gRPC**.

**Known gaps (post dev-2 2026-04-09)**
- **Module release**: Remove **`replace`** after tagging/publishing **shared-lib**; bump **`require`** in consumers.
- **E2E**: `e2e-smoke.md` documents curl + headers; run against a live stack in review/staging.
- **`POST /api/v1/missions/{id}/claim-reward`**: Gateway maps **`userid`**, **`X-User-ID`**, or **`x-user-id`** to gRPC metadata → Missions **`X-User-ID`**; Postman request includes **`userid`**.
- Optional: add **`MISSION_GRPC_URL`** alias in config docs only (if teams want explicit naming vs reusing **`MISSION_API_URL`**).

## Scope
- `shared-lib/proto/missionspb/` — only if RPC annotations or messages must change; then regenerate (`make buf` in shared-lib).
- `Games-Labs-Missions/` — follow-up fixes only if integration tests fail.
- `api-gateway/` — follow-up (auth header matcher, docs).
- **Postman**: `api-gateway/docs/Games-Labs-APIs.postman_collection.json` + `docs/Games-Labs-APIs.postman_collection.json` — **primary remaining deliverable**.

## Acceptance Criteria
- [x] Missions process listens for **gRPC** on the configured address (default **:50056**) and serves **`missionspb.MissionsService`**.
- [x] The HTTP handler tree passed into **`missiongrpc.Server`** includes **`RegisterAPIV1`** routes.
- [x] **api-gateway** registers **`missionspb.RegisterMissionsServiceHandlerFromEndpoint`** using env pointing to **Missions gRPC** host:port; **`go build`** passes (with local **`replace`**).
- [x] Minimal **documented E2E**: `ai-dev-office/runs/TASK-017/e2e-smoke.md` (curl example; run on live stack in review).
- [x] Swagger: **`/missions/swagger/index.html`** serves **`missionspb.Swagger`**.
- [x] Postman Missions requests use **`{{base_url}}`** and **`/api/v1/...`** (`api-gateway/docs/` and **`docs/`** copies).
- [ ] **shared-lib** published / **`replace`** removed from consumer **`go.mod`** files for CI that lacks sibling checkout.

## Next Action
**reviewer**: **`make test` / lint** on **`api-gateway`**; optionally run **`e2e-smoke.md`** curl; confirm Postman import. **`shared-lib` publish / `replace` removal** remains with **PM/DevOps** after tag.
