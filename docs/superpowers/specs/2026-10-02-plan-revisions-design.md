# Phase 2A — Plan Revision Record

**Status:** design, pending review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A completion gates, 1B authorization ledger and dispatch check, 1C partial branches, 1D failure classification (all merged).

## Summary

When a task's plan or scope changes mid-run, record that change as an append-only **revision** in `status.yaml`, through a governed writer that, in the same transaction, either declares the completion gates and branches the change implies or records an explicit, reasoned assertion that none are needed. A revision cannot be recorded while silently skipping the gate question.

This is the smallest slice that closes the gap the replay of five real runs found (below). It adds no per-task artifact: the Execution Blueprint (`execution.yaml`) stays deferred.

## Evidence: replaying TASK-VS-003/004/006/008/010

Method: each run's `status.yaml` and `task.md` on origin/main (2c87cd25) was replayed against the Phase 1A-1D model. "Representable" means expressible with existing constructs without fabricating state that was not true at the time. The full table is in the appendix.

Findings that bear on this slice:

- **The model is shipped but unused.** On origin/main, of the 512 tracked task `status.yaml` files, 0 use `completion_gates`, 0 use `requires_authorization`, and 1 uses `branches`; 0 tracked `meta.yaml` carry a `failure_classified` event (`meta.yaml` is not synced, so this undercounts and is only indicative). The structured keys are not dense; `history[].reason` prose is (entries of 60-280 words).
- **Plan or scope changed mid-run in three of the five runs.** VS-003: the bank budget was raised 700 -> 1200 and a second wave was added after production evidence overturned the original diagnosis. VS-010: a small timezone fix became a historical-data backfill plus an operator-run production correction. VS-004: one task split into an executable wave and a decision-blocked wave. In every case the change, who made it and what it implies exist only in prose and in appended `task.md` sections.
- **Gate declaration is manual** (a documented 1A limit), so the scenario the authority model targets most, a small fix expanding into production data work, is the one in which no gate gets declared. In VS-010 nothing would have declared `production_backfill`, so the completion guard would have protected nothing new.
- The other prose-only patterns (promotion chains and "X waits on Y" ordering, follow-up work, deploy execution records, intra-phase iteration) are real but are separate concerns; see Deferred.

The maintainer's stated condition for a dedicated Blueprint was that `status.yaml` becomes unreasonably dense from branching, dependencies, authority, recovery and topology. The replay does not meet it: the contract keys are unused, and the strain that exists is unstructured prose. None of the findings above requires a new per-task artifact.

## Concepts kept separate

| Concept | Question | Where |
|---|---|---|
| Decision | What should we do? | `decision.yaml` (unchanged) |
| Authorization | May this declared action happen? | `authorization.yaml` (unchanged) |
| Completion | Is the task objectively complete? | `completion_gates`, `branches` (unchanged) |
| Revision | What changed in the plan or scope, and what does it add to the completion contract? | `revisions` in `status.yaml` (new) |

A revision does not authorize anything, does not decide anything, and does not change completion rules. It records a change and forces its consequences into the existing completion contract.

## Non-goals

- `execution.yaml`, stages, dependency graphs, topology or delegation selection.
- A declarative authority matrix; automatic gate discovery; any check that a revision *should* have been recorded (nothing can know that the scope grew).
- Blocking `done` on revisions as such (see Design 3: the declared gates do that).
- Verifying who `actor` is, or that the reason is true. No separate "who decided" field: the writer records `actor` and `reason` only, the same trust level as gates and branches.
- Marking an existing gate or branch `na` through a revision (narrowing). `scope_narrowed` is recorded as a label; resolving gates and branches keeps using their own writers.
- Automatic coupling to 1D failure classification. After an `invalid_assumption` classification a revision is the natural next record, but nothing links them in code.
- Dashboard or `status` command visibility.
- Migrating or back-filling revisions for existing runs.

## Design

### 1. Data

A new optional top-level `revisions` list in `status.yaml`, append-only. Tasks without it behave exactly as before.

```yaml
revisions:
  - id: rev-001
    at: "2026-09-28T08:00:00Z"
    kind: scope_expanded
    actor: dev
    reason: "Operator chose to ship a backfill for rows written with the old timezone"
    effects:
      gates_declared: [production_backfill]
      branches_declared: []
  - id: rev-002
    at: "2026-09-28T09:10:00Z"
    kind: plan_changed
    actor: dev
    reason: "Second root cause found in staging; same files, same risk"
    no_new_gates: "same files and the same deploy path as the existing gates"
```

- `id`: `rev-NNN`, three digits minimum, growing past 999. Compared and ordered by numeric suffix, never as strings (the same rule as `authz-NNN`). The next id is `max + 1`, computed under the task lock.
- `at`: UTC `YYYY-MM-DDTHH:MM:SSZ`, one clock read per write.
- `kind`: one of `scope_expanded`, `scope_narrowed`, `plan_changed`, `acceptance_changed`. It is a label for readers and queries; no behavior depends on it.
- `actor`, `reason`: non-empty strings. `actor` is free text (same limit as 1A/1B).
- Exactly one of:
  - `effects`: a map with `gates_declared` (list of gate names) and `branches_declared` (list of branch names), at least one non-empty. Both lists are always written (possibly empty).
  - `no_new_gates`: a non-empty string saying why the change adds nothing to the completion contract.
- Revisions are never edited or removed by any writer. A later revision supersedes an earlier one by being later.

### 2. The writer

```
ruby scripts/revise-task-plan.rb <TASK_ID> <kind> --actor A --reason R
    ( [--gate NAME[:ACTION]]... [--branch NAME:ready | --branch NAME:blocked:WAITING_TEXT]...
      | --no-new-gates "WHY" )
```

Flag spelling is an implementation detail; the semantics below are binding.

- `--gate NAME` declares an unbound gate. `--gate NAME:ACTION` declares a gate bound to that authorization (`ACTION` must be one of the six `AuthorizationLedger::ACTIONS`). Names follow `CompletionGuard::GATE_NAME_PATTERN`.
- `--branch NAME:ready` or `--branch NAME:blocked:TEXT` declares a Phase 1C branch. `TEXT` is everything after the second colon (waiting reasons may themselves contain colons) and becomes the branch's single `waiting_for` entry. A branch with several waits is declared with one and extended with the branch writer.
- Passing neither effects nor `--no-new-gates`, or both, is refused (exit 2). A bare revision cannot be recorded.
- **One transaction.** Under the per-task `.lock` and the ownership fence (`TaskOwnership.fence!`), with one clock read, the writer: creates each declared gate; creates each declared branch and applies `BranchProjection.apply!` (which may move the task phase, exactly as the 1C writer does); appends the revision; appends status history rows; writes `status.yaml` once through a temp file and rename. Any refusal writes nothing.
- A declared gate is an ordinary gate. It is created exactly as `update-completion-gate.rb declare` would create it (`status: pending`, the revision's `actor` and `reason`, `updated_at`, empty `evidence_refs`, `requires_authorization` when `ACTION` is given), with the same history row that writer emits. The gate record gets no new key. The link runs one way, revision -> names.
- History: one row per gate and per branch in the existing formats, plus one row `plan revision rev-NNN: <kind>` carrying the reason.
- Refusals (exit 2): a finished task (`done`, `aborted`); a task in a phase outside `BranchProjection::UPDATABLE_PHASES` when branches are declared; a gate or branch name that already exists (declare is create-only, as in the existing writers); an unknown `kind`; an unknown authorization action; a malformed name. Exit 3: unreadable or malformed `status.yaml`, `revisions`, `completion_gates` or `branches` (the writer refuses to build on state it cannot read). Exit 9: ownership fence (as the other writers).
- **Idempotency.** If the last revision is identical (same kind, actor, reason and effects or assertion) the writer prints that it is already recorded and exits 0 without writing. Checked before any gate or branch creation, so a retry after a crash between "wrote" and "printed" does not fail on "already declared".
- A `plan_revised` event is appended to `meta.yaml` as an informational mirror (via `CompletionGuard.append_meta_event!`). `meta.yaml` is not synced; the record of truth is `status.yaml`.
- The gate and branch record construction is extracted from `update-completion-gate.rb` and `update-task-branch.rb` into shared helpers used by both the existing writers and the new one. The existing writers' output is unchanged byte for byte, pinned by tests.

### 3. How it connects to the existing phases

- **Teeth come from existing guards.** A declared gate blocks `done` through the 1A completion guard; a gate declared with `ACTION` is bound and needs a valid grant, and while it is pending a dispatch of a configured role is checked by the 1B.2 dispatch check. A declared branch must reach `done` or `na` before the task can (1C). This slice adds no new `done` rule.
- **1D.** The expected flow after an `invalid_assumption` or other re-plan is: classify the failure (1D), then record the new plan as a revision. They are independent records.
- **Not sync-dependent on new files.** Everything lives in `status.yaml`, which is already team-synced. (The authorization ledger `authorization.yaml` currently is not; that is a separate, already-reported defect, and bound gates declared through revisions rely on its fix.)

### 4. Validator, schema, completion guard

- `schemas/status.schema.yaml` documents `revisions`; `validate-yaml.rb` is the runtime truth and `tests/integration/schema-validator-parity.sh` pins both.
- Stored-state validation of `revisions`: a list of maps; `id` matches `rev-NNN`, ids unique and strictly increasing in file order; `kind` in the enum; `actor`, `reason` non-empty strings; `at` a UTC timestamp; exactly one of `effects` / `no_new_gates` (with the shapes above); every gate named in `gates_declared` exists in `completion_gates` and every branch named in `branches_declared` exists in `branches`.
- `CompletionGuard` is unchanged. A task with no `revisions` is unaffected. A malformed `revisions` is a validation error, not a guard concern.

### 5. Files

| File | Change |
|---|---|
| `scripts/revise-task-plan.rb` | New governed writer. |
| `scripts/update-completion-gate.rb`, `scripts/update-task-branch.rb` | Use the shared record-construction helpers; behavior unchanged. |
| shared helper (name decided in the plan) | Gate and branch declare-record construction, plus the revision-entry builder and its shape check, in one place so the writer and the validator cannot drift. |
| `validate-yaml.rb`, `schemas/status.schema.yaml` | `revisions` rules (above). |
| `tests/integration/plan-revisions.sh` | New suite. |
| `tests/integration/schema-validator-parity.sh` | Pins the new enum and shape. |
| `docs/plan-revisions.md`, `docs/task-transition-contract.md` | The record, the writer, the limits. |

## Tests

New suite `tests/integration/plan-revisions.sh`. Each behavior is seen failing before its implementation.

Replay fixtures (shapes taken from the real runs):
- VS-010 shape: a task in `review` with no gates; `scope_expanded` declaring `production_backfill:production_backfill`. The gate exists, is bound and pending; a `done` writer is refused until it is passed with a valid grant.
- VS-004 shape: `plan_changed` declaring `wave_1` ready and `wave_2` blocked with a wait; the 1C projection applies; `done` is refused while a branch is unresolved.
- VS-006 shape: `plan_changed` with `--no-new-gates`; no gate or branch is created; the revision is recorded.
- VS-003 shape: two consecutive revisions (`scope_expanded`, then `plan_changed`) get `rev-001` and `rev-002`.

Writer:
- neither effects nor assertion, and both, are refused; nothing is written.
- atomicity: a refusal for a later item (a duplicate second gate name) leaves `status.yaml` byte-identical, with no first gate created.
- refusals for a `done`/`aborted` task, an existing gate or branch name, an unknown kind, an unknown action, a malformed name, a blocked branch without text; branches in a non-updatable phase.
- idempotent repeat of the last revision is a no-op (file bytes unchanged); a repeat of an earlier, non-last revision is not.
- numeric id ordering: the id after `rev-999` is `rev-1000`, and ordering and the next-id computation never compare ids as strings.
- the gate record and history rows equal what `update-completion-gate.rb declare` produces for the same inputs (golden comparison), and the branch record and projection equal the 1C writer's.
- concurrency: N concurrent writers produce N distinct, increasing ids and no lost update.
- ownership fence: a live owner other than the caller causes exit 9 and no write.
- a corrupt `status.yaml`, a non-list `revisions`, a non-map `completion_gates` or `branches` cause exit 3.

Validator and parity:
- stored-state cases for every rule in Design 4, including a revision naming a gate or branch that does not exist.
- a copy of a task containing only `status.yaml` and `task.md` (what a git sync delivers) validates, with revisions and the gates they declared.
- tasks without `revisions` validate as before; the parity suite pins the enum.

Regression: every Phase 1A-1D suite and the existing writer suites pass unchanged; the extracted helpers are pinned by the golden comparisons above.

## Rollout, evidence and rollback

- Additive and opt-in. Nothing changes for a task that never records a revision, so there is nothing to flip.
- Evidence that the slice earns its place: after use, count tasks with `revisions`, and among scope-changing runs the share that recorded one. Adoption (0 of 512 tracked tasks use gates or authorization, 1 uses branches) is not solved here: this slice makes a recorded revision unable to skip the gate question; it does not make anyone record one. Whether to prompt at intake or on declaring a gate after work began is deferred until there is usage data.
- Rollback: a revert. Recorded `revisions` become inert data. The gates and branches a revision declared are ordinary gates and branches and keep protecting completion under the pre-slice code, so a revert does not weaken any protection. (To be confirmed by a test in the plan: the pre-slice validator tolerates an unknown top-level key.)

## Documented limits

- `actor` and `reason` are unverified free text; a revision can be recorded by whoever can run the writer, and `status.yaml` can be hand-edited. Same class as the 1A/1B limits.
- Nothing detects that the scope changed. A revision exists only if someone records it.
- `kind` is a label; no behavior depends on it.
- One `waiting_for` entry per branch at declaration.
- `meta.yaml` mirrors are local and are not evidence.

## Deferred

Prompting for a revision at intake or when a gate is declared after work began; narrowing through a revision (`na` of existing gates and branches); stage ordering and dependency (promotion chains, "waits on"); structured follow-up links between tasks; a record of what actually ran for an authorized action (run, SHA, performed-by); a first-class record of domain decisions (for example the VS-004 policy choice); a `status` command and dashboard view of revisions; the Execution Blueprint.

## Open questions for review

1. Naming: "Phase 2A" is proposed because this is the first slice past the 1A-1D set; the maintainer may prefer another label.
2. Is the `kind` enum the right size (four values)?
3. Should declaring a gate after a task has left `assigned` require going through a revision, instead of being free as today? Deferred here because it changes an existing writer's contract.
4. Should a revision be able to `na` an existing gate or branch (narrowing), or is keeping that on the existing writers right?

## Appendix: replay of the five runs

(Source: `runs/TASK-VS-*/status.yaml` and `task.md` on origin/main 2c87cd25; no `meta.yaml` or `evidence.yaml` is committed for these runs.)

| Task | What happened | Representable with 1A-1D? | What was prose-only or strained |
|---|---|---|---|
| VS-003 capacity | 13 history rows, 8 of them `review -> review`; PR chain across three repos main -> staging -> prod; production CloudWatch showed the 5xx came from DB lock contention, not the bank limit, so `review -> assigned`; operator raised the bank budget 700 -> 1200 "overriding the earlier out-of-scope note"; closeout narrowed the claim | Gates (source, merged, deploy_staging, deploy_production, live_load) yes; the re-plan as a 1D `invalid_assumption` (inferred); the narrowed claim as a gate with a reason | The revised plan and the scope change exist only in appended `task.md` sections and prose; eight `review -> review` rows hold real iterations; the PR chain is a sequence, not independent branches |
| VS-004 fairness | wave 1 executable (two items), wave 2 blocked on an A/B/C policy decision and a staging-run approval | Yes, this is exactly 1C (`wave_1: ready`, `wave_2: blocked`); the staging-run approval as a pending bound gate | The real file predates 1C and uses task-level `waiting_for` strings; the A/B/C choice has no structured home (`decision.yaml` carries only workflow verdicts) |
| VS-006 auto-renew | the first fix was incomplete: staging browser testing exposed a second root cause; fixed without leaving `review`; test data changed on staging and later restored; prod deploy on a chat instruction; closed on a customer confirmation relayed by the operator | Yes, including a pending-then-pass unbound gate `test_data_restored`, prod runtime acceptance with the human observation in `reason`, and deploy grants with `via: chat` | 1D routes a classification to another phase, but practice stayed in `review`; a follow-up audit exists only in `next_action` prose |
| VS-008 runtime acceptance | code, merge, staging and production complete; the authenticated runtime response was never observed; kept in review by convention | Yes: the 1A motivating case | the deploy record is prose with run URLs (a staging run cancelled by the workflow concurrency group; the production deployer was not the task's author); no structured record says an authorized action did happen |
| VS-010 timezone -> backfill | a small fix grew into a data backfill, concurrent-migration deadlocks and an operator-run production SQL correction; "deploy waits on the backfill decision" | Authority yes (production_backfill / production_data_mutation grants); the 1B.2 spec already names the manual correction as outside the dispatch check | gates are declared by hand, so when scope expanded no `production_backfill` gate was declared; the sequencing constraint and the follow-up ("serialize boot migrations") are prose |
