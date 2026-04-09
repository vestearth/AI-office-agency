# TASK-017 — E2E smoke (Missions via api-gateway)

## Prerequisites

1. **Missions** (`Games-Labs-Missions`) running with gRPC on the address used by the gateway (default **`:50056`**). HTTP on `:8086` is optional for this check.
2. **api-gateway** running with **`MISSION_API_URL`** set to that **gRPC** endpoint (example: `http://127.0.0.1:50056` or `games-labs-missions-service:50056` in-cluster).

## Example request

Public, read-only route (no auth in many environments — confirm for yours):

```bash
curl -sS "http://localhost:8080/api/v1/missions/tournaments"
```

Expect HTTP **200** and a JSON body shaped by the service (or a documented error if the missions DB is unavailable).

## Authenticated / user-scoped routes

Calls such as **`POST /api/v1/missions/{id}/claim-reward`** expect a user id on the upstream HTTP handler. Through the gateway, send any of:

- Header **`userid`**: `<uuid>` (preferred; matches existing gateway metadata mapping), or
- **`X-User-ID`** / **`x-user-id`** (also mapped to gRPC metadata and bridged to Missions as **`X-User-ID`**).

## Local smoke status (dev-2)

- **Not executed** in this workspace: Missions + gateway were not started here.
- **Reviewer** should run the curl (or Postman **List tournaments**) against a live local or staging stack and note the result in review output if needed.
