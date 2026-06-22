# TASK-103: Expose Backoffice package image URLs on Mobile Store packages

## Short name
`mobile-store-packages-image-url`

## Type
bugfix (API response compatibility)

## Priority
high

## Parent / Epic
- Parent: none
- Epic: Store Package Mobile Contract

## Background

Mobile/QA asked two things:

- Confirm whether Store > Packages should use `GET /api/v1/store/packages`.
- Return the image URLs configured in Backoffice so Mobile renders the same
  package art as the Backoffice Store > Package screen.

Verified source evidence:

- `GET /api/v1/store/packages` is the public Mobile Store package endpoint via
  Missions/gRPC-gateway (`shared-lib/proto/missionspb/missions.proto`,
  `Games-Labs-Missions/internal/routes/apiv1.go`).
- Backoffice Store > Package uses Admin Order package APIs:
  `GET/POST/PUT /api/v1/admin/order-packages`.
- Backoffice already uploads package images to `order-packages` and submits
  `imageUrl`.
- Games-Labs-Order already persists and returns `image_url` on order packages.
- Games-Labs-Missions currently maps Order purchase packages into
  `CoinPackage`, but `CoinPackage` does not expose `image_url`, so the Mobile
  `/api/v1/store/packages` response loses the Backoffice image.

## Goal

Make `GET /api/v1/store/packages` and `GET /api/v1/store/packages/{id}` include
the package image URL configured in Backoffice, without changing the endpoint or
removing/renaming existing response fields.

## Scope

### Target repo

| Repo | Reason |
| --- | --- |
| `Games-Labs-Missions` | Public Store endpoint response shape and Order-to-Mobile mapping. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `internal/models/models.go` | modify | Add optional `image_url` field to `OrderPackage` and `CoinPackage`. |
| `internal/services/store_service.go` | modify | Map Order package `image_url` into Mobile Store package response. |
| `internal/services/store_service_test.go` | modify | Add/adjust the smallest test proving `/store/packages` data carries the image URL. |

### Explicitly excluded

- No new endpoint.
- No Backoffice UI changes.
- No Order DB or Admin Order API changes unless source verification shows the
  current `image_url` field is not returned in the active contract.
- No shared-lib proto change for Missions; the endpoint returns
  `google.protobuf.Struct`, so this should be a backward-compatible JSON field
  addition.

## Acceptance Criteria

- [ ] `GET /api/v1/store/packages` returns each package with `image_url` when
      the backing Order package has one.
- [ ] `GET /api/v1/store/packages/{id}` returns the same `image_url` for the
      selected package.
- [ ] Existing response fields remain unchanged: `id`, `name`, `category`,
      `price_thb`, `diamonds`, `coin`, `active`.
- [ ] If `image_url` is empty, the field may be empty/omitted according to the
      existing JSON pattern, but clients must not need a fallback endpoint.
- [ ] Focused Missions tests cover the Order-catalog mapping path.
- [ ] Run `go test ./internal/services/...` or the narrowest equivalent that
      covers the changed code; document if broader tests are skipped.

## Notes

- Handoff answer for FE/Mobile: `GET /api/v1/store/packages` is correct for
  Mobile Store packages. This task only adds the missing image URL field from
  the existing Backoffice/Admin Order package source.
- Keep the change additive and boring. Do not introduce a new response wrapper
  or alias field unless a current client contract requires it.
