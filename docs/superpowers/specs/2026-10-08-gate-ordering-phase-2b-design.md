# Phase 2B — Gate Ordering

**Status:** design, approved in conversation 2026-10-08; pending written-spec review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A completion gates and 1B.1 authorization binding (merged), and Phase 2A plan revision record (PR #40, open). Implementation starts only after PR #40 merges, because it reuses the gate record helper that PR introduces.

## Summary

A completion gate can declare that it waits on other gates: `after: [A, ...]`. A gate cannot be **passed** until every gate it waits on is resolved. The ordering is declared when the gate is created, or added later while the gate is still `pending`. It can only be added, never removed. Gates without `after` behave exactly as before.

This is the smallest step toward the stage/dependency part of adaptive execution. It adds no per-task artifact. The Execution Blueprint (`execution.yaml`) stays deferred.

## Evidence

- **TASK-EAR-384 and TASK-EAR-385 (2026-10-07/08)** are the first runs to adopt `completion_gates` without being asked. Their gates form an ordered chain: `product_contract → shared_lib_publication → implementation_verification → authenticated_staging` (EAR-384), and `shared_lib_publication → persistence_and_contract_verification → authenticated_staging` (EAR-385). Each gate in practice waits for the previous one. That order exists only in the order the gates were written and in history prose. Nothing stops `authenticated_staging` from being passed before `shared_lib_publication`.
- **The 2A replay** (`2026-10-02-plan-revisions-design.md`, appendix) found the same pattern:
  - VS-003: a PR chain main → staging → prod, "a sequence, not independent branches".
  - VS-010: "deploy waits on the backfill decision".
  - The 2A spec deferred "stage ordering and dependency (promotion chains, 'waits on')".
- **Adoption snapshot (2026-10-08):** 519 run directories in the main checkout. 2 use `completion_gates` (EAR-384, EAR-385, neither yet tracked on main), 0 use `requires_authorization`, and 1 uses `branches`.

Other things the same runs show are real but out of scope (see Deferred):
- Intake gates were written by hand: pending gates with no actor or `updated_at`.
- What actually ran (merge SHA, PR URL) is recorded only in prose.
- Operator merge/push approvals have no authorization action.

## Concepts kept separate

| Concept | Question | Where |
|---|---|---|
| Completion | Is the task objectively complete? | `completion_gates`, `branches` (unchanged rules) |
| Authorization | May this declared action happen? | `authorization.yaml` (unchanged) |
| Revision | What changed in the plan, and what did it add? | `revisions` (2A, unchanged) |
| **Ordering** | **Which gate must be resolved before this one may pass?** | **`after` on a gate (new)** |

Ordering does not change when a task may be `done`: every declared gate must already be resolved before then. It only constrains the order in which gates pass.

## Non-goals

- Ordering between branches, or between a gate and a branch. Only gate-on-gate.
- Refusing or warning at dispatch time (`run-agent.sh`) because of ordering.
- Removing or rewriting an ordering. Narrowing keeps using `na` on the gates themselves.
- Changing the 2A revision writer. A revision that declares a gate is followed by `depend` (Design 2) when it needs an ordering.
- Dashboard or `status` command visibility.
- Backfilling `after` into existing runs, including EAR-384/385. Their operators can run `depend`.
- Governing intake-time gate declaration, structured pass records, or new authorization actions (see Deferred).

## Design

### 1. Data

An optional key on a gate record:

```yaml
completion_gates:
  shared_lib_publication:
    status: pass
    actor: dev-2
    reason: "merged as 05fae97f via SparqLab/shared-lib#88"
    updated_at: "2026-10-07T10:16:42Z"
    evidence_refs: []
  implementation_verification:
    status: pending
    actor: pm
    reason: "Game/gateway implementation verified against the published contract"
    updated_at: "2026-10-08T03:00:00Z"
    evidence_refs: []
    after: [shared_lib_publication]
```

- `after`: a non-empty list of gate names in this task's `completion_gates`. No duplicates, and never the gate's own name.
- Taken over all gates, the `after` relation is acyclic.
- Once a gate has an `after`, every later write of that gate keeps it. The list only grows, and only while the gate is `pending`.
- A gate without `after` is unchanged in shape and behaviour.

### 2. The writer

Everything goes through `scripts/update-completion-gate.rb`, under the existing per-task lock and ownership fence, with the existing single clock read.

**Declare with an ordering**

```
ruby scripts/update-completion-gate.rb <TASK> declare <GATE> --actor A [--reason R]
    [--requires-authorization ACTION] [--after G1[,G2...]]
```

**Add to an existing pending gate** (new action `depend`)

```
ruby scripts/update-completion-gate.rb <TASK> depend <GATE> --after G1[,G2...] --actor A --reason R
```

- `depend` requires `--reason`. It changes only `after`; the gate's `status`, `actor`, `reason`, `updated_at` and `evidence_refs` stay as they are.
- The addition is recorded as a status history row `gate <GATE>: after += G1,G2` (agent `event_agent(actor)`, the given reason, the clock read) and a `completion_gate_updated` meta event.
- The writer's "rebuild the whole record" path must carry `after` forward on every transition (`pass`, `na`, `depend`), exactly as it carries `requires_authorization`. Forgetting it would silently drop the ordering. Tests pin this.
- Flag spelling is an implementation detail; the semantics are binding.

**Pass is ordered**

- `pass <GATE>` is refused (exit 2) unless every gate in its `after` is resolved.
- "Resolved" uses the same definition the `done` guard uses: `CompletionGuard.gate_resolved?(gate, index)`. That means `pass` or `na` with non-empty actor, reason and `updated_at`. A gate bound to an authorization must also satisfy it, as of its own recorded `(updated_at, authorization_through)`.
- The ledger is loaded under the lock only when some gate in `after` is bound. The refusal names every unresolved gate and its status, for example `waits on: shared_lib_publication (pending)`.
- Because a resolved gate can never return to `pending` (declare is create-only), and a bound gate is judged against its recorded snapshot, a pass that respected the ordering stays valid.

**`na` is not ordered.** `na` says the gate does not apply, so there is nothing to wait for.

**Refusals (exit 2, nothing written)**

- An `--after` name that is not a declared gate.
- An `--after` name equal to the gate itself.
- A name repeated in the flag, or already present in `after`.
- An addition that would create a cycle, i.e. the gate is reachable from any named gate through existing `after` edges.
- `depend` on a gate that is not `pending`, or that is not declared.
- `--after` on `pass` or `na`.
- A finished task (`done`, `aborted`), as today.

Exit 3 for unreadable or malformed state now also covers a malformed stored `after`: not a list, not names, or naming an unknown gate. Exit 9 is the ownership fence, as today.

### 3. How it connects to the existing phases

- **1A:** unchanged. The `done` guard still requires every gate to be resolved; ordering adds no `done` rule.
- **1B.1:** a bound gate in `after` counts as resolved only with a valid grant, using the existing snapshot rule. Revoking a grant after a dependency passed does not unresolve it.
- **1B.2:** the dispatch check is unchanged and does not look at `after`.
- **1C:** branches are unchanged; ordering does not apply to them.
- **2A:** the revision writer is unchanged. Gates it declares can be ordered with `depend` right after; they are `pending`, so nothing can pass in between out of order. The gate record helper from 2A (`CompletionGuard.gate_record`) gains an optional `after:` argument. Gates without `after` keep their exact bytes, which the 2A golden (section W of `plan-revisions.sh`) pins.

### 4. Validator, schema, parity

`validate-yaml.rb` is the runtime truth. Stored-state rules for `completion_gates.<name>.after`:

- A non-empty list of strings matching `CompletionGuard::GATE_NAME_PATTERN`, with no duplicates and not the gate's own name.
- Every name exists in `completion_gates`.
- The relation over all gates is acyclic.
- **Ordering invariant:** a gate with status `pass` has every gate in its `after` resolved.
  - With a task directory, "resolved" is checked against the ledger, as the `done` guard does.
  - Without one (single-file validation), only the status rule is checked, so a bound dependency is not reported as unresolved for lack of a ledger.
  - A gate with status `na` or `pending` is not checked against its `after`.

`schemas/status.schema.yaml` adds `after` to the gate record: an array of names with `minItems: 1` and `uniqueItems: true`, using the gate name pattern. `tests/integration/schema-validator-parity.sh` pins the item pattern to the validator's name grammar. Cycles and the ordering invariant are validator-only, the same split as the 2A cross-reference rules.

### 5. Files

| File | Change |
|---|---|
| `scripts/completion-guard.rb` | `gate_record` takes `after:`. A shared helper validates an ordering (shape, existence, self, cycle) and lists unresolved dependencies, used by both the writer and the validator. |
| `scripts/update-completion-gate.rb` | `--after` on `declare`, the `depend` action, the ordered `pass` check, and carrying `after` forward. |
| `validate-yaml.rb`, `schemas/status.schema.yaml` | `after` rules (Design 4). |
| `tests/integration/gate-ordering.sh` | New suite. |
| `tests/integration/schema-validator-parity.sh` | Pins the `after` item grammar. |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | The ordering, the `depend` action, the limits. |

## Tests

New suite `tests/integration/gate-ordering.sh`. Each behaviour is seen failing before its implementation.

**Replay**

- **EAR-384 shape:** four gates declared in a chain with `--after`. Passing `authenticated_staging` or `implementation_verification` early is refused, naming the unresolved gate. Passing them in order succeeds. The task can then reach `done`.
- **EAR-385 shape (adding later):** three gates declared without ordering, then `depend` adds the chain. The recorded history row is `gate X: after += Y`. Ordered pass is then enforced.

**Writer**

- `depend` on a pending gate adds to `after` and changes nothing else on the record (bytes compared, apart from `after`).
- Refusals write nothing (byte-identical `status.yaml`):
  - an unknown name or the gate itself;
  - a duplicate within the flag, or a name already in `after`;
  - a 2-gate and a 3-gate cycle;
  - `depend` on a `pass`, `na` or undeclared gate;
  - `--after` on `pass` or `na`;
  - a `done` or `aborted` task.
- `na` on a gate whose dependency is pending succeeds. A dependency that is `na` counts as resolved.
- **Bound dependency:**
  - pending → the dependent's pass is refused;
  - passed with a valid grant → the dependent's pass succeeds;
  - grant revoked after the dependency passed → the dependent's pass still succeeds.
- **Carry-forward:** after `pass` and after `na`, `after` is still present and unchanged.
- **No change for gates without `after`:** the 2A byte pin (section W) still passes unchanged. A golden compares a gate declared without `--after` with the same gate on the pre-2B writer.
- Exit 3 on a malformed stored `after`. Exit 9 under a foreign lease.

**Validator and parity**

- Every Design 4 rule as a stored-state case, including a hand-edited `pass` whose dependency is pending, in both task-directory and single-file mode.
- A copy of a task containing only the team-synced files (`status.yaml`, `task.md`, `authorization.yaml`) validates, with an ordered chain and a bound dependency.
- Tasks without `after` validate as before. The parity suite pins the item grammar.

**Regression:** every Phase 1A–1D suite and `plan-revisions.sh` pass unchanged.

## Rollout, evidence and rollback

- Additive and opt-in; nothing changes for a gate without `after`.
- **Evidence that it earns its place:** after use, count tasks whose gates carry `after`, and count refused out-of-order passes. EAR-384/385 can adopt it immediately with `depend`.
- **Rollback:** a revert. The pre-2B validator already accepts a gate carrying `after`. This was checked on 2026-10-08: a status with `b: {status: pending, after: [a]}` passes `validate-yaml.rb <path>` on main 379ccd13. Recorded orderings become inert data, and the `done` guard is unaffected. The plan keeps a test that pins this tolerance.

## Documented limits

- `actor` and `reason` are unverified free text, the same as for 1A/1B.
- `status.yaml` can be hand-edited to remove `after`. The validator catches a stored `pass` that broke the ordering, but not a removed ordering.
- Ordering is enforced only when a gate passes. It does not stop work from starting, and it does not affect dispatch.
- Gate-on-gate only.

## Deferred

- Governed intake declaration, so gates declared at intake get actor, time and a history row (the hand-edit seen in EAR-384/385).
- A structured record of what ran when a gate passes (SHA, PR or run URL, performed-by).
- Authorization actions for merge and push.
- Ordering of branches.
- Ordering declared through a 2A revision in the same write.
- Dispatch-time use of ordering.
- `status` command and dashboard view.
- The Execution Blueprint.
