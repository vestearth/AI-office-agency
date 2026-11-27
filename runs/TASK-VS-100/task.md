# TASK-VS-100: UpSlip manual QA: 16px body text, step line breaks, step numbers per section

QA feedback on the portal manual article page (`/manual/<topic>/<slug>`) and the admin
manual editor preview. Frontend only: no API, schema, migration or dependency change.

## Scope

1. **Body text 16px.** Manual body content renders at `text-body` (14px) for text blocks,
   `###` sub-headings, table cells, checklist items and callouts, while step descriptions
   already use `text-body-l` (16px). Switch the manual content blocks to `text-body-l`.
   Do not change the global `--text-body` token (used across the whole portal).
   Admin preview (`ManualPreview.vue`) follows (`text-sm` -> `text-base`).
2. **Line breaks in step descriptions.** Admin types Enter in a step description; the admin
   preview shows the break (`whitespace-pre-line`) but the portal step `<p>` has no
   `whitespace-pre-line`, so the newlines collapse into spaces. Add it.
3. **Step numbers restart per section.** Steps are numbered across the whole article
   (`stepNumbers` counter declared outside the section loop) in three places: portal
   `ManualArticleView.vue`, admin `ManualPreview.vue`, admin `ManualArticleEditor.vue` form badge.
   QA expects each section to start at 1. Update the editor `previewHint` copy (th/en).

## Acceptance

- Portal: text, checklist, callout, table and `###` content render at 16px; step descriptions
  keep the admin's line breaks; the second section of
  `getting-started/identity-verification` starts at step 1.
- Admin: preview and form badges match the portal numbering; preview hint no longer says
  numbers run across the article.
- Regression tests seen failing before the fix (per-section numbering, step line break).
- Before switching numbering, check live manual content for an article that relies on
  continuous numbering across sections.

## Repos

- `slip-front-end` (portal) — PR into main
- `slip-admin` (admin editor) — PR into main
