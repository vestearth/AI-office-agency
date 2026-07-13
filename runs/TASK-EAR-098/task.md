# TASK-EAR-098: Implement Store Items AdminOrder backend and upload surface

Parent: `TASK-EAR-096`; depends on published `TASK-EAR-097`.  
Epic: Store Items canonical catalog rollout. Type/workstream/priority: feature/backend/high. Owner: `dev-2`.

## Outcome and scope

Consume the published shared-lib version in `Games-Labs-Order` and `api-gateway`; implement approved Admin Get/List/Create/Update behavior, validation and persistence, plus a permission-protected `special-items` upload kind. Verify migrations 019/021 and add new migration only for fields approved by TASK-EAR-096.

Affected: `Games-Labs-Order/internal/models/special_item.go`, `internal/core/repositories/special_item.go`, `internal/core/services/ordersvc/**`, `internal/core/handlers/adminorderhdl/adminorderhdl.go`, migrations/tests, `Games-Labs-Order/go.mod/go.sum`, `api-gateway/gateway/http.go`, `api-gateway/gateway/grpc.go`, `api-gateway/go.mod/go.sum`.

## Acceptance criteria

- List/Get/Create/Update round-trip all approved fields with UUID and sale-window validation.
- Pass Collection behavior, VIP level UUID and item-type validation match TASK-EAR-096.
- Upload accepts only allowed image MIME/size and requires staff permission.
- Existing Website special-pass/avatar list behavior does not regress.
- Both consumers use the published shared-lib version; tidy and readonly builds pass with no replace.
- Focused repository/service/handler tests cover successful and invalid writes.

## Publication evidence — 2026-07-13

- Order PR 11 merged at commit `724d857733696dbaf1096792020e97136974c5b8`.
- API Gateway PR 12 merged at commit `c6516e6de775c4c98732ecc3ed36f636631364e2`.
- Reviewer requested explicit Update tests after PR 11 merged.
- Test-only follow-up Order PR 12 contains commit `121be8078aa2ab3255f6843f6819862889caa9f0`.
- Test-only Order PR 12 merged at commit `99fea81643ef2aa4aef754904be684f852e7c941`;
  `121be8078aa2ab3255f6843f6819862889caa9f0` is an ancestor of `origin/staging`.
