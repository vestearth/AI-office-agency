# TASK-EAR-125 — Scope Redemption Item Collection Tag picker to the selected Brand

## Source

QA report (2026-07-17), Redemption > Item > Create/Edit > Collection Tag.

**Actual:** the Collection Tag picker lists every tag in the system, including
tags that do not belong to the selected Brand.

**Expected (QA):**
1. Collection Tag shows only the selected Brand's tags.
2. Brand must be selected before Collection Tag is selectable.
3. Multi-select rendered as checkboxes.

## Findings

The brand-tag link already exists and is authoritative. No backend work.

- `redemptions.tag_ids` and `redemptions_tags.redemption_ids` are mirrored
  bidirectionally, inside the same transaction, on every tag/brand create and
  update — `Games-Labs-Order/internal/core/repositories/redemption_tag_sync.go`
  (`syncTagsForRedemptionTx` / `syncRedemptionsForTagTx`, called from
  `tags.go:105,150` and `redemption.go:187`).
- `GET /api/v1/admin/redemptions` already returns `tagIds` per brand. The
  Library > Brand list renders exactly that as its Collection Tag column, so the
  field is populated live.

Both item screens fetch this and discard the link:

- `app/pages/admin/manage/redemption/items.vue:127` — `toOptions()` keeps only
  `{id, name}`, dropping `tagIds`, and passes the flat global
  `/redemptions-tags` list to the modal as `tagOptions`.
- `app/pages/admin/manage/redemption/items/edit/[id].vue:586` — `allTagNames`
  spreads the entire tag map.

Two corrections to the QA report:

- Expected #3 is **edit-page only**. `RedemptionItemCreateModal.vue:565` already
  renders checkboxes (QA's own screenshot 3 confirms). The edit page uses an
  add-only remaining-tags list (`availableTagsToAdd`), which is what screenshot 1
  is annotated against.
- The edit page tracks tags by **name**; the create modal tracks by **id**.
  Brand filtering is id-based, so the edit page needs a name→id resolve.

## Decisions (operator, 2026-07-17)

- **Legacy out-of-brand tags:** existing items hold tags their brand does not own
  (QA's item `test` on brand COINING carries Gadget/FASION/Lifestyle, which
  COINING does not own). On load these are **kept and flagged removable** — the
  picker offers only the brand's tags, but nothing is deleted without an explicit
  admin action. Do not strip on load; it would silently discard saved data and
  dirty the form before the admin touches it.
- **Brand change:** **clear** the tag selection. Cannot leave an invalid combo.

## Scope

Frontend only — `Games-Labs-backoffice`. No proto, gateway, or Order change.

1. `items.vue` — carry `tagIds` through into the brand options instead of
   dropping it; pass brand-scoped tags to the modal.
2. `RedemptionItemCreateModal.vue` — scope the tag list to the selected brand;
   disable/empty the picker until a brand is chosen; clear tags on brand change.
3. `items/edit/[id].vue` — same scoping + brand gate + clear-on-change, and
   convert the add-only list to the create modal's checkbox multi-select.
   Preserve and flag out-of-brand tags per the decision above.

## Out of scope

- Backend filter params on `/redemptions-tags` (`redemption_id`) — the client
  already has the data; noted in items.vue as TASK-080 handoff B3.
- Reconciling existing items whose saved tags violate their brand (data cleanup).

## Verification

- Create: pick brand → only that brand's tags listed; no brand → picker gated.
- Edit: item `test` / brand COINING opens with Gadget/FASION/Lifestyle still
  selected and flagged; picker offers only nt/test/Game/6.
- Edit: change brand → selection clears.
- Typecheck + lint green; authenticated smoke on the prod-build preview (:3010).
