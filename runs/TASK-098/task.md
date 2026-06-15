# TASK-098: Backoffice redemption Update endpoints get 405 (Method Not Allowed) after shared-lib POST→PUT switch

## Short name
`backoffice-redemption-update-put`

## Type
bugfix

## Priority
high

## Parent / Epic
- Parent: TASK-081 (UpdateRedemptionItem wiring)
- Epic: Redemption admin management

## Status
Diagnosed. Code change scoped, ready to apply.

## Background

User reported on Items / Edit page (`admin/manage/redemption/items/edit`):
pressing **Edit → Update** returns `Method Not Allowed`.

Live probe of the deployed gateway confirmed the route exists with **PUT**, not POST.

The frontend was wired against shared-lib commit `c43ef49` (TASK-081, Jun 8–11),
where `UpdateRedemptionItem` was bound to `POST /api/v1/admin/redemption-items/{id}`.

Shared-lib commit `260f4ac` (Jun 12) "change UpdateMissionConfigAlias and related
endpoints from POST to PUT" flipped four admin-order endpoints from POST → PUT:
- `UpdateRedemptionItem`  → `PUT /api/v1/admin/redemption-items/{id}`
- `UpdateRedemptions`     → `PUT /api/v1/admin/redemptions/{id}`
- `UpdateTags`            → `PUT /api/v1/admin/redemptions-tags/{id}`
- `UpdateSpecialItem`     → `PUT /api/v1/admin/special-items/{id}`

The deployed `api-gateway` pins shared-lib `c2ee35cb5a67` (post-260f4ac), so the
grpc-gateway runtime now registers these routes with `http.MethodPut` only —
POST returns 405. Confirmed in
`shared-lib/proto/admin/adminorderpb/adminorder.pb.gw.go:1199,1671`
(`mux.Handle(http.MethodPut, pattern_AdminOrderService_UpdateRedemptionItem_0, …)`).

The Games-Labs-backoffice wiring for these four Update calls was not updated when
the contract flipped, so every save action against them now returns 405.

## Affected files (Games-Labs-backoffice)

1. `app/pages/admin/manage/redemption/items/edit/[id].vue:588`
   `POST ${itemsApiUrl}/${id}` → must be PUT.  Comment at lines 27–28 also
   references POST and needs updating.
2. `app/pages/admin/manage/redemption/library/brand/[id].vue:191`
   `POST ${redemptionsApiUrl}/${b.id}` → must be PUT (UpdateRedemptions).
3. `app/pages/admin/manage/redemption/library/index.vue:748`
   `POST ${redemptionsApiUrl}/${id}` → must be PUT (UpdateRedemptions; brand edit modal).
4. `app/pages/admin/manage/redemption/library/index.vue:808`
   `POST ${redemptionTagsApiUrl}/${id}` → must be PUT (UpdateTags; tag edit modal).

Out of scope: the other POST calls in those files are *create* operations
(`POST /api/v1/admin/redemption-item`, `/admin/redemptions`,
`/admin/redemptions-tags`). The Create endpoints remain POST per the proto.

## Acceptance criteria

- [ ] All four Update endpoints in the redemption admin pages use `method: 'PUT'`.
- [ ] Existing GET/POST (create) calls in these files are unchanged.
- [ ] `nuxi typecheck` for `Games-Labs-backoffice` is no worse than `main`.
- [ ] Smoke (operator with a valid staff token):
      Items/edit/{id} → Edit → change a field → Update → 200 + "Updated item successfully".
- [ ] `ai-dev-office/validate-yaml.rb TASK-098` passes.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-backoffice` | Flip the 4 Update calls from POST to PUT. |
| `shared-lib` | No change. PUT is the intended contract. |
| `api-gateway` | No change. Already serves PUT for these routes. |
| `Games-Labs-Order` | No change. gRPC handlers don't gate on HTTP method. |

### Explicitly out of scope

- Reworking the create flow.
- Touching `special-items` (no frontend Update wiring exists yet).
- Backend changes — proto contract is correct.

## Technical plan

1. Edit the four lines + the stale "POST" docstring in items/edit/[id].vue.
2. Run `nuxi typecheck` and confirm no new errors in touched files.
3. Operator smoke (only step that needs a real staff token).
4. Validate YAML.

## Assignment

- Primary: `dev`
- Parallel: `false`

Scoped via the Claude manual advisory lane (not a configured runner).
