# TASK-PKG-003: Implement Admin Package CRUD APIs (gRPC & HTTP) in Games-Labs-Order

## Description
This task is for the CRUD operations of Package Catalog used by authorized Administrators to manage the prices, effective windows, and rewards of purchase/exchange packages.

## Objectives
1. **Admin HTTP Handlers**: Implement package endpoints inside `Games-Labs-Order/internal/core/handlers/adminorderhdl`. Must include Create (POST), Update (PUT/PATCH), Read (GET), and Delete/Deactivate (DELETE).
2. **Admin gRPC Handlers**: Create `adminorderpb.proto` if missing, generate code, and implement the gRPC service for package management.
3. **Cleanup Public APIs**: Ensure that the user-facing APIs (`PackageByIDHTTP`, `ListPackagesHTTP`) in `orderhdl` only expose `GET` with active/time-window filters, while `PUT` and `DELETE` are moved solely to `adminorderhdl`.

## Technical Requirements
- Utilize RBAC/auth middleware to protect admin endpoints.
- Ensure the admin application layer interacts gracefully with the existing repository `UpsertPackage`.
- Soft delete (inactive) is preferred over hard delete to retain order history mappings.

## Assigned Agent
`dev`