# TASK-EAR-131: Player status update + admin password reset (real enforcement)

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-07-17

## Goal

Per the phase-2 sign-off (2026-07-17): make the two remaining fake controls
on `admin/manage/player/edit/[id]` real —

1. **Status dropdown** currently toasts "Status updated" without any request
   and no RPC exists. Add `UpdateUserStatus` to AdminUserService
   (Games-Labs-User owns `users.status`).
2. **Reset Password** currently toasts without any request. Auth already
   owns the full reset flow (`ForgotPassword` email-OTP →
   `VerifyResetToken` → `ResetPassword`); add an admin trigger
   `AdminSendPasswordReset` that fires that flow for a player. Email-only —
   the mailer is the only delivery infra (no SMS); the FE SMS option must
   be disabled honestly.
3. **Session gap (approved in-scope)**: Auth `RefreshToken` never re-checks
   `users.status`, and refresh sessions live 7 days vs 1h access tokens —
   a suspended player keeps playing for up to 7 days. Re-check status on
   refresh → suspension takes effect within ≤1h (access-token TTL).

## Facts grounding the design

- Auth reads the same `users` table (shared DB with User service); `Login`
  already rejects `status != "active"` with SuspendedAccess.
- `userRepo.Delete` = soft delete: `status = 'pending_deletion'`,
  `soft_deleted_at = COALESCE(soft_deleted_at, NOW())`. Dropdown "Deleted"
  maps to this path; setting `active` must clear `soft_deleted_at`
  (restore) or a "restored" player stays invisible to ListUser.
- `authRepo.GetUserByID` exists; `RefreshToken` currently discards the
  session row it loads.
- Auth has no staff-gated RPC yet — use shared-lib
  `auth.RequireStaffGRPC(PERM_USER_MANAGEMENT)` like the User service.
- shared-lib #20/#21 are merged to main → new branch cuts from main, no
  stacking needed this time.

## Scope

In:
- shared-lib: `UpdateUserStatus` (adminuserpb,
  `PATCH /api/v1/admin/user/{user_id}/status`, declared after GetUser) +
  `AdminSendPasswordReset` (adminauthpb,
  `POST /api/v1/admin/auth/password-reset`).
- Games-Labs-User: repo `UpdateStatus` (clears `soft_deleted_at` when
  activating), service + handler; statuses
  active|suspended|deactivated|deleted, deleted → existing soft-delete.
- Games-Labs-Auth: staff-gated AdminSendPasswordReset reusing the
  ForgotPassword flow (validate the player has an email — guests may
  not); RefreshToken re-checks `users.status`, rejects non-active with
  SuspendedAccess.
- api-gateway bump; backoffice FE: dropdown → confirm + PATCH + reload,
  Reset Password → real POST, SMS option disabled ("not available").

Out: session revocation event on suspend (refresh-time check per
sign-off), voucher grant (133), Detail page (134), ListUser filters (135).

## Acceptance criteria

- PATCH status persists and reflects in ListUser/GetUser; setting active
  un-deletes; login blocked for suspended/deactivated (existing) and
  refresh now also blocked.
- Admin reset sends the same OTP email the self-service flow sends.
- Builds/tests green in User + Auth; backoffice build green; PRs opened
  (backend → staging, FE → main), links recorded here.
