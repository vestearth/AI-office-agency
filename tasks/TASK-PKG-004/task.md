# TASK-PKG-004: API Gateway Integration for Package & Order Services

## Description
With the core backend for the "Purchase Packages Architecture" now fully implemented (Order Catalog, Fulfillment Engine, Wallet Engine, and Payment Webhook), the final step to expose these features to frontend applications and third-party payment providers is configuring the API Gateway. 

The `api-gateway` service must act as the reverse proxy for these new endpoints, enforcing proper authentication and Role-Based Access Control (RBAC).

## Objectives

1. **User-Facing APIs**:
   - Expose endpoints to list active packages and view package details (e.g., `GET /api/v1/order-packages`).
   - Secure these endpoints with standard user **JWT Authentication Middleware**.

2. **Admin APIs**:
   - Expose the Package Catalog CRUD endpoints (`POST, PUT, DELETE /api/v1/admin/order-packages`).
   - Protect these endpoints strictly using **Admin RBAC Middleware**. This resolves the earlier tech debt where authorization was handled inside the handler code instead of the gateway.

3. **Payment Webhooks**:
   - Expose the payment callback/confirmation endpoints (e.g., `POST /webhooks/payment-callback` and `POST /api/v1/orders/{id}/confirm-payment`).
   - Apply specialized authentication (e.g., Server-to-Server API Keys, or bypass user JWT if handling signature verification in the service layer itself) to allow third-party payment gateways to reach the Order service safely.

## Technical Requirements
- Update `api-gateway/gateway/proxy.go` and `api-gateway/gateway/http.go` (or equivalent routing configuration).
- Map the traffic to the `Games-Labs-Order` internal service address.
- Follow the patterns established in `api-gateway/EXAMPLES.md` regarding `gin` / `mux` handlers and middleware chaining.
- Ensure that CORS and Rate Limiting configurations are suitably applied to the new public endpoints.

## Assigned Agent
`dev`