# TASK-EAR-238 — Manage Payment Gateway (queue #4)

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-237
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| 1 | TASK-EAR-235 | Game → Game / Group full connect |
| 2 | TASK-EAR-236 | Redemption → Library / Item |
| 3 | TASK-EAR-237 | Promotion → Free Coin |
| 4 | **TASK-EAR-238** (this) | Payment Gateway |

## Goal

Replace the Manage → **Payment Gateway** catch-all mock (`useAdminPageData` + `mockPaymentGateways`) with a real admin surface backed by an owned service contract through api-gateway — or an operator-approved deferral with the menu removed/hidden until ready.

## Verified current state (2026-08-08)

- Figma Manage sidebar includes Payment Gateway.
- BO menu links to `/admin/manage/payment-gateway` but there is **no dedicated page** — catch-all mock table (PromptPay / TrueMoney / Credit Card seeds).
- Wallet already has **player** Stripe Checkout + webhook (`/payments/stripe-webhook`) and Ubit — that is **not** an admin Payment Gateway catalog CRUD.
- Player Purchase history Payment methods column remains `-` until Order exposes a method label (separate follow-up note).

## Acceptance criteria

1. Product decision: admin catalog of gateways vs config-only vs hide menu until PSP admin exists.
2. If building: dedicated page (not catch-all mock); list/create/update (MVP) via typed admin proto + gateway; no silent mock when authed.
3. Clear boundary with Wallet Stripe/Ubit runtime — admin page must not pretend to configure Checkout secrets in git.
4. shared-lib → owning service → **api-gateway staging** bump when contract lands.
5. Smoke or focused tests for MVP; secrets stay in env/secret manager only.

## Out of scope

- Wiring Player Detail Payment methods column (blocked on Order method field).
- Closing EAR-191 store-payment webhook (separate security track).
- Casper Stripe (different product).

## Sources

- Figma Manage IA on `381:4618`
- `Games-Labs-backoffice/app/composables/useAdminPageData.ts` (`manage/payment-gateway`)
- `Games-Labs-Wallet/internal/core/services/paymentsvc/`
- `api-gateway/gateway/http.go` (`/payments/stripe-webhook`)
