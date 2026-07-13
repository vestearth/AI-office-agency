# TASK-EAR-097: Publish the approved Store Items shared contract

Parent: `TASK-EAR-096`  
Epic: Store Items canonical catalog rollout  
Type/workstream/priority: feature/backend/high  
Owner: `dev-2`; sequential; pending TASK-EAR-096.

## Outcome

Update `shared-lib` first with the approved AdminOrder special-item contract and generated artifacts. Include Admin Get-by-ID, approved list filters/pagination and only the Pass/Avatar fields approved in TASK-EAR-096. Publish a real shared-lib version before any downstream consumer work; never commit a local replace.

## Affected files

- `shared-lib/proto/admin/adminorderpb/adminorder.proto`
- generated `shared-lib/proto/admin/adminorderpb/*pb.go`, `*pb.gw.go`, Swagger artifacts
- focused proto/contract tests or validation scripts already used by shared-lib

## Acceptance criteria

- Admin Get-by-ID and approved filters have backward-compatible HTTP/gRPC mappings.
- Approved Pass/Avatar fields round-trip in generated messages; unapproved UI fields are absent.
- Proto/generated artifacts and Swagger are regenerated, not hand-edited.
- Shared-lib tests/build and diff check pass.
- Commit/version is published and recorded for TASK-EAR-098 through TASK-EAR-100.

Verification: proto generation, `GOWORK=off go test ./...`, readonly build where supported, and `git diff --check`.

## Dev-2 publication evidence — 2026-07-13

- Shared-lib branch: `feature/TASK-EAR-097-store-items-contract`
- Commit: `c8244878a0145f45f33330942fd296c89bc0985c`
- Resolvable pseudo-version: `v0.0.0-20260712220804-c8244878a014`
- Pull request: https://github.com/SparqLab/shared-lib/pull/14
- The pseudo-version resolves from the pushed remote branch. Downstream tasks
  must wait for reviewer approval and merge before adopting it.

## Merge evidence — 2026-07-13

- PR 14 merged to `main` at `2026-07-12T22:19:17Z`.
- Merge commit: `26afe576d8e4d63d582dd5c5314c5d324c8628e7`
- Mainline pseudo-version: `v0.0.0-20260712221916-26afe576d8e4`
- TASK-EAR-098 through TASK-EAR-100 may consume the mainline version.
