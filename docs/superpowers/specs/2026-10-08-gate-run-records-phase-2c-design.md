# Phase 2C — Gate Run Records

**Status:** design, approved in conversation 2026-10-08; pending written-spec review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A completion gates, 1B.1 authorization binding, 2A plan revisions and 2B gate ordering (all merged; main 429c85e8).

## Summary

A gate that passes can record **what actually ran** in a structured `ran` field on the gate: who performed it (`by`), plus a `ref` (commit SHA, run id, migration name) and/or a `url`. A gate can opt in to **requiring** that record with `requires_record: true`. It is set at declare time or added later while the gate is still `pending`, and it is add-only. A gate that requires a record cannot be passed without `ran`. A stored `pass` without `ran` does not count as resolved, so it blocks `done` and any gate ordered after it. Gates without the new fields behave exactly as before.

## Evidence

- **Every real gate pass so far records what ran only in prose.**
  - TASK-EAR-384 `shared_lib_publication`: "Merged to main as 05fae97f… via https://github.com/SparqLab/shared-lib/pull/88".
  - TASK-EAR-384 `product_contract`: an operator decision with a date.
  - TASK-EAR-385 `shared_lib_publication`: the same pattern.
  - None of them uses `evidence_refs`.
- **The evidence ledger cannot carry this record across the team.**
  - EAR-384 has a well-formed `evidence.yaml` (6 entries with command, exit code, repo SHA and log hash), but it is git-ignored. `runs/*/*` is not in the allowlist for `evidence.yaml`, the `evidence/` logs or `run-records/`.
  - The validator requires each entry's `artifact_path` to exist with a matching SHA-256 (`validate-yaml.rb`, `validate_evidence`), and a non-null `run_id` to resolve under `run-records/`.
  - So syncing `evidence.yaml` alone would fail validation on every other clone. The ledger is by design local proof of commands run on this machine.
  - Merges, deploys and operator-run SQL are usually not commands run on this machine anyway.
- **The person who performs the action is often not the gate's `actor`.** EAR-385 records "Verified operator merges/deploys", while the gates are written by `dev-2`.
- **The 2A replay deferred this.** Its deferred list includes "a record of what actually ran for an authorized action (run, SHA, performed-by)". VS-008: "no structured record says an authorized action did happen".

## Concepts kept separate

| Concept | Question | Where |
|---|---|---|
| Completion | Is the task objectively complete? | `completion_gates`, `branches` |
| Authorization | May this declared action happen? | `authorization.yaml` (unchanged) |
| Ordering | Which gate must be resolved first? | `after` (2B, unchanged) |
| Evidence | Which local commands ran, with what output? | `evidence.yaml` (unchanged, local) |
| **Run record** | **What actually happened when this gate passed, and who did it?** | **`ran` on a gate (new)** |

A run record is a structured claim, at the same trust level as `actor` and `reason`. It is not verified against GitHub or any other system.

## Non-goals

- Verifying that a SHA, run or URL exists or matches. No network calls.
- Linking `ran` to `evidence.yaml`, or making the evidence ledger team-synced.
- Requiring a record automatically for gates bound to an authorization. Requiring one is opt-in per gate.
- Removing `requires_record` once set. Narrowing keeps using `na` on the gate.
- Changing the 2A revision writer. A revision that declares a gate needing a record is followed by `require-record`.
- Dashboard or `status` command visibility.
- Backfilling `ran` or `requires_record` into existing runs.

## Design

### 1. Data

Two optional keys on a gate record:

```yaml
completion_gates:
  shared_lib_publication:
    status: pass
    actor: dev-2
    reason: "merged to main"
    updated_at: "2026-10-07T10:16:42Z"
    evidence_refs: []
    requires_record: true
    ran:
      by: operator
      ref: 05fae97f5ea5d38c7aded6f2eccbb627c0e72c2f
      url: https://github.com/SparqLab/shared-lib/pull/88
```

**`requires_record`**
- If present, it is exactly `true`. It is set at declare time or added while `pending`, and is never removed.
- It is carried forward on every transition, like `requires_authorization` and `after`.

**`ran`**
- A map whose only keys are `by`, `ref` and `url`.
- `by` is a required non-empty string naming who actually performed the work. It is free text, like `actor`.
- At least one of `ref` and `url` is present.
- `ref` is a non-empty string.
- `url` is a non-empty string starting with `https://`.
- `ran` is present only when the gate's status is `pass`. It may be written on any pass, whether or not the gate requires a record.

### 2. Resolution

`CompletionGuard.resolved?` (the Phase 1A metadata rule) gains one condition: a gate with `requires_record: true` and status `pass` is resolved only if its `ran` is well formed.

- Because `resolved?` is the base of `gate_resolved?`, the condition reaches every consumer through the existing call chain:
  - the `done` guard (all writers and the validator);
  - 2B ordering (`unresolved_dependencies`);
  - the validator's ordering invariant.
- An `na` gate is resolved as before.
- A gate without `requires_record` is resolved exactly as before.

### 3. The writer

Everything goes through `scripts/update-completion-gate.rb`, under the existing per-task lock and ownership fence, with the existing single clock read.

**Declare a gate that requires a record**

```
ruby scripts/update-completion-gate.rb <TASK> declare <GATE> --actor A [--reason R] --requires-record
    [--requires-authorization ACTION] [--after G1,G2]
```

`--requires-record` takes no value. The flag parser, which today expects a value after every flag, recognises it as a switch.

**Add the requirement to an existing pending gate** (new action `require-record`)

```
ruby scripts/update-completion-gate.rb <TASK> require-record <GATE> --actor A --reason R
```

- Requires `--reason`.
- Changes only `requires_record`; the gate's status, actor, reason, `updated_at`, `evidence_refs` and `after` stay as they are.
- Records a history row `gate <GATE>: requires_record` (agent `event_agent(actor)`, the given reason, the clock read) and a `completion_gate_updated` meta event.

**Pass with a record**

```
ruby scripts/update-completion-gate.rb <TASK> pass <GATE> --actor A --reason R
    --ran-by WHO [--ran-ref REF] [--ran-url https://...]
```

- `--ran-by` plus at least one of `--ran-ref` or `--ran-url` builds `ran`.
- A `pass` of a gate with `requires_record` and no `ran` is refused (exit 2): `gate '<GATE>' requires a ran record: pass it with --ran-by and --ran-ref/--ran-url`.
- On a gate that does not require a record, `ran` is optional and stored when given.

**Carry-forward**
- `requires_record` is carried forward on every transition.
- `ran` is written only by `pass`. Passing again replaces it, and `na` drops it.

**Ordering label.** When 2B refuses a pass because a dependency with `requires_record` passed without `ran`, the dependency is named as `<dep> (pass, missing ran record)`.

**Refusals (exit 2, nothing written)**
- Any `--ran-*` flag on `declare`, `na`, `depend` or `require-record`.
- `--ran-ref` or `--ran-url` without `--ran-by`, or `--ran-by` without either.
- An empty `--ran-*` value, or a `--ran-url` that does not start with `https://`.
- `--requires-record` on anything but `declare`.
- `require-record` on a gate that is not `pending`, is not declared, or already has `requires_record`.
- A finished task, as today.

**Exit codes.** Exit 3 now also covers a malformed stored `requires_record` (anything but `true`) or `ran` (shape as in Design 1, or present on a non-`pass` gate). Exit 9 is the ownership fence, as today.

### 4. How it connects to the existing phases

- **1A:** a `requires_record` gate passed without `ran` is unresolved, so `done` stays blocked. There is no other change to `done`.
- **1B.1:** independent. A gate can be both bound and `requires_record`; it is resolved only when both hold. `ran` does not replace `authorization_refs`.
- **1B.2:** the dispatch check is unchanged.
- **2A:** the revision writer is unchanged. Its gates can be given `require-record` right after the revision.
- **2B:** ordering uses `resolved?`, so a dependency that requires a record and lacks `ran` keeps its dependants waiting.
- **Gate records:** the gate record helper (`CompletionGuard.gate_record`) gains `requires_record:` and `ran:`. Gates without them keep their exact bytes, which the 2A byte pin (`plan-revisions.sh` section W) checks.

### 5. Validator, schema, parity

`validate-yaml.rb` is the runtime truth. Stored-state rules on each gate:

- `requires_record`, if present, is `true`.
- `ran`, if present, is valid per Design 1 and the gate's status is `pass`.
- A `pass` gate with `requires_record` and no valid `ran` is unresolved. This surfaces through the existing `done` check and the 2B ordering invariant, and is also reported directly as `<label>.completion_gates.<name>: requires_record but ran is missing or malformed`.

`schemas/status.schema.yaml` adds both keys to the gate record:
- `requires_record`: `const: true`.
- `ran`: an object with `additionalProperties: false`, required `by`, `anyOf` requiring `ref` or `url`, and `url` with pattern `^https://`.

`tests/integration/schema-validator-parity.sh` pins the `ran` keys and the `url` grammar against the shared helper.

### 6. Files

| File | Change |
|---|---|
| `scripts/completion-guard.rb` | `ran_errors(ran)`; `resolved?` gains the record condition; `gate_record` takes `requires_record:` and `ran:` |
| `scripts/update-completion-gate.rb` | `--requires-record` switch, `require-record` action, `--ran-*` flags, the record check on pass, carry-forward, the ordering label |
| `validate-yaml.rb`, `schemas/status.schema.yaml` | Design 5 |
| `tests/integration/gate-records.sh` | New suite |
| `tests/integration/schema-validator-parity.sh` | Pins `ran` |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | The record, the requirement, the limits |

## Tests

New suite `tests/integration/gate-records.sh`. Each behaviour is seen failing before its implementation.

**Replay**
- **EAR-384 shape:** `require-record` is added to an existing pending `shared_lib_publication`. A pass without `ran` is refused. A pass with `--ran-by operator --ran-ref <sha> --ran-url <PR>` succeeds, and the stored `ran` matches.
- **EAR-385 shape:** a gate is declared with `--requires-record` and passed with `--ran-by operator` by actor `dev-2`. `by` and `actor` are kept distinct.

**Writer**
- Every refusal in Design 3 leaves `status.yaml` byte-identical.
- `require-record` changes only `requires_record` (the record compared apart from that key) and writes the history row and meta event.
- An optional `ran` on a gate without the requirement is stored.
- Carry-forward:
  - `requires_record` survives `pass` and `na`;
  - `na` drops `ran`;
  - passing again replaces `ran`.
- **Teeth:** a hand-edited `pass` without `ran` on a `requires_record` gate blocks `done`, blocks a 2B dependant (refusal names `(pass, missing ran record)`), and fails validation.
- A gate both bound and `requires_record` resolves only with a valid grant and a `ran`.
- A malformed stored `requires_record` or `ran` gives exit 3; a foreign lease gives exit 9.
- Gates without the new keys are unchanged. The 2A byte pin (section W) still passes.

**Validator and parity**
- Every Design 5 rule as a stored-state case.
- A team-synced copy (`status.yaml`, `task.md`, `authorization.yaml`) validates.
- Tasks without the keys validate as before.
- The parity suite pins `ran`.

**Regression:** every suite from Phase 1A–1D, 2A and 2B passes unchanged.

## Rollout, evidence and rollback

- Additive and opt-in. Nothing changes for a gate without `requires_record` and `ran`.
- **Evidence that it earns its place:** after use, count gates with `requires_record`, and the share of their passes that carry `ran` instead of a SHA or URL in prose.
- **Rollback:** a revert.
  - The pre-2C validator accepts both keys. Checked on 2026-10-08: a status with a `requires_record` gate passed with `ran`, and a pending `requires_record` gate, passes `validate-yaml.rb <path>` on main 429c85e8.
  - Recorded `ran` values become inert data.
  - After a revert, a hand-edited `pass` without `ran` would no longer be blocked. That is the protection level before 2C.

## Documented limits

- `by`, `ref` and `url` are unverified. They are a structured claim at the trust level of `actor`.
- `status.yaml` can be hand-edited to remove `requires_record` or `ran`.
- `ran` is not linked to `evidence.yaml`, and the evidence ledger stays local.
- `ran` records one action per pass. A gate covering several actions lists the main one, and the rest stay in `reason`.

## Deferred

- Verifying `ref` and `url` against the forge.
- Making the evidence ledger team-synced, or linking `ran` to `ev-NNN`.
- Requiring records for bound gates by default.
- Governed intake declaration of gates.
- Authorization actions for merge and push.
- Ordering of branches.
- `status` command and dashboard view.
- The Execution Blueprint.
