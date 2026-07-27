# TASK-EAR-161 — Contact (Facebook/Line/Address) & Device Info (IP/Serial): decide before wiring

## Context

From the 2026-07-27 Player Detail page audit (knowledge-base memory
`detail-page-backend-epic`): Basic Info tab has 2 mock sub-sections not
flagged in any earlier epic:

- **Contact → Facebook, Line, Address** (Phone/Email are already wired
  from `GetUser`).
- **Device Info → IP, Serial**.

Neither has a backing field anywhere in the User proto today
(`shared-lib/proto/admin/adminuserpb` — verify current shape as the first
step). These aren't unwired reads, they're **fields that don't exist yet**
— the gap is a product/data decision, not a plumbing task.

## Objective

Decide, per field, whether it should exist at all before scoping any
schema or wiring work. Deliverable is a decision record, not code.

## Open questions the proposal must answer

1. **Contact (Facebook/Line/Address):**
   - Is this operator-entered (support notes) or user-submitted (profile/
     KYC)? That determines write path and whether it needs its own admin
     edit UI, not just a read.
   - Does this overlap with any existing KYC/verification data already
     captured elsewhere in User or Auth that could be reused instead of a
     new field?
2. **Device Info (IP/Serial):**
   - **Privacy/compliance first**: is storing a player's IP address and
     device serial something Legal/compliance needs to sign off on before
     any schema work? What's the retention and access-control expectation
     if so (who can view it, for how long)? Flag this explicitly — do not
     let a dev agent infer a privacy posture.
   - Is this already captured incidentally somewhere (e.g. login/session
     logs, Auth service) and just needs surfacing, or does new capture
     need to be added at login/session time?
3. For any field the operator confirms should exist: rough schema location
   (User vs a new table) and whether it's admin-editable or read-only
   display.

## Scope

- Investigation/decision only: `Games-Labs-User`, `Games-Labs-Auth`
  (check for incidental IP/session capture already happening),
  `shared-lib/proto/admin/adminuserpb`.
- No schema migration, no proto change, no `Games-Labs-backoffice` FE
  change in this task.

## Acceptance criteria

- Each of the 4 fields (Facebook, Line, Address, IP, Serial) gets an
  explicit decision: keep as-is (never store), store read-only, or
  store + admin-editable — with reasoning.
- Device Info explicitly gets a privacy/compliance flag raised to the
  operator before any recommendation to proceed — this task does not
  self-approve storing IP/device data.
- If nothing should be built, that's a valid and acceptable outcome of
  this task — do not scope implementation just to have output.

## Out of scope

- Any schema migration, proto change, or FE wiring — follow-up task only
  if the operator approves specific fields.
- Purchase → Special Pass/Limited Avatar (TASK-EAR-158), Earned/Redeem/
  Send-coin (TASK-EAR-159), Game tab (TASK-EAR-160), the Order IDOR — all
  separate, unrelated to this task.
