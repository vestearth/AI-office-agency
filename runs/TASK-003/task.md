# TASK-003: Implement Roles & Permissions in VerifyToken and Add Unit Tests

## Overview
The current `VerifyToken` implementation in `Games-Labs-Auth/internal/core/services/authsvc/service.go` returns empty slices for Roles and Permissions, even when a session is valid. This prevents the API Gateway and downstream services from performing RBAC/ABAC correctly.

## Type
bugfix | feature

## Priority
high

## Target Service
Games-Labs-Auth

## Target Files
- `internal/core/services/authsvc/service.go`
- `internal/core/ports/repositories.go` (if repository updates needed)
- `internal/core/services/authsvc/service_test.go` (to be created)

## Description
1. Create a database migration to add `roles` and `permissions` support. At minimum:
   - A `user_roles` table linking users to roles.
   - A `role_permissions` table (optional if roles have fixed permissions for now, but better to have).
   - Alternatively, add a `roles` JSONB or array column to the `users` table for simplicity if appropriate.
2. Update `AuthRepo` port and implementation to fetch Roles and Permissions during `VerifyToken` or `Login`.
3. Update `VerifyToken` in `service.go` to return the fetched Roles and Permissions.
4. Create a unit test file `service_test.go` to verify the end-to-end flow.

## Acceptance Criteria
- [ ] Database migration for roles/permissions is created and applied.
- [ ] `AuthRepo` can fetch user roles and permissions.
- [ ] `VerifyToken` returns the user's roles and permissions from the database.
- [ ] `service_test.go` covers `VerifyToken` with valid/invalid/expired cases.
- [ ] No regression in `Login`, `Logout`, or `RefreshToken`.
