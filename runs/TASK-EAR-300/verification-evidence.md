# TASK-EAR-300 — Verification Evidence (tracked summary)

Local command ledger (gitignored by office allowlist, present on operator
disk): `runs/TASK-EAR-300/evidence.yaml` + `evidence/ev-001.log` … `ev-010.log`.
Narrative companion (also local): `staging-acceptance-evidence.md`.

Recorded 2026-08-25 via `scripts/record-evidence.sh` for SPAR-18 artifact
cleanup after reviewer caveats.

| Id | Result | What |
| --- | --- | --- |
| ev-001 | PASS | Wallet `TestPrepareCheckoutOrder_CouponBusinessFailureOn200` on `ae3b60b` |
| ev-002 | PASS | Order `90088df` ancestor of `origin/staging` |
| ev-003 | PASS | Wallet `ae3b60b` ancestor of `origin/staging` |
| ev-004 | PASS | Gateway `ce2b246` ancestor of `origin/staging` |
| ev-005 | PASS | Staging payment swagger contains `orderId` |
| ev-006 | PASS | Staging order swagger has no internal checkout RPCs |
| ev-007 | PASS | Mobile handoff single source committed in knowledge-base at `bb00fee` |
| ev-008 | PASS (blocker recorded) | Admin discount-coupons list → `401 UNAUTHORIZED` — no admin bearer in runtime; E2E coupon delete not performed |
| ev-009 | PASS | Companion `staging-acceptance-evidence.md` present (pre-edit hash) |
| ev-010 | PASS | Companion re-hashed after reference/cleanup notes updated |

## Mobile handoff (AC6)

- Path: `knowledge-base/Knowledge Base/10 Projects/Games Labs Order/Coupon-Aware Stripe Checkout — Mobile Handoff Note.md`
- Commit: `bb00fee705192526690701dcc481115e157141cf` (local `knowledge-base` `main`; not pushed in this pass)
- Duplicate `… Mobile Handoff.md` without `Note` was already absent; only the Note file remains

## Test coupon cleanup

Codes still on staging per acceptance narrative: `E2EFIX1`, `E2EINACTIVE`,
`E2EFUTURE`, `E2EEXPIRED`. Operator cleanup:

`DELETE /api/v1/admin/discount-coupons/{id}` with admin token
(`RequireAdminAPIAccess` / `PERM_ORDER_MANAGEMENT`).
