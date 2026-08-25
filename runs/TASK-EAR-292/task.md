# TASK-EAR-292 — Staging verification and release handoff for Admin Monitoring

## Type

devops

## Workstream

devops

## Goal

Verify the released Admin Monitoring flow on staging and produce an evidence-backed release handoff.

## Scope

- Cross-repository verification only after all implementation tasks merge.
- Verify source, build/tests, deployment, authenticated runtime acceptance, and any data-effect evidence separately.

## Acceptance criteria

1. A staff-authenticated staging journey generates and reads one event from each source domain exactly once.
2. Unauthorized requests are rejected.
3. Report aggregates and their corresponding drill-down rows agree for seeded/controlled activity.
4. Deployment revision, test evidence, runtime API/UI evidence, and remaining production gaps are recorded separately.

## Dependencies

Blocked on TASK-EAR-283, TASK-EAR-286 through TASK-EAR-291, and TASK-EAR-301
(Missions, split out of TASK-EAR-289).
