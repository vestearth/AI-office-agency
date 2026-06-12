# TASK-094: Wire Backoffice store/packages to AdminOrderService CRUD

## Short name
`store-packages-api-wiring`

## Type
feature

## Priority
high

## Parent / Epic
- Epic: Backoffice admin API wiring (sibling of TASK-079/080/081 redemption wiring)

## Status

Review (2026-06-12) found the store/packages pages half-wired: the list page calls
`GET /api/v1/admin/order-packages` but everything else is mock. The Create modal
only unshifts into an in-memory array; the Edit page hydrates from query-string +
localStorage (`backoffice-store-packages-v1`) that the list no longer writes, so
Update always fails with "No package data found." Backend CRUD is fully
implemented (ListPackages/GetPackage/CreatePackage/UpdatePackage/DeletePackage,
`PERM_ORDER_MANAGEMENT`), exposed via grpc-gateway. Only the image-upload kind
and the coupon flag need new surface.

## Scope

### A. Backoffice — `app/pages/admin/manage/store/packages/edit/[id].vue`
- Load via `GET /api/v1/admin/order-packages/{id}` on mount; drop query-string/
  localStorage hydration.
- Save via `PUT /api/v1/admin/order-packages/{id}` (full upsert — spread the
  loaded package, then override edited fields, so code_name/category/sort_order/
  bonus_percent round-trip losslessly).
- Thumbnail: upload on pick via `/admin/uploads/order-packages`, persist as
  `image_url`; render `imageUrl` from API.

### B. Backoffice — `app/pages/admin/manage/store/packages/index.vue`
- Create modal submits `POST /api/v1/admin/order-packages`, then refetches the
  list (no client-side unshift).
- `code_name`: auto-generate slug from package name; surface backend
  DuplicatePackageCode error.
- Render `imageUrl` from the API in the table (static fallback only when empty).

### C. Upload kind `order-packages` (3 spots, same pattern as redemptions)
- `api-gateway/gateway/http.go`: `POST /admin/uploads/order-packages` proxy.
- `Games-Labs-Order adminorderhdl.go s3UploadPrefix`: case `/uploads/order-packages`.
- Backoffice `useImageUpload.ts`: extend `UploadKind`.

### D. Field-mapping decisions (agreed in review)
- `type`: send `"purchase"` (ParsePackageType accepts model value, case-insensitive).
- `currency`: always send explicitly from the dropdown (no reliance on THB default).
- `vip_level` int: `All`→0, `9+`→9, `7+`→7, `5+`→5.
- Sale window: send `effective_at`/`expires_at` XOR `is_all_time` — never both;
  both dates empty → backend auto-sets all-time.
- Coupon flag + display type: store in `metadata_json`
  (`{"couponEligible": bool, "displayType": "Custom"|"Default"}`); promote to a
  real field only if order-side logic needs to query it. List page prefers
  `metadataJson.displayType`, falls back to legacy `category === 'hot'` mapping.

## Acceptance Criteria

- [ ] Edit page loads real data by id from the API; no localStorage/query state.
- [ ] Update persists via PUT and survives reload; status toggle works.
- [ ] Create modal POSTs; new package appears after list refetch; duplicate
      code_name shows the backend error, not a silent failure.
- [ ] Thumbnails upload through `/admin/uploads/order-packages` and render from
      `imageUrl` everywhere.
- [ ] `nuxi typecheck` clean (backoffice); `go build ./...` clean (gateway, Order).

## Assignment

- Primary: `dev`
- Parallel: `false`
