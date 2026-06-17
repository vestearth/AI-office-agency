# TASK-EAR-005: Wire Backoffice Store Exchange to Order + Wallet Sync

## Short name
`backoffice-store-exchange-sync`

## Type
feature

## Priority
high

## Parent / Epic
- Parent: `TASK-EAR-001`
- Epic: Admin Store Exchange Management

## Status
Blocked until `TASK-EAR-003`, `TASK-EAR-004`, and `TASK-EAR-006` are complete in
the target environment.

## Background

`Games-Labs-backoffice/app/pages/admin/manage/store/exchange.vue` currently uses
mock rows and local mutations. It must use real admin APIs:
- Order Admin package CRUD for the exchange preset catalog.
- AdminWallet rate catalog APIs for production-grade sync of exchange rates.

The page must keep existing UX behavior where possible while replacing mock data
with real pending/error/sync states.

## Scope

### Target services

| Service | Role |
| --- | --- |
| `Games-Labs-backoffice` | Replace mock exchange page state with real Order + Wallet admin API integration. |

### Affected files

| File | Action | Notes |
| --- | --- | --- |
| `Games-Labs-backoffice/app/pages/admin/manage/store/exchange.vue` | modify | Replace mock rows/create/edit/delete with API-backed data and sync states. |
| `Games-Labs-backoffice/app/composables/useAdminStoreExchangeApi.ts` | create | API helper for Order packages + AdminWallet rate catalog sync. |
| `Games-Labs-backoffice/app/composables/useApiBearerHeaders.ts` | inspect only | Reuse existing bearer/admin headers. |
| `Games-Labs-backoffice/app/composables/useAdminSaveFeedback.ts` | inspect/modify only if needed | Reuse existing confirm/toast/error feedback patterns. |

## API usage

### Order catalog source

Use AdminOrder package CRUD:
- `GET /api/v1/admin/order-packages?type=PACKAGE_TYPE_EXCHANGE&active=true&includeAll=true`
- `POST /api/v1/admin/order-packages`
- `PUT /api/v1/admin/order-packages/{id}`
- `DELETE /api/v1/admin/order-packages/{id}`

Map fields:
- `code_name`: stable exchange code, e.g. `ex_25`
- `type`: exchange / `PACKAGE_TYPE_EXCHANGE`
- `name`: UI display name
- `price_diamonds`: Diamond input
- `reward_coins`: Coin output
- `image_url`: thumbnail
- `active`: enabled state
- `sort_order`: list order if needed

### Wallet sync target

Use AdminWallet rate catalog routes from `TASK-EAR-004`:
- `POST /api/v1/admin/wallet/rate-catalog`
- `POST /api/v1/admin/wallet/rate-catalog/{rate_key}/deactivate`

For create/update, upsert:
- `rate_key = exchange.${code_name}`
- `domain = exchange`
- `input_unit = DIAMOND`
- `output_unit = COIN`
- `numerator = reward_coins`
- `denominator = price_diamonds`
- `rounding_mode = floor`
- `is_active = true`

For delete/deactivate, deactivate `exchange.${code_name}` after the Order package
is deleted/deactivated.

## Required behavior

- Loading shows pending state and then real exchange rows from Order.
- Empty/error states are visible and operationally useful.
- Create saves the Order package first, then syncs Wallet rate catalog.
- Update saves the Order package first, then syncs Wallet rate catalog.
- Delete/deactivate updates Order first, then deactivates Wallet rate catalog.
- If Order save fails, do not call Wallet sync.
- If Wallet sync fails after Order succeeds, show an explicit partial-success
  error with a retry path; do not silently hide drift.
- Add a retry sync action for a row that replays Wallet upsert from the current
  Order package data.
- Use existing Backoffice runtime `apiBaseUrl` behavior and bearer headers.

## Acceptance criteria

- [ ] The Exchange page no longer seeds mock `Array.from({ length: 200 })` rows.
- [ ] List/create/update/delete use gateway admin APIs with auth headers.
- [ ] Row mapping handles both proto lowerCamelCase and fallback field variants if existing AdminOrder responses differ.
- [ ] Wallet sync payload uses `exchange.${code_name}` and `DIAMOND -> COIN` values from the saved package.
- [ ] Partial sync failure is visible to the operator and can be retried.
- [ ] `npm run typecheck` or the repo's Backoffice typecheck command is no worse than baseline.
- [ ] Browser smoke against `/admin/manage/store/exchange` verifies load, create/update modal behavior, and no text overlap/regression in desktop viewport.
- [ ] E2E smoke confirms created preset appears in `GET /api/v1/store/rates` after sync and deploy.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-005` passes.

## Out of scope

- Adding new backend fields to Order packages.
- Calling Wallet direct HTTP paths outside api-gateway.
- Changing Missions runtime exchange behavior unless E2E smoke proves it no
  longer consumes the synced catalog correctly.

## Assignment

- Primary: `dev-2`
- Parallel: `false`

Reason: frontend integration must coordinate two admin API domains and handle
partial failure/drift carefully.

## Next action

After `TASK-EAR-003`, `TASK-EAR-004`, and `TASK-EAR-006` are complete/deployed,
run `./ai-dev-office/run-agent.sh TASK-EAR-005 dev-2`.
