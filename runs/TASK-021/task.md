# TASK-021: Centralize Exchange Rate and Reward Catalog Configuration

## Epic
Points Redemption Reliability and Semantics

## Type
feature

## Priority
high

## Depends On
- `TASK-018` and `TASK-020` should be complete to ensure transactional money-like behavior before dynamic pricing rollout.

## Target Services
- `Games-Labs-Wallet` (recommended owner for monetary/points conversion policy)
- `Games-Labs-Missions` (consumer of config)
- `Games-Labs-Order` (consumer for reward package pricing if applicable)
- `api-gateway` (admin exposure/proxy)
- `shared-lib` (contracts for admin/read APIs if using gRPC)

## Target Files
- Wallet config models/repository/service/handler files for rate catalog
- migrations for new config tables
- Missions/Order adapter client files consuming config
- admin route registration in service + api-gateway
- docs/Postman for config endpoints

---

## Overview
Conversion rules and redemption rates are currently hardcoded in multiple services.
This makes tuning expensive and risky, and allows policy drift between services.

This task introduces a centralized, database-backed rate/catalog service with administrative control and safe rollout behavior.

---

## Target Data Model
At minimum, persist:
- `rate_key` (unique, stable identifier)
- `domain` (`earn`, `redeem`, `exchange`, `reward_price`)
- `input_unit`, `output_unit`
- `numerator`, `denominator` (exact rational rate to avoid float drift)
- `rounding_mode` (`floor`, `ceil`, `nearest`)
- `min_value`, `max_value` (optional guardrails)
- `active_from`, `active_to`
- `version`, `is_active`
- audit fields (`updated_by`, timestamps)

---

## Objectives

### 1) Build central rate catalog APIs
- Provide read API for runtime services.
- Provide admin CRUD/update API with validation and versioning.
- Enforce uniqueness and interval overlap constraints.

### 2) Integrate consumers
- Missions and Order must fetch applicable rates from central source, not constants.
- Add local caching with short TTL + fallback behavior.
- Define fail-closed vs fail-open policy per endpoint (documented).

### 3) Migration from hardcoded rules
- Identify and remove hardcoded conversion constants in services.
- Backfill initial catalog values matching current production behavior.
- Add feature flag for progressive rollout.

### 4) Governance and observability
- Add audit trail for every rate change.
- Emit metric/log for applied rate version during redemption/earn flows.

---

## Non-Goals
- UI dashboard implementation (API-only scope is acceptable).
- Multi-currency FX engine beyond current product units.

---

## Acceptance Criteria
- [ ] Central catalog storage exists with migration and constraints.
- [ ] Admin APIs can create/update/deactivate rates with audit trail.
- [ ] Runtime APIs in Missions/Order consume central rates instead of hardcoded constants.
- [ ] Initial seeded rates preserve existing business outcomes before any admin changes.
- [ ] Feature flag allows controlled rollout and rollback.
- [ ] Postman/docs include new catalog/admin endpoints and examples.

---

## Test Plan
1. **Seed Compatibility**
   - With seeded rates, outputs match legacy hardcoded behavior.
2. **Admin Update**
   - Change one active rate and verify subsequent transactions use new version.
3. **Boundary Validation**
   - Reject invalid rates (zero denominator, overlapping active windows, etc.).
4. **Consumer Fallback**
   - Simulate catalog outage and verify documented fallback policy.

---

## Risks and Mitigations
- **Risk:** Wrong rate update has immediate financial impact.
  - **Mitigation:** staged activation (`active_from`), reviewer approval policy, and rollback toggle.
- **Risk:** Cross-service cache inconsistency.
  - **Mitigation:** short TTL + version in responses/logs.
- **Risk:** Hidden hardcoded constants remain.
  - **Mitigation:** code audit and automated lint/search checks for known constants.

---

## Assigned Agent
`dev-2`

## Reviewer Focus
- Validate numerical correctness (no float precision loss).
- Validate rollout safety (feature flag + seed parity + rollback path).
