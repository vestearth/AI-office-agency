# TASK-EAR-112: Clarify incoming work request

Type: investigation. Workstream: general. Priority: medium.

## Outcome

Turn the currently unspecified request into an implementation-ready task without
guessing the product, repository, behavior, contract, constraints, or delivery
target. This task is a requirement gate only; it authorizes no product-code
changes.

## Scope

- Record the missing request details in this AI Dev Office run.
- After clarification, use the correct product namespace and perform the required
  SocratiCode-assisted discovery plus direct source verification before creating
  an implementation task.
- Do not inspect or modify product repositories until the target product and
  objective are known.

## Questions to resolve

1. What feature, bug, investigation, refactor, or operational outcome is wanted?
2. Which product, repository, service, screen, endpoint, or workflow is in scope?
3. What current behavior or evidence is available, and what should replace it?
4. Are there deadlines, rollout constraints, exclusions, references, logs, or
   acceptance examples?

## Acceptance criteria

- The requested outcome and current problem are recorded in testable terms.
- The target product/repositories and explicit exclusions are identified.
- Available evidence, references, constraints, and expected verification are recorded.
- A follow-up PM plan names every affected service/file supported by SocratiCode
  discovery and direct repository evidence, or explicitly records why discovery
  is unnecessary.
- No implementation agent is dispatched and no product code is changed before
  the clarification gate is complete.

## Plan

1. Free Roam asks the four bounded clarification questions above and records the answers.
2. PM re-evaluates the correct task namespace and creates or amends an implementation-ready plan.
3. Dev performs the resulting scoped work only after the PM handoff names owned files and verification gates.

## Risks

- Guessing the target product could allocate the wrong namespace or change the wrong repository. Mitigation: keep this run as a non-code clarification gate and re-intake under the correct product prefix when required.
- Premature file lists or acceptance criteria could create false scope. Mitigation: leave product files unassigned until the request and repository evidence are available.

## Verification

- `ruby ai-dev-office/validate-yaml.rb TASK-EAR-112`
- Human confirmation that the clarified objective and scope match the intended request.

