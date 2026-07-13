# TASK-EAR-107: Publish canonical catalog and VIP identity contracts

Parent `TASK-EAR-100`; epic: Store Items canonical catalog rollout. Feature/backend/high; owner `dev-2`.

## Outcome

Publish one backward-compatible `shared-lib` release that gives service consumers:

- a complete non-admin Order special-item list/get contract, including canonical UUID, type, price/currency, status, sale window, duration/pass metadata, collection data and required VIP catalog UUID;
- explicit lookup by canonical ID or approved legacy alias, with stable not-found/inactive/ineligible errors; and
- a stable UUID-backed VIP catalog identity on User profile/VIP responses while preserving the existing numeric `level` fields and routes.

Do not redefine existing numeric IDs or manually edit generated artifacts. This task is the publication gate: Order and User implementations must not start their downstream dependency bumps until the release version is published and recorded.

## Scope

- `shared-lib/proto/web/weborderpb/weborder.proto` and generated WebOrder Go/gRPC/gateway/Swagger artifacts.
- `shared-lib/proto/userpb/userpb.proto` and generated User Go/gRPC/gateway/Swagger artifacts.
- Shared business errors only when the new RPCs cannot reuse an existing stable error.

## Acceptance criteria

- WebOrder exposes complete catalog list and ID-or-alias lookup without exposing AdminOrder APIs.
- User responses expose an additive stable VIP catalog UUID; existing numeric level fields and routes remain compatible.
- Proto field numbers are additive, generated artifacts are current, and contract tests cover serialization and HTTP mappings.
- `go test ./...`, `go build ./...`, proto validation/generation checks and `git diff --check` pass in `shared-lib`.
- The merged/published shared-lib version is recorded for `TASK-EAR-108`, `TASK-EAR-109` and `TASK-EAR-110`; no consumer uses a local `replace`.

## Plan

1. Add the smallest complete WebOrder catalog messages/RPCs and stable error semantics.
2. Add UUID-backed VIP catalog identity fields without changing numeric level behavior.
3. Regenerate all affected artifacts and add focused compatibility tests.
4. Hand off for merge/publication; record the published version before unblocking consumers.

## Risks

- Changing the meaning of `VIPLevel.id` would break admin numeric routes; add a new catalog UUID field instead.
- A partial catalog projection would let Missions reintroduce client-authoritative checks; contract tests must assert every purchase-validation field.
- Downstream work against unpublished generated code violates workspace dependency policy; keep consumers blocked until publication evidence exists.

## Dependencies

None. This is the first child of `TASK-EAR-100`.

## Published dependency

- Merged PR: `SparqLab/shared-lib#16`
- Merge commit: `64c2276be26640d20f0ab94532bb88031cd98099`
- Go module version: `v0.0.0-20260713083006-64c2276be266`
- Verified with `go list -m -json` on 2026-07-13.
