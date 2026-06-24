# TASK-EAR-015: VIP Avatar Description — interim 5-language translate UI (FE-only)

## Short name
`vip-avatar-translate-ui`

## Type
feature

## Priority
medium

## Parent / Epic
- Parent: `TASK-104` (Redemption translate UI — the reference pattern)
- Epic: Backoffice multi-language content

## Status

Assigned. Design approved by user in chat (approach A, TH-first load, with a
"only source language saved for now" note). Claude-advisory lane to implement,
build-verify, and summarize.

## Background

TASK-104 shipped the 5-language AI-translate UI for Redemption Item Details &
Conditions. The user wants the same UI pattern on other backoffice text fields,
starting with **VIP Privileges → Avatar → Description**.

Unlike Redemption, the VIP backend does NOT yet support localized storage:
`userpb.AvatarPrevileges.description` is a plain `string`
(`shared-lib/proto/userpb/userpb.proto:151`). A full 5-language persist would
require proto + DB + service changes in Games-Labs-User, which is out of scope
for this frontend-only task.

Decision (user): build the full translate UI now, but **persist only the source
language** into the existing single-string `description` field. When the User
service gains a localized contract, only the save mapping changes.

## Goal

Add the Redemption-style 5-language translate UI to the VIP Avatar Description
field in `VipLevelWizard.vue`, persisting only the source-language text into the
existing `description` string, without any backend change.

## Scope

### Target Services

| Service | Reason |
| --- | --- |
| `Games-Labs-backoffice` | VIP Avatar Description UI + save/load wiring. |
| `ai-dev-office` | Task tracking and handoff artifacts. |

### Affected Files

| Path | Action | Description |
| --- | --- | --- |
| `Games-Labs-backoffice/app/components/VipLevelWizard.vue` | modify | Add 5-language translate UI to avatar Description; load TH-first; save source language only. |
| `ai-dev-office/runs/TASK-EAR-015/*` | create | PM task, status, handoff artifacts. |

### Explicitly Excluded

- No backend / proto / shared-lib changes (User service localized contract is a
  separate future task).
- No changes to avatar name / collection / images, or to the point / reward /
  games privilege sub-tabs.
- No changes to other pages (Store items, Store avatar edit, Game Grouping) —
  tracked separately; their backends are mock / lack the field.

## Approved Design (spec)

Reference pattern: `RedemptionItemCreateModal.vue` (LANGS, translateField,
src/preview refs, skeleton, chevron-down select).

1. **State** (near `avatarDescription`, line ~93): add `LANGS`
   (th/en/zh/fr/es, zh shown as `CN`), `descByLang` reactive `Record<LangCode,string>`,
   `descSrcLang` (`LangCode | ''`), `descPreviewLang` (`LangCode`, default `th`),
   `translatingDesc`. Add computed `descInput` bound to `descByLang[descSrcLang]`.
2. **UI** (replace the description textarea, line ~1729): mirror Redemption —
   "Original language" `<select>` with custom `lucide:chevron-down` at `right-3`,
   textarea disabled until a source language is chosen, full-width Translate
   button, TH/EN/CN/FR/ES preview tabs, and a 3-bar animate-pulse skeleton while
   translating. **Translate field key = `detail`** (CONFIRMED: the User translate
   handler `translation.go:ValidateTranslationRequest` only accepts `detail`/
   `condition` keys and ignores any other; `description`/arbitrary keys → 400).
   So the call sends `{ source_lang, fields: { detail: <description text> } }` and
   reads results from `res.fields.detail[lang]`. `detail` is just a generic text
   slot to the AI.
3. **Load (edit, line ~816)**: legacy `description` is a single untyped string →
   seed into `descByLang.th` and set `descSrcLang = 'th'` (Thai-first assumption)
   so it is visible and editable immediately.
4. **Save (line ~1084)**: persist source language only —
   `description: (descSrcLang ? descByLang[descSrcLang] : '').trim()`,
   with `// TODO(localized): send languages/description struct once User service supports it`.
5. **Validation (line ~553/562)**: description non-empty check reads from the
   source-language slot instead of `avatarDescription`.
6. **Disambiguation note** under the preview: Thai text — "ปัจจุบันบันทึกเฉพาะ
   ภาษาต้นทาง — ครบทุกภาษาเมื่อระบบพร้อม" (only the source language is saved for now;
   all languages once the backend supports it).

## Acceptance Criteria

- [ ] Avatar Description shows the Redemption-style translate UI (source-language
      selector, textarea, Translate, TH/EN/CN/FR/ES preview tabs, skeleton).
- [ ] Translate calls `POST /admin/translate` with `source_lang` and
      `fields.detail` (the only accepted text-field key), filling the preview tabs
      from `res.fields.detail[lang]`.
- [ ] Edit loads an existing description into the TH slot and shows it immediately.
- [ ] Save persists only the source-language text into the existing `description`
      string; no other payload shape change; no backend change.
- [ ] A note states that only the source language is saved for now.
- [ ] `npm run build` passes in `Games-Labs-backoffice`.

## Risks

- RESOLVED: the translate handler is fixed to `detail`/`condition` keys only
  (`Games-Labs-User/internal/models/translation.go`). This task therefore sends
  the description text under the `detail` key and reads `res.fields.detail`. No
  backend change needed.
- Legacy descriptions may actually be English; the TH-first assumption is an
  accepted interim simplification.
- Browser smoke requires an admin session (login-gated, per TASK-104); build is
  the primary automated gate.

## Verification

- `cd Games-Labs-backoffice && npm run build`
- Optional manual smoke with a real admin session: open VIP edit → Avatar tab →
  pick source language → type → Translate → confirm preview tabs fill → save →
  reopen and confirm the source text round-trips.

## Assignment

- Primary: `dev`
- Parallel: `false`

Reason: focused single-file frontend change mirroring the approved TASK-104 pattern.
