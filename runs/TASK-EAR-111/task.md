# TASK-EAR-111: Publish Admin VIP list catalog identity

Parent `TASK-EAR-109`; epic: Store Items canonical catalog rollout. Feature/backend/high; owner `dev`.

## Outcome

Add the stable VIP catalog UUID to `adminuserpb.ListLevelsResponse.viplevel` so
Backoffice Store selectors receive the same identity already exposed by User
profile and Admin get/create/update responses. Publish a new backward-compatible
`shared-lib` version; do not implement or bypass this field locally in User or
Backoffice.

## Scope

- `shared-lib/proto/admin/adminuserpb/adminuser.proto`.
- Generated AdminUser Go, gRPC/gateway and Swagger artifacts affected by generation.
- Focused contract test for protobuf serialization and OpenAPI `catalogId` exposure.
- No consumer repo edits in this task.

## Acceptance criteria

- `ListLevelsResponse.viplevel` adds `string catalog_id = 12`; existing field numbers and routes are unchanged.
- All deterministic generated artifacts are committed, including transitive Swagger output.
- Focused contract tests, `go test ./...`, readonly build, `buf format`, `buf breaking`, deterministic generation and `git diff --check` pass.
- The merged commit resolves through `go list -m -json`, and its published pseudo-version is recorded in TASK-EAR-109 before that lane resumes.

## Plan

1. Add the single additive field and focused compatibility test.
2. Regenerate all affected artifacts and verify deterministic output.
3. Commit, push and open a shared-lib PR for human merge/publication.

## Risks

- Missing a transitive generated artifact repeats PR 15/16 drift. Mitigation: run the repository generator and confirm a second run is clean.
- Consumer work could compile against local source. Mitigation: keep TASK-EAR-109 blocked until a merged pseudo-version is recorded; no `replace`.

## Source evidence

- Current `adminuserpb.ListLevelsResponse.viplevel` fields end at `ui_setting = 11`.
- Current `userpb.VIPLevel` already exposes `catalog_id = 12`.
