# TASK-EAR-150: Game classification epic — Phase 4: Backoffice dropdown/preview from taxonomy

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-18

## Epic

Canonical game-classification — Phase 4 of 5. Depends on TASK-EAR-147 (Game
taxonomy list endpoint) and TASK-EAR-149 (Missions admin API accepts
game_category). **Supersedes TASK-EAR-141** (interim zero-game guard).

## Goal

Drive the mission category dropdown and the included-games preview from the
live Game taxonomy, so the config UI offers only real categories and its
preview matches exactly what the runtime scores.

## Scope (Games-Labs-backoffice)

1. Replace the hardcoded `dailyMissionGameCategoryOptions`
   (`app/data/mock.ts`) with the live Game `game_categories` list endpoint
   (TASK-EAR-147 — 5 rows: `SLOTS, CRASH, ARCADE, MINIGAME, CARD`) across the
   mission editors (Setting Default form, daily/weekly period editors, event
   create/edit).
2. Save writes `game_category.code` to the Missions admin API (149).
3. Preview counts games by **assigned game_category** (exact), not by fuzzy
   `games.category`; warn (and gate) when a category matches zero games —
   this absorbs the TASK-EAR-141 guard.
4. Preserve the approved UX design — data-source and validation changes only,
   no component redesign (operator standing rule).

## Acceptance

- Dropdown reflects the live taxonomy (no hardcoded list, no dead options).
- Preview count == games assigned to that `game_category`.
- Zero-game category warns on every surface where category turnover is
  configured.
- Save persists `game_category`; `npm run build` green. Lands on backoffice
  `main` (live deploy — backoffice main is still k3s/ArgoCD).

## Note

Close TASK-EAR-141 as superseded once this ships (or keep 141 as an interim
guard on the hardcoded list if the epic runs long — operator's call).

## Execution plan (coordinator, 2026-07-21) — 2 independent parts, dispatched in parallel

Recon (pulled Missions and read backoffice source directly) found the actual
surface is bigger than originally scoped: there are **three** write paths for
category-scoped missions, and only one (weekly's direct admin CRUD) was
covered by TASK-EAR-149:

1. **Weekly direct-CRUD activities** (`POST/PUT /api/v1/admin/weekly/activities`)
   — covered by TASK-EAR-149's admin API (`game_category` field, snake_case
   JSON, confirmed live in `internal/handlers/adminmission/http/weekly.go`).
2. **`saveWeeklyPlanFull`** (bulk plan+group+tasks save, what the actual
   Weekly period editor page calls, `internal/repositories/...
   SaveWeeklyPlanFull`) — also covered; TASK-EAR-149's agent found and fixed
   this exact path (flagged in that run's history as one of two things
   outside its original plan that would have silently dropped the field).
3. **Schedule-generated missions** (`default_mission_templates.daily` /
   `.weekly`, written verbatim by the "Setting Default" pages, consumed by
   `schedule_defaults.go` + `schedule_generator.go` to produce
   `daily_activities`/`weekly_activities` rows) — **NOT covered by any prior
   task**. `DefaultMission` (schedule_generator.go) has no `GameCategory`
   field at all, only the legacy `GameType`. Every schedule-generated
   category_turnover mission (both daily AND weekly) would therefore always
   score via the fuzzy fallback, silently, forever — a real functional gap,
   not just an observability one.

**Also found — a real naming collision, read carefully:** the
`default_mission_templates` JSON blob already has a field called
`gameCategory` (`defaultTemplateEntry.GameCategory` in `schedule_defaults.go`)
— but it means something different and older: the raw UI dropdown label
(e.g. `"Slot"`), fed through `categoryToGameType()` to produce the LEGACY
`game_type` token (`"SLOT"`). This is NOT this epic's canonical
`game_category` concept, despite the near-identical name. Do not confuse the
two or reuse the name for the new canonical value.

**Also found — a genuine simplification:** TASK-EAR-147 made `games.category`
itself the FK-enforced canonical column (no new column was added to
`games`), so the Game admin game-list endpoint's existing `category` field on
each game **already returns the canonical code** (`SLOTS`, `CRASH`, etc.)
post-147. Counting games by category correctly is now a plain exact-string
comparison, not a lookup into some other field.

**Also found — a real API casing inconsistency to handle correctly:** Game's
`/api/v1/admin/game-category` endpoint is a gRPC-gateway (protojson) route,
so its JSON is **camelCase** (`displayName`, `sortOrder`) — confirmed via
`shared-lib/proto/admin/admingamepb/admingame.swagger.json`. Missions'
`/api/v1/admin/weekly/activities` etc. are hand-rolled HTTP, so their JSON is
**snake_case** (`game_category`) — confirmed by reading the actual handler
Go structs. Two different casing conventions on two different admin APIs the
same feature touches; do not assume one convention applies to both.

---

### Part A — Missions (small, mechanical, independent of Part B)

Repo: Games-Labs-Missions. Requires zero frontend changes — the input
(`defaultTemplateEntry.GameCategory`, the existing UI label field) is already
sent by the current, unmodified frontend code.

1. `internal/services/schedule_defaults.go`: add a new function
   `categoryToGameCategory(uiLabel string) string` right next to the existing
   `categoryToGameType` (~line 106) — same normalize-and-branch shape, but
   instead of returning the legacy per-mechanic token, return the TASK-EAR-146
   canonical code: map the normalized UI label to
   `SLOTS/CRASH/ARCADE/MINIGAME/CARD` (same locked mapping used by
   TASK-EAR-149's Stage A migration: `SLOT -> SLOTS`, others map to
   themselves), empty/`"all"` still means "any game" (empty result, matching
   `categoryToGameType`'s existing behavior).
2. `internal/services/schedule_generator.go`: add `GameCategory string` to
   the `DefaultMission` struct (~line 78, next to the existing `GameType`).
3. Back in `schedule_defaults.go`'s `buildDefaultMissionsFromEntries`
   `category_turnover` case (~line 178-196): call the new
   `categoryToGameCategory(e.GameCategory)` alongside the existing
   `categoryToGameType(e.GameCategory)` call and set the result on
   `DefaultMission.GameCategory` in both branches (the `TURNOVER_GAME_TYPE`
   branch and, if a category was selected, still applies — think through
   whether the `TURNOVER_AMOUNT` "any game" branch should leave
   `GameCategory` empty too, matching `GameType`'s existing empty behavior
   there).
4. `schedule_generator.go`'s two call sites that build the actual
   `daily_activities`/`weekly_activities` activity row from a `DefaultMission`
   (~line 256 and ~line 321, both currently do `GameType: def.GameType`):
   add `GameCategory: def.GameCategory` next to each.
5. `go build ./...` + `go test ./...` clean; add/extend a test in
   `schedule_defaults_test.go` covering `categoryToGameCategory` and the
   `category_turnover` case setting `GameCategory` correctly (mirror however
   the existing `GameType`-focused tests in that file are structured).
6. Commit, push, PR to `staging`. Title: "feat(missions): schedule generator populates canonical game_category (TASK-EAR-150 Part A)".

### Part B — Games-Labs-backoffice

1. Replace `dailyMissionGameCategoryOptions` (`app/data/mock.ts`) with a live
   fetch from Game's `GET /api/v1/admin/game-category` (5 rows today:
   `SLOTS, CRASH, ARCADE, MINIGAME, CARD`; response is camelCase —
   `{status, data: [{code, displayName, active, sortOrder}]}`). Find how
   other Backoffice composables call Game's admin API (e.g.
   `useAdminGamesCatalog.ts` or similar) and mirror that pattern for a new
   `useAdminGameCategoryApi.ts`-style composable, or extend an existing one
   — use existing conventions, don't invent a new HTTP-calling pattern.
   Apply across every surface currently importing
   `dailyMissionGameCategoryOptions` / `categoryTurnoverGameOptions`
   (`DefaultMissionForm.vue`, `MissionPlanPeriodEditor.vue`, and any event
   create/edit surface using the same options — grep for the import).
2. Preview counting: `app/utils/gameCategory.ts`'s `gamesInMissionCategory`
   currently fuzzy-matches the UI label against each game's `category` field.
   Since `games.category` is now the FK-enforced canonical column (see
   "genuine simplification" above), change this to an exact match against the
   selected canonical code (case-insensitive is fine, exact string equality
   otherwise) — no more fuzzy contains-matching needed once both sides speak
   the same vocabulary. Add a clear warning/disabled-save state when the
   selected category matches zero games (this absorbs TASK-EAR-141's
   originally-scoped guard) on every surface listed in step 1.
3. Save paths:
   - Weekly direct-CRUD / `saveWeeklyPlanFull`: TASK-EAR-149 already accepts
     `game_category` (snake_case) on these endpoints — send the selected
     canonical code (the value from the new live dropdown, NOT a UI label)
     under that field name.
   - Daily/weekly "Setting Default" templates
     (`default_mission_templates.daily`/`.weekly`): **no change needed** —
     the existing `gameCategory` field (UI label) is already sent as-is;
     Part A (Missions) handles deriving the canonical code from it
     server-side. Do not add a second field here or rename the existing one
     — that would break Part A's mapping input.
4. Preserve the approved UX design — data-source and validation changes
   only, no component redesign (operator standing rule, restated from the
   original Scope).
5. `npm run build` clean. Lands on backoffice `main` (this repo's main
   branch deploys live via k3s/ArgoCD — verify this is still current before
   merging, it was a known exception to the general staging-first pattern).
6. Commit, push, PR to `main`. Title: "feat(missions-ui): live game_category taxonomy dropdown + exact preview (TASK-EAR-150 Part B)".

Parts A and B do not depend on each other and can be dispatched and merged
independently, in either order.
