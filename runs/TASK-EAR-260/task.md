# TASK-EAR-260: Persist Redemption Item Code Name

## Type

Bugfix

## Workstream

Backend / API contract / frontend

## Priority

High

## Goal

Make the E-Voucher `Code Name` entered in Backoffice persist through create and
update, return from the admin redemption-item API, and hydrate on the edit page.

## Confirmed Defect

- Backoffice requires `Code Name`, sends `code_name`, and tries to hydrate
  `codeName`/`code_name`.
- `adminorderpb.CreateRedemptionItemRequest`,
  `adminorderpb.UpdateRedemptionItemRequest`, and `orderpb.RedemptionItem` do not
  define the field.
- Order models, repository SQL, and the `redemption_items` schema do not persist
  it.
- Existing values entered before this fix are not recoverable from the current
  API/database path; a legacy-row policy is required.

## Scope

| Repository | Files / responsibility |
| --- | --- |
| `shared-lib` | Add additive `code_name` protobuf fields and regenerate Go, gRPC-gateway, and Swagger artifacts. |
| `Games-Labs-Order` | Add a migration, model/handler/repository mapping, validation, and focused tests. |
| `api-gateway` | Bump to the published shared-lib version and verify the generated HTTP JSON contract. |
| `Games-Labs-backoffice` | Hydrate the returned field, send the supported JSON field, handle legacy empty values honestly, and add focused regression coverage. |

## Acceptance Criteria

- Create and update request contracts accept `codeName`/`code_name` without changing existing field numbers.
- `GET /api/v1/admin/redemption-items/{id}` returns the persisted code name.
- Order stores the value in a migration-backed `redemption_items.code_name` column.
- Creating an E-Voucher with a Code Name, reopening Edit, and reading Setting shows the same value.
- Updating unrelated fields on a legacy row does not fail solely because the historical Code Name was never stored; the chosen legacy policy is documented and tested.
- Existing clients remain compatible with the additive fields.
- Generated artifacts are regenerated, not edited manually.
- No consumer commits a local `replace` directive; `go.mod` and `go.sum` move together after the shared-lib publication.
- Focused shared-lib, Order, gateway, and Backoffice checks pass, with runtime verification reported separately from source verification.

## Ordered Plan

1. Add `code_name` additively to the shared response and admin create/update request messages; regenerate and verify `shared-lib`.
2. Publish `shared-lib`; record the commit/pseudo-version.
3. Bump Order and gateway to that published version (`GOWORK=off`, no local `replace`).
4. Add the Order migration, model/handler/repository mapping, validation, and tests.
5. Update Backoffice hydration/update behavior and regression tests.
6. Verify create, Save, reload persistence, and source/target state on an authenticated environment before calling the bug fixed at runtime.

## Risks And Decisions

- The contract change is additive and wire-compatible, but new clients must tolerate an empty field while old servers are still deployed.
- Existing values were never stored. Do not fabricate them from item name or voucher codes; use an explicit legacy-row policy.
- Downstream implementation is gated on publishing `shared-lib` first.

## Assignment

- Primary: `dev-2`
- Execution: sequential, because shared-lib publication and dependency bumps are hard gates.

