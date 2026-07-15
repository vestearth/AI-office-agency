# TASK-EAR-119 — `display_name` on Quest Overview daily/weekly items

## Context

QA reviewed `GET /api/v1/quest/overview?userId={userID}` (mobile Quest > Mission
> Daily/Weekly Submission) against the Backoffice Weekly Mission Plan screenshot
and asked for two things (Missions team follow-up, 2026-07-15):

1. Daily "Play 10 Game": `children` currently returns all games linked to the
   mission (already being fixed by the uncommitted `totalGame`/`gameIds` work
   the operator is landing separately — not part of this task).
2. Both daily and weekly items expose only a raw slug/id as `label`
   (`"label": "daily-sched-2026-07-14"`, `"label": "any_game_turnover"`) with
   no human-readable name. QA wants an additional field, e.g. `displayName`,
   carrying something like `"Play 10 Game"` / `"Play Any Game"`.

Operator decision (this conversation, 2026-07-15):
- The 13-vs-10 count issue: fix the linked-game count to match the mission
  (separate, already in flight — out of scope here).
- displayName: **admin-settable, with a hardcoded-mapping fallback when not
  set.**

## Investigation (Explore agent + manual read, 2026-07-15)

- `/api/v1/quest/overview` is served directly by Missions' own mux
  (`internal/routes/apiv1.go:17` → `internal/handlers/mission/http/quest.go`),
  bridged to grpc-gateway as a `google.protobuf.Struct` passthrough
  (`shared-lib/proto/missionspb/missions.proto:68-69`). **No .proto change and
  no api-gateway change needed for any part of this task** — it's a Go-only,
  additive JSON field.
- `QuestOverviewItem` (`internal/services/quest_overview_service.go:73-91`) is
  the single struct backing daily group rows, daily flat activities, daily
  children, and weekly rows. It already carries `ConditionType` — but the
  **weekly build path does not currently populate it**
  (`buildWeeklyTab`, `quest_overview_service.go:466-484`, source is
  `WeeklyMissionCard` in `internal/models/models.go:382-395`, which has no
  `ConditionType` field at all). Daily's flat/group/children paths do have a
  reliable `ConditionType` per activity (set at generation,
  `schedule_generator.go`).
- **The admin-settable name mechanism already exists — it's just not wired to
  Missions.** `Games-Labs-backoffice/app/data/mock.ts` (`mockDailyDefaultMissions`,
  ~line 1287-1341) already defines a `missionName` field per condition type,
  a *tokenized* template:
  - `game_turnover` → `"Play {Number of total game} Game"`
  - `category_turnover` → `"Play by {Category} Game"`
  - `any_game_turnover` → `"Play Any Game"`
  - `spend_prop` → `"Spend {xxx Diamonds} with {Special Item}"`

  This `missionName` is part of the same `default_mission_templates` JSON blob
  Missions' schedule generator already parses
  (`internal/services/schedule_defaults.go`, `defaultTemplateEntry` struct) —
  Go's struct just doesn't have a `MissionName` field yet, so it's silently
  dropped on unmarshal.
- `Games-Labs-backoffice/app/utils/missionName.ts` already implements the
  token substitution (`MISSION_NAME_TEMPLATES` as the literal default/fallback
  values — identical to the `missionName` defaults above — and
  `resolveMissionName(template, fields)` doing `{Number of total game}` /
  `{Category}` / `{xxx Diamonds}` / `{Special Item}` replacement). It is used
  in two places, with **different behavior for the missing-special-item
  case** — both need mirroring in Go, not just the happy path:
  - `seedDefaultTask` (daily/edit page, ~line 233): resolves against the
    *template's own config fields* (`specialItemCategory`, a category label
    like `"Randomly by System"`) when an admin manually adds a task from the
    Default Mission template.
  - `resolveActivityMissionName` (`missionName.ts:43-77`): resolves an
    *existing* activity from its persisted `condition_type` + `pool` entries;
    for `spend_prop` **with no concrete special-item pool entry** (exactly the
    schedule-generator's case — see the "Spend Prop Randomly by System"
    contract: the concrete item is picked at claim time, not schedule time),
    it explicitly special-cases the output to `"Spend {N} Diamonds"`,
    dropping the `"with {Special Item}"` clause rather than leaving a
    dangling `"...with "`. **This is the behavior to mirror in Go** — it's
    what produces `"Spend 500 Diamonds"`, matching QA's example exactly.
  - Currently `missionName` is **locked** (non-editable) in the Backoffice UI
    for all 4 types (`lockedFields: ['missionName', ...]`,
    `DefaultMissionForm.vue`). Unlocking it is the "admin sets it themselves"
    half of this task — a one-line-per-type change, no new UI.

## Scope

### Backend (`Games-Labs-Missions`)

1. `internal/services/schedule_defaults.go` — add `MissionName string
   \`json:"missionName"\`` to `defaultTemplateEntry`. Read-only addition; no
   behavior change to existing `buildDefaultMissionsFromEntries` logic.
2. New small Go port of the FE token resolver (new file, e.g.
   `internal/services/mission_display_name.go`):
   - A literal Go map mirroring `MISSION_NAME_TEMPLATES` (the 4 default
     template strings above) as the **fallback when `missionName` is empty**.
   - A resolver function taking (condition type, resolved field values:
     totalGame int, category string, spendingDiamonds int64) → resolved
     string, doing the same `{token}` substitution as
     `missionName.ts:resolveMissionName`.
   - `spend_prop` always resolves via the "no concrete special item" branch
     (`"Spend {N} Diamonds"`) — schedule-generated spend_prop activities never
     have a chosen item at generation time, so there is no case here needing
     the `{Special Item}` token at all. Do not port the `seedDefaultTask`
     category-label branch; that's a Backoffice-only manual-authoring path
     and out of scope.
3. `internal/services/quest_overview_service.go`:
   - `buildDailyTab` (~line 262-310): for each flat activity and each group
     (using the group's children's shared `ConditionType`; schedule-generated
     groups can contain multiple selected mission types, so a mixed/unknown
     parent must omit `DisplayName` while each known raw-slug child resolves
     independently), compute `DisplayName` by looking up
     the current `default_mission_templates` (via the already-existing
     `parseTemplatesBlob`/`cfg.DefaultMissionTemplates` — `cfg` is already a
     parameter of `buildDailyTab`) + resolving with the new function. For
     a single-type `game_turnover` parent, `totalGame` = `gr.TargetChildren`.
     Child/flat items resolve from the cadence template's `totalGame`.
   - `buildWeeklyTab` (~line 466-484): needs `ConditionType` plumbed from
     `WeeklyActivity` through to `WeeklyMissionCard` first (it currently isn't
     — trace `internal/services/weekly_service.go` `resolveWeeklyDefinitions`
     → wherever `WeeklyMissionCard` is assembled from `WeeklyActivity`/
     `resp.Missions`, and add it as internal-only metadata so the standalone
     weekly endpoint does not gain an unrelated field). Then resolve the same
     way as daily, using `totalGame` from the current weekly default template.
     Do not extend `GetActiveWeeklyPlanActivities` to load pools: the accepted
     dynamic-name design intentionally resolves from the current cadence
     template, whose `totalGame` is already validated against distinct
     `gameIds` by the separate count fix.
   - Add `DisplayName string \`json:"display_name,omitempty"\`` to
     `QuestOverviewItem` (`quest_overview_service.go:73-91`) — the single
     struct shared by daily flat/group/children/weekly, so one field addition
     covers all four surfaces QA asked about.
   - If a `ConditionType` isn't one of the 4 known mission types (e.g. a
     manually-authored group/activity with a custom name), leave
     `DisplayName` empty — mobile falls back to `label` client-side. Do not
     overwrite an already-good admin-authored `Label`/`Name` with a
     synthesized one. Resolve only raw generated labels: the exact known slug
     for flat/child/weekly items, or a `daily-sched-*` label for a single-type
     generated daily parent.
4. Unit tests: extend `quest_overview_service` tests (or add a new
   `_test.go` alongside the new resolver file) covering — game_turnover with
   admin-set `missionName` template, game_turnover with `missionName` empty
   (fallback), category_turnover, any_game_turnover, spend_prop (must produce
   `"Spend {N} Diamonds"`, no trailing `"with"`), and a manually-authored
   group/activity with an unrecognized condition type (DisplayName omitted).

### Backoffice (`Games-Labs-backoffice`)

5. `app/data/mock.ts` — remove `'missionName'` from each type's `lockedFields`
   so the existing `DefaultMissionForm.vue` input becomes editable (keep
   `{token}` placeholders as authorable text, same as any other field on this
   form). No component or FE resolution-logic change is needed.
6. Daily and Weekly Setting Default loaders must ignore a persisted
   `lockedFields` value before merging an older template over current defaults.
   `lockedFields` is source-owned UI metadata, but older saved blobs contain it
   and would otherwise re-lock `missionName` after reload. Operator-authored
   values (including `missionName`) continue to round-trip unchanged. Add/extend
   a focused regression test covering both cadence pages.

## Explicit design decisions (do not relitigate without flagging back)

- **Additive only**: `label`/`name`/`key` are untouched. `display_name` is a
  new, always-omittable field. Zero risk to any existing mobile parsing of
  the current fields.
- **Computed dynamically at response time, not baked in at schedule-generation
  time.** No DB migration. Trade-off accepted: editing a type's `missionName`
  template retroactively changes `display_name` on already-generated past/future
  plans for that type (unlike `label`, which stays frozen at generation).
  Flag back to operator if this trade-off turns out to matter for a specific
  UX case.
- Resolution keys off the activity's persisted `ConditionType`, not
  string-sniffing the stored `Name` (unlike the FE's
  `looksLikeMissionTemplateKey`) — Missions always has `ConditionType`
  available server-side (once weekly plumbs it through), so the fragile
  heuristic isn't needed.
- Daily group membership/progress/reward behavior is unchanged. A generated
  daily group may contain multiple mission types; such a parent omits
  `display_name` because no single human-readable mission title is truthful.
  Its known raw-slug children still receive their own `display_name`.

## Out of scope

- The 13-vs-10 linked-game-count fix (separate, operator-owned, already
  implemented and pending commit/PR outside this task).
- `seedDefaultTask`'s manual-authoring resolution path (Backoffice board
  editors) — already works correctly today, untouched.
- Any proto / api-gateway change (none needed).
- Monthly check-in and Event tabs (`buildMonthlyTab`, `buildEventTab`) — QA
  did not ask about these; same `QuestOverviewItem` struct gains the field for
  free, but no resolver wiring is required there.

## Acceptance criteria

- `GET /api/v1/quest/overview` eligible schedule-generated daily single-type
  groups, raw-slug daily flat/child items, and raw-slug weekly items return
  `display_name` resolving from the cadence-specific admin template or fallback.
  Mixed daily parents and already-human manual labels omit the field.
- Admin can edit `missionName` per type in Default Mission Template; an
  edited value is reflected in the next `quest_overview` read for that type
  (dynamic, per the accepted trade-off above).
- Existing `label`/`name`/`key`/`condition_type` values and shapes are
  byte-for-byte unchanged.
- `go build ./...` and `go test ./...` pass in Missions; Backoffice focused
  tests + production build pass.
