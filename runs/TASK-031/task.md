# TASK-031: Produce Daily Activities backoffice and API form specification

Epic: Missions Daily Activities v1

Parent: TASK-027

Type: investigation

Priority: high

Depends On:
- TASK-028

Target Services:
- Games-Labs-Missions
- api-gateway
- shared-lib

Target Files:
- ai-dev-office/runs/TASK-031/task.md (created) -- PM blueprint for backoffice/API specification work.
- ai-dev-office/runs/TASK-031/status.yaml (created) -- initialized workflow state.
- ai-dev-office/runs/TASK-031/pm-output.yaml (created) -- structured PM handoff payload.
- shared-lib/proto/missionspb/missions.proto (modify if spec drives contract refinements) -- align admin/user API contract with the approved form spec.
- Games-Labs-Missions/README.md (modify) -- document supported config fields and validation behavior if this repo is the source of truth for API usage notes.

Overview:
Produce the field-level backoffice and API form specification for Daily Activities v1 so backend, frontend, and operations share the same configuration model. The output must include field matrix, validations, endpoint contract, example payloads, list/detail view behavior, and explicit v1 exclusions such as multi-condition AND logic and milestones.

Objectives:
1. Define the admin/backoffice create-edit form fields for all four v1 condition types.
2. Define validation rules and mutually exclusive field behavior so backoffice cannot create unsupported combinations.
3. Define list/detail/progress/claim API shapes and example payloads aligned with TASK-028 and TASK-027.
4. Clarify operational UX for timezone display, active state, claim limit, and current-day progress visibility.

Acceptance Criteria:
- A field matrix exists for create/edit forms, clearly marking required, optional, hidden, derived, and read-only fields by condition type.
- Validation rules cover one-condition-per-activity, threshold requirements, allowed game or game-type selection, spend currency restriction, reward fields, `Asia/Bangkok` reset semantics, and claim-limit constraints.
- The spec defines admin endpoint contracts and example payloads for create, update, list, activate/deactivate, and detail/inspection flows.
- The spec defines user-facing payload expectations for current progress, completion eligibility, and claimed status.
- Unsupported v1 features are called out explicitly: multi-condition AND, milestones, and promotional-included activities.
- The output is detailed enough for backend and frontend to implement against the same source without field drift.

Test Plan:
1. Walk every v1 condition type through the field matrix and confirm the form supports it without unsupported combinations.
2. Validate example payloads against the intended contract from TASK-028/TASK-027.
3. Review admin list/detail fields for operational usefulness and audit expectations.

Risks and Mitigations:
- Form design may drift from actual event/consumer contract.
  - Mitigation: require the spec to reference TASK-028 and TASK-027 directly and update only after contract freeze.
- Too much flexibility in backoffice may expose unsupported v1 features.
  - Mitigation: encode hidden/disabled fields and explicit exclusions in the field matrix.
- UX may omit critical operational visibility such as claimed status or activity active state.
  - Mitigation: include list/detail and inspection views, not just create/edit fields.

Assigned Agent: dev-2

Reviewer Focus:
- Confirm the output is implementable by both backend and frontend without needing another discovery pass.
- Confirm the spec enforces v1 boundaries instead of quietly reintroducing milestones or AND logic.
