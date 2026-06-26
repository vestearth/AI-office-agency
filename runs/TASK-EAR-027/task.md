# TASK-EAR-027 — Custom Group "Display Group" status not persisting

**Type:** bugfix · **Workstream:** frontend · **Priority:** medium
**Repo:** `/Users/earth/Documents/GitHub/Games-Labs-backoffice` (work ONLY in this repo)
**Executor:** Codex · **Reviewer/Operator:** Claude supervisor lane (reviews diff before commit)

## Symptom (reproduce)
1. Backoffice → Game → Group → **Custom** tab → open a custom group (e.g. "Test2").
2. Toggle the **Display Group** switch.
3. Click **Update** → toast says success, but the status does NOT change. On
   reload the toggle is back / the list status is unchanged.

## Root cause (confirmed against source)
Single file: `app/pages/admin/games/group/edit/[id].vue`.

Two linked defects:
1. **Save side (the reported bug):** `onUpdate()` custom-mode branch
   (`[id].vue:1637-1652`) only calls `reorderCategoryGames()` + reload. The
   `displayCollectionEnabled` toggle is never sent to the API, so the status is
   silently discarded.
2. **Load side (latent):** `displayCollectionEnabled` is hardcoded
   `ref(true)` (`[id].vue:1010`) and is never initialized from the loaded
   category's `is_active`. The edit page loads category *games* but not the
   category record's status, so the toggle never reflects the saved value.

## API contract (already proven in this repo / proto)
- Update RPC is **PUT** — `put: /api/v1/admin/category/{id}` (proto
  `shared-lib/proto/admin/admingamepb/admingame.proto`,
  `UpdateCategoryRequest`). **Do NOT use POST** (POST is create).
- Status field is `is_active` (proto) — the working **create** call already
  uses camelCase `isActive` through the gateway:
  `app/pages/admin/games/group/index.vue:801`
  (`body: { name, isActive: true, isHighlight: false }`). Mirror that casing.
- Base URL pattern already in edit page:
  `const gatewayBase = ...` / `${gatewayBase}/api/v1/admin/category` (see
  `index.vue:23`). Build the per-id URL as `${...}/api/v1/admin/category/${categoryId}`.
- Use the existing `buildRequestHeaders()` + `'content-type': 'application/json'`
  and the existing `$fetch` + `apiErrorMessage()` + toast helpers already used in
  this file. Follow the existing `reorderCategoryGames()` style.

## Required change
In `app/pages/admin/games/group/edit/[id].vue`:
1. **Load side:** when the category is loaded for custom mode, seed
   `displayCollectionEnabled.value` from the category's `is_active`. Find where
   the category/category-games are loaded (around `loadCategoryGroupGames()` /
   the category fetch) and read the status there. If the current category fetch
   does not return `is_active`, fetch the category record (GET
   `/api/v1/admin/category/{id}` or read it from the list payload) — keep it
   minimal.
2. **Save side:** in the `isCustomMode` branch of `onUpdate()`, add a
   **PUT** to `/api/v1/admin/category/${categoryId}` with body including
   `isActive: displayCollectionEnabled.value` (mirror the create payload shape;
   include `name`/`isHighlight` only if the gateway requires them — verify the
   minimal body that the backend accepts; the proto allows partial fields). Send
   it together with the existing `reorderCategoryGames()` (order of calls: save
   status, then reorder, or vice-versa — keep both, surface errors via the
   existing try/catch + toast).

## Acceptance criteria
- Toggling Display Group + Update **persists** the status (PUT returns success
  and the list/edit reflect it after reload).
- Opening an existing custom group shows the toggle in its **actual** saved
  state (not always ON).
- No regression to game reorder save (still works).
- `pnpm` typecheck / lint clean for the touched file; `pnpm build` not broken.

## GUARDRAILS (hard constraints — prior Codex runs violated these)
- **Only edit `Games-Labs-backoffice/app/pages/admin/games/group/edit/[id].vue`**
  (a tiny helper read of `index.vue` payload shape is fine; do not edit other
  repos). Use **absolute paths**; do not touch `shared-lib`, `Games-Labs-Game`,
  or any sibling repo.
- **No scope creep:** do NOT invent new API client modules, composables, real
  vs mock toggles, or "while I'm here" refactors. Smallest fix only.
- Do **NOT** commit. Leave changes uncommitted for operator review.
- Before finishing: run `git status` in the repo, `grep -n "\$fetch" ` the
  touched file to confirm you reused the existing fetch pattern, and delete any
  scaffold/file you created that wasn't requested.
- Watch the known gateway gotchas: PUT-not-POST; field-name `_1` suffix bug
  (gateway silently drops unknown fields via DiscardUnknown) — use exact field
  names.

## Done report (write back to status.yaml history + a dev-output.yaml if used)
Summarize: files changed, the PUT call added, how the load-side init reads
`is_active`, and the verification you ran.
