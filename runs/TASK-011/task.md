# TASK-011: Create API Gateway & Order Services Postman Collection

## Type
feature

## Priority
medium

## Description
Create a centralized Postman collection for the new package catalog and payment flows exposed through `api-gateway`.

The collection must cover the user-facing package endpoints, admin package management endpoints, and payment confirmation/webhook endpoints that were introduced during the PKG architecture work. Request URLs, auth expectations, query parameters, and JSON bodies must match the current gateway routing plus the underlying OpenAPI or handler definitions.

## Scope
### Target Services
- `api-gateway` for the externally exposed HTTP routes, auth expectations, and final collection location.
- `Games-Labs-Order` for concrete handler behavior and payload fields used by order and webhook flows.
- `shared-lib` for generated OpenAPI specs that define the admin/order request schemas and HTTP annotations.

### Expected Artifact
- Create `api-gateway/docs/Games-Labs-APIs.postman_collection.json` in Postman Collection v2.1.0 format.

## Acceptance Criteria
- A new collection file named `Games-Labs-APIs.postman_collection.json` exists under `api-gateway/docs/` and declares the Postman v2.1.0 schema.
- The collection includes requests for:
  - `GET /api/v1/order-packages`
  - `GET /api/v1/order-packages/{id}`
  - `GET /api/v1/admin/order-packages`
  - `POST /api/v1/admin/order-packages`
  - `PUT /api/v1/admin/order-packages/{id}`
  - `DELETE /api/v1/admin/order-packages/{id}`
  - `POST /api/v1/orders/{id}/confirm-payment`
  - `POST /webhooks/payment-callback`
- User endpoints are configured to use `{{user_token}}` and admin endpoints use `{{admin_token}}`.
- Collection variables include at least `{{base_url}}`, `{{admin_token}}`, and `{{user_token}}`; additional payment-related variables may be added if needed by gateway auth.
- Query params and request bodies are aligned with current definitions in `api-gateway`, `Games-Labs-Order`, and `shared-lib/proto`.
- Example payloads are usable by QA/frontend/payment teams without further guessing about path params, auth headers, or JSON shape.

## Technical Plan
1. Verify exact route ownership and auth requirements in `api-gateway/gateway/http.go`.
2. Verify request schemas and path parameters from:
   - `shared-lib/proto/admin/adminorderpb/adminorderpb.swagger.json`
   - `shared-lib/proto/orderpb/order.swagger.json`
   - `Games-Labs-Order/internal/core/handlers/orderhdl/http.go`
3. Create the collection with clear folders for user package APIs, admin package APIs, and payment APIs.
4. Add reusable variables and sample headers for bearer auth and webhook API-key auth.
5. Validate the generated JSON structure and confirm every requested endpoint is represented exactly once in the collection.

## Risks
- `api-gateway` protects payment endpoints with API-key auth instead of bearer auth, so the collection may need extra variables beyond the originally requested three.
- Some request field names are easier to verify from handlers/OpenAPI than from task text alone; implementation should treat code/spec as source of truth.
- There is already a missions-specific Postman collection, so naming and location should avoid implying that legacy collections are replaced unless intended.

## Assignment
- Primary agent: `dev`
- Parallel: `false`
- Reason: The deliverable is a focused documentation artifact with one main output file, even though it must be validated against multiple services.

## Next Action
- Run `dev` to inspect the specs/handlers, create the collection, and hand off to `reviewer`.
