# TASK-EAR-035: Weekly + Monthly "Setting Default" (mock/preview, FE-only)

## Short name
`missions-weekly-monthly-setting-default`

## Type
feature (frontend, mock-only)

## Runner
Cursor (dev lane). This is a UI-heavy, mock-only slice — a good fit for Cursor.
Claude will wire the backend/API afterward; **do not** wire any API here.

## Repo
`Games-Labs-backoffice` (Nuxt 3 / Vue 3 / TS) only. No backend/proto/gateway.

## Background / finding
The **"Setting Default"** button on the missions board only renders for the
Daily tab and there is no Weekly/Monthly equivalent. It must also exist on
**Weekly** and **Monthly**.

Verified current state:
- Button: `app/pages/admin/manage/missions/index.vue:198` — gated
  `v-if="missionView === 'daily'"`, calls `goSetting()` →
  `navigateTo('/admin/manage/missions/edit')`. Event tab shows "Create Event"
  instead (`v-else-if missionView === 'event'`).
- Daily Settings page: `app/pages/admin/manage/missions/edit/index.vue` (337
  lines) — two tabs **Mission** + **Schedule**, built entirely from
  `mockDailyDefaultMissions` + `mockDailyMissionSchedule` + the
  `DailyMissionConditionType` / `DailyMissionSchedule` types in `app/data/mock.ts`
  (~lines 1214–1360). Snapshot-on-edit / rollback-on-cancel pattern.
- There are **no** weekly/monthly equivalents of these mocks — only daily exists.

## Goal
Add a Weekly Setting Default page and a Monthly Setting Default page, each
mirroring the daily Settings page (Mission + Schedule tabs), wired to **new
mock data** modeled on the daily mocks and matched to the Figma references.
Surface the "Setting Default" button on the Weekly and Monthly board tabs.

## UI references (authoritative — read these first)
Folder: `ai-dev-office/runs/TASK-105/ui-reference/` (and `README.md` there).
- Weekly Setting/Schedule: `work-captures/task-106-weekly-schedule-screen.png`,
  `work-captures/task-106-weekly-edit-detail-screen.png`
- Monthly Setting/Schedule: `work-captures/task-106-monthly-schedule-screen.png`,
  `work-captures/task-106-monthly-edit-reward-screen.png`
- Generic Setting Default Mission: `work-captures/task-108-setting-mission-overview.png`,
  `work-captures/task-108-setting-mission-type-grid.png`
- Generic Schedule: `work-captures/task-109-schedule-overview.png`,
  `work-captures/task-109-schedule-selected-missions.png`
Mirror the daily page's component structure; adapt fields/labels to what the
weekly and monthly screens show.

## Scope — DO
1. **Mocks** (`app/data/mock.ts`): add weekly + monthly analogs of
   `mockDailyDefaultMissions` / `mockDailyMissionSchedule` (+ their types/option
   arrays), named consistently (e.g. `mockWeeklyDefaultMissions`,
   `mockWeeklyMissionSchedule`, `mockMonthlyDefaultMissions`,
   `mockMonthlyMissionSchedule`). Shape them to the reference screens. These are
   mock placeholders Cursor authors — they don't have to be product-final.
2. **Pages**: create `app/pages/admin/manage/missions/weekly/settings.vue` and
   `app/pages/admin/manage/missions/monthly/settings.vue` mirroring
   `edit/index.vue` (Mission + Schedule tabs, snapshot/rollback edit pattern,
   `definePageMeta({ layout: 'admin' })`). Use route names that do NOT collide
   with the existing `weekly/edit/[id].vue` / `monthly/edit/[id].vue` dynamic
   routes — `weekly/settings.vue` and `monthly/settings.vue` are safe.
3. **Button** (`index.vue`): generalize the "Setting Default" button to also
   render for `weekly` and `monthly` (keep Daily → `/missions/edit`, keep Event →
   Create Event). Route weekly → `/admin/manage/missions/weekly/settings`,
   monthly → `/admin/manage/missions/monthly/settings`.
4. **Conventions** (must follow):
   - Any native `<select>` → wrap with `appearance-none` + a `lucide:chevron-down`
     overlay (`pointer-events-none`, right-3/4). Never ship a bare native select.
   - Save/confirm feedback via `~/composables/useAdminSaveFeedback`
     (`openAdminSaveConfirm` / `openAdminSaveToast`) exactly like the daily page.
   - Match the daily page's Tailwind classes / spacing / `SettingTabs` usage.
5. Leave an obvious **API seam**: where the daily page would later read/write
   `mission_config`, add a `// TODO(api): wire via useAdminMissionApi — Claude` so
   the follow-up wiring is trivial to locate.

## Scope — DON'T (hard constraints)
- **No backend / no API.** Do not import or call `useAdminMissionApi`, do not add
  `$fetch`/`api.*` calls, do not touch proto/gateway/Go. Mock/preview only —
  Claude wires the API afterward (mission_config for the bonus triplet; monthly
  backend does not exist yet).
- **Do not invent backend fields or endpoints.** If a screen implies persistence,
  keep it local/mock and drop the TODO seam instead.
- **Do not modify** the daily Settings page (`edit/index.vue`), the
  `weekly|monthly|daily/edit/[id].vue` editors, or the board-loading logic for the
  daily/weekly tabs in `index.vue`. Those have **uncommitted in-flight changes
  from TASK-EAR-032/033** — preserve them; only ADD the button generalization in
  `index.vue`, do not revert/clobber the existing board wiring there.
- Do not edit `useAdminMissionApi.ts`.

## Verify
- `npx nuxi typecheck`. Baseline is **30 pre-existing errors** in unrelated files
  (confirmed in EAR-032). Bar: **zero new errors** in the files you touch
  (`git stash` diff the error count if unsure). Report command + before/after.
- No dev server needed (mock-only, no live data).

## Output contract
- Leave code UNCOMMITTED (operator commits/pushes).
- Save `runs/TASK-EAR-035/dev-output.yaml` (files changed, mock symbols added,
  routes added, typecheck before/after, any reference ambiguity you resolved).
- Run `ruby ai-dev-office/validate-yaml.rb TASK-EAR-035`.

## Handback
When done, Claude continues: wire the Weekly bonus/config seam to `mission_config`
and connect Monthly once its backend lands (EAR-034 spec).
