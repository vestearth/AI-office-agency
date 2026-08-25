# TASK-EAR-300 — Verify staging and hand off the coupon flow to Mobile

## Type / workstream / priority

DevOps / devops / high

## Parent / epic

- Parent: TASK-EAR-295
- Epic: Coupon-aware Stripe checkout

## Goal

After implementation merges, deploy in dependency order with explicit operator
authorization, prove the authenticated Stripe test flow on staging, and produce
an exact Mobile integration handoff.

## Scope

- Source/runtime verification across `Games-Labs-Order`, `Games-Labs-Wallet`,
  and `api-gateway` after TASK-EAR-296 through TASK-EAR-299 complete.
- `Games-Lab-Android/` may be read for compatibility comparison but must not be
  modified, formatted, generated, committed, pushed, or included in a PR.
- Deployment is a separate persistent action gate: show target revisions and
  obtain operator confirmation immediately before deployment/merge if not
  already performed by the human.

## Acceptance criteria

1. Record source SHAs, PR/merge state, build/tests, deployment revisions, and
   authenticated runtime evidence separately for Order, Wallet, and Gateway.
2. Deploy/verify in order: Order first, Wallet second, Gateway last. Confirm the
   running services use a shared-lib version containing `a2181ce`.
3. Authenticated staging tests cover: no coupon, valid fixed/percentage
   discount, complimentary reward, invalid/inactive/not-started/expired,
   package/VIP/currency mismatch, quota exhaustion, and duplicate idempotency.
4. Stripe test-mode evidence proves the charged minor units equal Order's final
   quote and metadata binds one payment transaction, Checkout Session, and
   durable Order.
5. Signed success yields `payment_status=paid` and
   `fulfillment_status=fulfilled` exactly once. Expiry/failure releases the
   reservation. A controlled paid-but-fulfillment-failed case remains
   `paid/failed` and is recoverable by webhook retry without duplicate rewards.
6. Mobile handoff documents endpoint/method, request fields, which amount field
   to omit or validate, create/status response shapes, stable error codes
   5023-5031, status polling, idempotency reuse, and the rule that only
   `fulfillment_status=fulfilled` is success.
7. Rollback notes preserve backward compatibility: old clients may omit
   `coupon_code`, new clients tolerate absent `order_id` until rollout is fully
   converged, and internal Order lifecycle RPCs are never called by Mobile.
8. Production remains explicitly unverified unless a separate production
   authorization and evidence pass occurs.

## Expected artifacts

- Evidence ledger entries under `ai-dev-office/runs/TASK-EAR-300/evidence.yaml`
- Runtime/release findings in the run output
- Mobile handoff text in the run output or an existing approved handoff/docs
  location discovered before creating a new file

## Risks and mitigations

- Staging Stripe tests can create money-like side effects and coupon usages.
  Use test mode and controlled test users/coupons; record cleanup requirements.
- A 401 proves only route/auth gating. Require a successful authenticated
  business journey and Stripe/webhook state evidence.
- A green deploy is not runtime acceptance. Keep the evidence layers separate.

## Out of scope

- Production deployment, real-money charge, Android changes, or unrelated
  coupon admin UI changes.

