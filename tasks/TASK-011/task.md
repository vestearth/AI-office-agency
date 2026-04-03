# TASK-011: Create API Gateway & Order Services Postman Collection

## Description
With the completion of the "Purchase Packages Architecture" (PKG series), we have introduced several new endpoints across `Games-Labs-Order` and `Games-Labs-Wallet`, all exposed via `api-gateway`. 

To facilitate testing for QA, frontend teams, and the payment team, we need a comprehensive and updated Postman Collection. Currently, only `Games-Labs-Missions.postman_collection.json` exists. We should create a centralized collection for the new ecosystem.

## Objectives
1. **Create a New Postman Collection**: Generate a `Games-Labs-APIs.postman_collection.json` file (preferably located in the `docs/` or `api-gateway/docs/` directory).
2. **Add User APIs**:
   - `GET /api/v1/order-packages` (List active packages)
   - `GET /api/v1/order-packages/{id}` (Get specific package)
3. **Add Admin APIs**:
   - `GET /api/v1/admin/order-packages` (List all packages)
   - `POST /api/v1/admin/order-packages` (Create package)
   - `PUT /api/v1/admin/order-packages/{id}` (Update package)
   - `DELETE /api/v1/admin/order-packages/{id}` (Deactivate package)
4. **Add Payment Webhook / Order APIs**:
   - `POST /api/v1/orders/{id}/confirm-payment`
   - `POST /webhooks/payment-callback`
5. **Add Environment Variables**: Include template variables in the collection like `{{base_url}}`, `{{admin_token}}`, and `{{user_token}}` to make it easy to switch environments.

## Technical Requirements
- Inspect the generated OpenAPI specs inside `shared-lib/proto` or the explicit HTTP handlers in `Games-Labs-Order` and `api-gateway` to ensure paths and payload structures match 100%.
- Ensure JSON structure conforms to Postman v2.1.0 format.

## Assigned Agent
`dev`