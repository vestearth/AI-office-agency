# TASK-EAR-091: Shared GameSelectModal component (game-group + mission)

## Short Name

`shared-game-select-modal`

## Type

refactor (FE, consolidation)

## Priority

medium

## Parent / Epic

- Epic: Missions admin manage / reusable UI
- Sibling: TASK-EAR-089 (built the interim MissionGamePickerModal this supersedes)
- Origin: operator request 2026-07-09 — the richer two-panel "Add Game" modal
  on `admin/games/group/edit` (left: Provider filter + Search + checkbox grid;
  right: "Game selected" panel with Clear all + count; footer Cancel/Update)
  should be a shared central component used by both the game-group page and the
  mission daily editor.

## BLOCKED — why

The source modal is currently **inline markup inside
`app/pages/admin/games/group/edit/[id].vue`** (a 600+ line page), and that exact
file is being edited by a concurrent live session in the same working tree
(uncommitted: modified `[id].vue` + new `app/utils/gameGroupAddModal.ts`
top-10-slot assignment helpers + `tests/gameGroupAddModal.test.mjs`). The other
session is refactoring the group's slot-assignment logic, NOT componentizing the
modal. Extracting the modal now would require editing `[id].vue` and would
collide with their WIP.

Operator decision (2026-07-09): **wait for the concurrent game-group work to be
committed/landed, then do the full extraction in one pass** (both call sites at
once) — no partial wiring, no clobbering.

`blocked_on`: the concurrent game-group `[id].vue` / `gameGroupAddModal.ts`
changes being committed to a branch.

## Planned scope (when unblocked)

1. Create `app/components/mission/GameSelectModal.vue` (or a repo-wide
   `app/components/GameSelectModal.vue`) from the committed game-group modal
   design. Clean contract:
   - Props: `games: GameCatalogItem[]`, `modelValue: string[]`,
     `maxGames?: number`, `providerFilter?: boolean`, `title?: string`,
     `open: boolean`.
   - Emits: `update:modelValue`, `close`.
   - Two-panel layout (picker + "Game selected"), Provider dropdown (custom
     chevron, not native), Search, Clear all, count badge, Cancel/Update footer,
     Teleport + Escape + click-outside. maxGames cap enforcement (carry over the
     TASK-EAR-089 rule: unselected tiles disabled at cap, selected can toggle
     off).
2. Wire it into the mission daily editor, REPLACING
   `MissionGamePickerModal.vue` (from TASK-EAR-089) — then delete
   MissionGamePickerModal if nothing else uses it.
3. Wire it into `admin/games/group/edit/[id].vue`, replacing the inline modal
   markup; keep the page's top-10 slot-assignment logic
   (`gameGroupAddModal.ts`) around the shared component.
4. Reconcile with `EventGameSelector.vue` — decide whether the event picker also
   adopts the shared component or stays (avoid a third divergent modal).
5. Tests + `node --test` + `nuxt build` green; no bare native `<select>`.

## Out of Scope

- Backend / API changes (all pickers use `GET /api/v1/admin/games`).
- Changing the game-group slot-assignment behavior.

## Acceptance Criteria

1. One shared modal component renders the two-panel Add Game UI.
2. Both the mission daily editor and the game-group edit page use it; the
   interim MissionGamePickerModal is removed.
3. maxGames cap honored where applicable (mission editor); unbounded where not
   (game-group, if applicable).
4. No visual regression on either page; tests + build green.
