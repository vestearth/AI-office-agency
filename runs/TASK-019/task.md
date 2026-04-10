# TASK-019: Separate Level Progress (EXP/Turnover) from Spendable Wallet Points

## Epic
Points Redemption Reliability and Semantics

## Type
refactor

## Priority
high

## Depends On
- `TASK-018` should be completed first to ensure spendable deductions are centralized in Wallet.

## Target Services
- `Games-Labs-Missions`
- `Games-Labs-User` (if user stats contract includes level progression naming/fields)
- `Games-Labs-Wallet` (read-only validation of ownership boundaries)

## Target Files
- `Games-Labs-Missions/internal/services/level_service.go`
- `Games-Labs-Missions/internal/models/*` (level/progression models)
- `Games-Labs-Missions/internal/handlers/*` (response keys if exposed)
- `Games-Labs-User` stats DTO/handler files if contract terminology must align
- docs where fields are described (README/API notes/Postman examples)

---

## Overview
The platform currently mixes two different concepts:
1) **Level progression metrics** (EXP/turnover/lifetime activity), and
2) **Spendable points currency** used for redemption.

This task cleanly separates semantics and data ownership to prevent user-visible confusion and accidental regression in leveling.

---

## Domain Rules (Target State)
- Level progression values are monotonic/non-decreasing except explicit admin reset tools.
- Wallet spendable points are a balance and may increase/decrease.
- Spending wallet points must never reduce level progression/EXP counters.
- API naming should make the distinction obvious (avoid overloaded `points` labels).

---

## Objectives

### 1) Remove coupling in Missions
- Eliminate any logic path where redemption modifies level progression fields.
- Keep level-up calculations based only on progression inputs (turnover/activities/EXP rules).

### 2) Clarify API and model naming
- Replace ambiguous field names in Missions responses and internals where needed.
- If externally visible keys change, provide backward compatibility or versioned transition notes.

### 3) Align service boundaries
- Missions owns progression state.
- Wallet owns spendable points state.
- User-facing endpoints should clearly show which value is progression vs spendable.

### 4) Add invariants and tests
- Add tests that prove redemption operations do not alter progression values.
- Add tests that progression updates do not alter wallet spendable points directly.

---

## Non-Goals
- No refund/saga flow design (TASK-020).
- No exchange-rate catalog centralization (TASK-021).
- No broad API version bump unless strictly required.

---

## Acceptance Criteria
- [ ] Redeeming wallet points does not decrease level/EXP/progression metrics in Missions.
- [ ] Missions progression endpoints return terminology that clearly represents progression semantics.
- [ ] At least one regression test covers redemption + progression invariants.
- [ ] Documentation/examples show separate concepts for progression and spendable balance.
- [ ] No cross-service DB access is introduced.

---

## Test Plan
1. Snapshot user progression values.
2. Perform one or more redemption operations.
3. Verify progression snapshot is unchanged.
4. Perform progression-producing activity.
5. Verify progression increases as expected while wallet balance changes only via wallet rules.

---

## Risks and Mitigations
- **Risk:** Frontend expects old ambiguous field names.
  - **Mitigation:** temporary alias fields or explicit migration note with rollout window.
- **Risk:** Hidden coupling remains in older handlers/admin paths.
  - **Mitigation:** repo-wide audit for writes to progression fields in redemption flows.
- **Risk:** Product confusion over terminology.
  - **Mitigation:** add a concise glossary to service docs and Postman descriptions.

---

## Assigned Agent
`dev`

## Reviewer Focus
- Validate semantic separation in both code and public response shapes.
- Validate regression coverage for non-decreasing progression invariants.
