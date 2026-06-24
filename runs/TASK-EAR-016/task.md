# TASK-EAR-016: Game Grouping Name — interim 5-language translate UI (FE-only)

## Short name
`game-grouping-translate-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Parent: `TASK-EAR-015` (VIP Avatar translate UI) / `TASK-104` (reference pattern)
- Epic: Backoffice multi-language content

## Status

Assigned. UI approved by user via Figma (Create Game Grouping with source-language
dropdown, Group Name input, Translate, TH/EN/CN/FR/ES preview tabs). Game Grouping
has no Details/Conditions — only the group name — so the translate UI applies to
the name. Claude-advisory lane to implement, build-verify, summarize.

## Background

Create Game Grouping (`app/pages/admin/games/group/index.vue`) submits
`{ name, isActive, isHighlight }` to `POST /api/v1/admin/category`. The backend
`CreateCategoryRequest.name` is a plain `string` (admingame.proto) with no
localized contract — same situation as VIP Avatar (TASK-EAR-015).

Decision (user, approach A): build the full translate UI on the group name but
persist only the source-language text into the existing `name` string. When the
category backend gains a localized contract, only the save mapping changes.

## Goal

Add the Redemption-style 5-language translate UI to the Group Name field in the
Create Game Grouping modal, persisting only the source-language name, with no
backend change.

## Scope

### Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/games/group/index.vue` | modify | Group Name translate UI + source-language save in the Create Game Grouping modal. |
| `ai-dev-office/runs/TASK-EAR-016/*` | create | PM task, status, handoff artifacts. |

### Explicitly Excluded

- No backend / proto / shared-lib changes.
- No changes to the Add Game selection, level/highlight/custom tabs, or any other
  grouping flow.
- Create flow only — there is no edit-group-name flow in this page today.

## Approved Design (spec) — follows the provided Figma

Reference: `RedemptionItemCreateModal.vue` and `VipLevelWizard.vue` (TASK-EAR-015).

1. **State** (replace `createGroupName` ref): `LANGS` (th/en/zh/fr/es, zh→CN),
   `nameByLang` reactive map, `nameSrcLang` (`LangCode | ''`), `namePreviewLang`
   (`LangCode`, default `th`), `translatingName`. Computeds `nameInput`
   (binds the input to `nameByLang[nameSrcLang]`) and `nameSaveText` (trimmed
   source-language text = what is persisted).
2. **UI** (replace the single Group Name `<input>`): per Figma — a card with the
   "Original language" `<select>` (custom `lucide:chevron-down`, placeholder shown
   = force-pick), a single-line Group Name input (disabled until a language is
   picked), and a full-width Translate button; then a separate preview card with
   TH/EN/CN/FR/ES tabs, a 3-bar skeleton while translating, and a small Thai note
   that only the source language is saved for now.
3. **Translate**: `POST /admin/translate` with `{ source_lang, fields: { detail } }`
   (the User translate handler only accepts `detail`/`condition` keys — confirmed
   in translation.go), reading `res.fields.detail[lang]`.
4. **Open modal reset**: clear `nameByLang`, set `nameSrcLang=''` (force-pick, per
   Figma placeholder) and `namePreviewLang='th'`.
5. **Save** (`submitCreateGroup`): `name = nameSaveText.value` (source language
   only), with `// TODO(localized)`. Required-name guard reads `nameSaveText`.
6. **Submit button** disable check uses `nameSaveText` instead of `createGroupName`.

## Acceptance Criteria

- [ ] Create Game Grouping shows the translate UI (source-language selector,
      Group Name input, Translate, TH/EN/CN/FR/ES preview tabs, skeleton, note).
- [ ] Translate calls `POST /admin/translate` with `source_lang` and
      `fields.detail`, filling the preview tabs from `res.fields.detail`.
- [ ] Submit persists only the source-language name into the existing `name`
      string; payload shape (`name/isActive/isHighlight`) otherwise unchanged.
- [ ] Required-name validation and the submit-button disable both reflect the
      source-language text.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.

## Risks

- Translate handler accepts only `detail`/`condition` keys — handled by sending
  the name under `detail` (same as TASK-EAR-015).
- Browser smoke is login-gated; build is the primary automated gate. Live API
  smoke is the user's.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Optional manual smoke (admin session): open Create Game Grouping → pick source
  language → type name → Translate → confirm preview tabs fill → add a game →
  create → confirm the category is created with the source-language name.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: focused single-file frontend change mirroring the approved TASK-EAR-015 pattern.
