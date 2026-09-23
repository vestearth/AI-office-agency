# TASK-EAR-382 — Redemption item edit uses Point only

## Origin

On 2026-09-23 the operator asked to remove the Currency control from
`/admin/manage/redemption/items/edit/:id` because redemption pricing should use
Point only. This is a bounded Backoffice follow-up to completed TASK-EAR-329;
that task's history and status remain unchanged.

## Scope and acceptance

- Owner: `Games-Labs-backoffice` (frontend). Related: TASK-EAR-329.
- Remove the Currency selector and footer from the edit page's Price card.
- Show Point artwork, label and accessible control names.
- Send `priceCurrency: 'POINT'` on item update while retaining `priceAmount`
  and legacy `point` in the payload.
- Update focused regression assertions. Do not change the Order, Wallet, gateway,
  mobile or shared-lib contracts, or rewrite historical redemption records.

## Implementation checkpoint — 2026-09-23

The Backoffice change was committed as
`ffd298013a040e508600a625eab9cb94df573adf` on
`task/TASK-EAR-382-point-only-redemption-edit` and pushed to `origin`.
It changes:

- `app/pages/admin/manage/redemption/items/edit/[id].vue`
- `tests/redemptionDiamondPrice.test.mjs`

The dropdown and its currency state were removed. The update body now forces
`POINT`; the Price card and non-positive-price error name Point. The create
modal had no currency selector and was not changed.

Verification in this checkout:

- `node --import ./tests/register-hooks.mjs --test tests/redemptionDiamondPrice.test.mjs` — 8 passed, 0 failed.
- `npm run build` — completed successfully (existing Nuxt warnings).
- `git diff --check` — passed.

This is source/build evidence, not a rendered authenticated edit/save check,
PR review, merge, staging deploy or production proof. A pre-existing DIAMOND-priced item
will show its numeric `priceAmount` as Point on this page and saving it will
convert that item's price currency to POINT with the same numeric amount. That
conversion needs deliberate review before such an item is edited. The backend
and mobile contracts still support DIAMOND; this task only changes Backoffice
item editing.

## Next step

Review the pushed diff and the legacy-item conversion behavior. Open a
Backoffice PR targeting `main` when ready for review; verify an authenticated
edit/save on the deployed environment before claiming runtime acceptance.
