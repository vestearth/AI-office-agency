# TASK-EAR-063: Compose VIP Table Thumbnails From UI Setting

## Short name

`vip-table-thumbnail-composition`

## Type

feature

## Workstream

frontend

## Priority

medium

## Created

2026-07-03

## Goal

Make every row in `/admin/manage/vip` display the thumbnail presentation saved
in that VIP level's UI Setting by composing the persisted thumbnail background
with the persisted thumbnail image.

## Approved design

Implementation must follow
`Games-Labs-backoffice/docs/superpowers/specs/2026-07-02-vip-table-thumbnail-composition-design.md`.

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | Owns the VIP admin table, UI Setting data mapping, thumbnail rendering, and frontend regression coverage. |
| `ai-dev-office` | Records the PM scope, assignment, acceptance criteria, and verification handoff for this task. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/vip/index.vue` | modify | Render a 40x40 layered thumbnail using the persisted UI Setting background and image. |
| `Games-Labs-backoffice/app/utils/vipLevelApi.ts` | modify | Add the smallest safe adapter from persisted thumbnail background values to CSS while retaining the existing image fallback helper. |
| `Games-Labs-backoffice/tests/vipLevelThumbnail.test.mjs` | create | Cover gradient composition, configured-image wiring, fallback image, and invalid-background behavior. |
| `ai-dev-office/runs/TASK-EAR-063/task.md` | create | Record the approved scope and implementation plan. |
| `ai-dev-office/runs/TASK-EAR-063/status.yaml` | create | Track assignment and next action. |
| `ai-dev-office/runs/TASK-EAR-063/pm-output.yaml` | create | Store the structured PM handoff. |

### Explicitly excluded

- No backend, API, protobuf, database, upload-kind, or persistence changes.
- No changes to VIP Create/Edit upload behavior.
- Do not render `uiSetting.badgeProgress.badgeUrl` or
  `uiSetting.badgeProgress.endIconUrl` as the VIP table thumbnail.
- Do not broaden the task into general VIP page cleanup or redesign.

## Description

The VIP admin table currently has access to `row.uiSetting` from the existing
list mapping. Update its first column so the row thumbnail matches the approved
UI Setting presentation: compute the background from
`uiSetting.thumbnail.background`, then center
`uiSetting.thumbnail.thumbnailUrl` above it. Continue to use `/vip1.png` when
the stored thumbnail URL is empty. Invalid or missing gradient data must degrade
to a transparent background without throwing.

## Acceptance criteria

- [ ] Each `/admin/manage/vip` row renders a 40x40 composed thumbnail with the
      CSS gradient derived from `row.uiSetting.thumbnail.background` and the
      configured `row.uiSetting.thumbnail.thumbnailUrl` centered above it.
- [ ] Persisted linear and radial background enum values and per-stop
      `color`, `opacity`, and `position` are interpreted according to the
      approved design spec.
- [ ] An empty or missing thumbnail URL renders `/vip1.png`.
- [ ] A missing or invalid thumbnail background returns a transparent
      background and does not throw or prevent the image from rendering.
- [ ] Neither `badgeProgress.badgeUrl` nor `badgeProgress.endIconUrl` is used
      for the VIP table thumbnail.
- [ ] No backend, API, upload, or persistence contract changes are introduced.
- [ ] A focused regression test covers valid composition, image fallback, and
      missing or invalid background behavior.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-063` passes.

## Plan

1. Lock the expected rendering contract with a focused failing regression test.
2. Add the smallest persisted-background-to-CSS helper, reusing existing color
   math where it safely matches the approved data shape.
3. Wrap the current table image in the 40x40 background layer and keep the
   configured image centered with `object-contain`.
4. Run the focused test and `npm run build`.
5. Record verification evidence and hand the task to review.

## Dependencies and blockers

- Dependency: the approved design spec listed above.
- Dependency: the existing VIP list response continues to provide
  `uiSetting.thumbnail`; no API change is needed.
- Blockers: none.

## Risks and mitigations

- Persisted stops use `color`, while other frontend gradient helpers may expect
  `hex`.
  Mitigation: adapt the persisted shape explicitly and regression-test the exact
  enum and stop format from the approved spec.
- Malformed saved settings could break row rendering.
  Mitigation: validate the input and return `transparent` for incomplete or
  invalid backgrounds.
- A badge or end-icon URL may look like a valid VIP image but belongs to a
  different UI section.
  Mitigation: scope table rendering exclusively to `uiSetting.thumbnail` and
  assert that boundary in the focused test.

## Assignment

- Primary: `dev`
- Parallel: `false`
- Reason: focused single-repository frontend change with shared files that
  should be implemented and verified sequentially.

## Verification and review plan

- Run `node --test tests/vipLevelThumbnail.test.mjs` from
  `Games-Labs-backoffice`.
- Run `npm run build` from `Games-Labs-backoffice`.
- Reviewer confirms the table uses only `uiSetting.thumbnail` and that the
  diff contains no backend/API/upload/persistence changes.
- Run the canonical AI Dev Office YAML validator before handoff.
