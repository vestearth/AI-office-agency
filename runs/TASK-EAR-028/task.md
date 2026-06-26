# TASK-EAR-028 — Backend: allow turning a Custom Group OFF (is_active=false)

**Type:** bugfix · **Workstream:** backend · **Priority:** medium
**Parent/related:** TASK-EAR-027 (FE fix; handled the ON path only)
**Executor:** Claude lane · **Status:** implemented, UNCOMMITTED for operator review

## Problem
TASK-EAR-027 wired the Backoffice "Display Group" toggle to
`PUT /api/v1/admin/category/{id}` with `{ isActive }`. Turning the group **ON**
now persists, but turning it **OFF** does not. Root cause is backend:
- `UpdateCategoryRequest.is_active` was a plain proto3 `bool` → no field
  presence → the handler could not tell "set false" from "omitted".
- `admingamesvc/service.go` defensively nil-ed a `false` IsActive
  (`if req.IsActive != nil && !*req.IsActive { req.IsActive = nil }`), so a
  toggle-off was silently dropped and the repo preserved the old `true`.

## Change (3 edits across 2 repos)
1. **shared-lib** `proto/admin/admingamepb/admingame.proto` —
   `UpdateCategoryRequest.is_active`: `bool` → `optional bool` (field #4
   unchanged, still varint ⇒ **wire-compatible**). Regenerated with `buf generate`
   (`admingame.pb.go` → `IsActive *bool`; `admingame.swagger.json` updated).
   `.pb.gw.go` did NOT change — gateway uses protojson, no hand-written mapping.
2. **Games-Labs-Game** `internal/core/handlers/admingamehdl/grpc.go`
   (`UpdateCategory`) — build `IsActive *bool` only when `req.IsActive != nil`
   (presence-aware), so omitted preserves and explicit false/true is forwarded.
3. **Games-Labs-Game** `internal/core/services/admingamesvc/service.go` —
   removed the `false`-drop filter for IsActive (presence is now handled in the
   handler). Name/sort_order partial-update filters left untouched.
   + new regression test `category_isactive_test.go` (false persists / true
   persists / omitted preserved).

## Compatibility (api-contract + grpc-contract lens)
- **Wire:** field #4 stays varint ⇒ existing binary clients unaffected.
- **JSON/gateway:** `{"isActive": true|false}` still maps correctly; omitting it
  now means "no change" (previously sent false → which was dropped anyway).
- **Clients:** CreateCategory unchanged (`bool is_active` there is fine). No
  other caller of UpdateCategory relied on the false-drop (verified: only the
  Backoffice group edit page calls it).
- **No breaking change for mobile** — admin-only endpoint.

## Verification done (local, with temporary `replace => ../shared-lib`)
- `buf generate` exit 0; `IsActive *bool` confirmed in generated Go.
- `go build ./...` exit 0; `go vet` clean (touched pkgs).
- `go test ./internal/core/services/admingamesvc/... ./internal/core/handlers/admingamehdl/...`
  PASS incl. the 3 new presence cases.
- The temp `replace` was **removed** afterward — Game `go.mod`/`go.sum` are clean;
  Game diff = grpc.go + service.go + the new test only.

## ROLLOUT (operator — NOT executed; required to actually ship)
The local verification used a `replace` directive; the real rollout is the
shared-lib version dance:
1. Review + commit shared-lib (proto + regenerated `.pb.go`/`.swagger.json`),
   push to get a new pseudo-version.
2. `cd Games-Labs-Game && go get github.com/SparqLab/shared-lib@<new-version>`
   then commit grpc.go + service.go + category_isactive_test.go + go.mod/go.sum.
3. `cd api-gateway && go get github.com/SparqLab/shared-lib@<new-version>` +
   commit (gateway must carry the regenerated message def for protojson; no
   code change otherwise).
4. Deploy Game + gateway (per current topology: main → Contabo k3s sha-pin via
   ArgoCD; staging/prod → ECS). Verify toggle OFF persists end-to-end against a
   real category.

## Acceptance criteria
- Toggling Display Group OFF + Update sets the category inactive and survives
  reload (end-to-end with the TASK-EAR-027 FE already on backoffice main).
- Toggling ON still works; editing a group without sending is_active does not
  change its active state; category name/sort_order never wiped.
