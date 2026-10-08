# Completion Gates (Phase 1A)

Issue: vestearth/AI-office-agency#28. Opt-in, in `status.yaml` only.

## Guarantee

> Declared completion gates are enforced before `done`. Every resolution to
> `pass` or `na` is explicit and auditable with actor, reason, timestamp, and
> supporting evidence where applicable. Phase 1A does not guarantee that the
> acceptance judgment was made by an actor independent of the implementer.

## What it does not guarantee

Phase 1A does **not** provide independent verification, separation of duties,
authenticated actor identity, role-based authorization for who may resolve a
gate, or automatic discovery of the gates a task should have. A gate marked
`pass` by the same agent that implemented the work is structurally valid. That
is intentional for this slice; independent attestation belongs with the later
authorization/policy work and needs evidence that it is required.

## Shape

```yaml
completion_gates:
  authenticated_runtime:
    status: pending          # pending | pass | na
    actor: reviewer          # required for pass / na (free text, not verified)
    reason: authenticated production response contains the expected month.api and month.line values
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs:           # optional; each id must resolve in evidence.yaml
      - ev-012
```

- A gate that is present is **required**. There is no `required:` flag.
- `pending` blocks `done`. `pass` means the actor recorded an acceptance
  judgment. `na` means the gate was explicitly judged not applicable, with a
  reason. There is no `failed` / `waived` / `skipped`: a failed acceptance check
  leaves the gate `pending` and goes through the normal workflow.
- The guard itself, not only the validator, requires `actor`, `reason` and
  `updated_at` (non-empty strings) on a `pass` / `na` gate; a gate missing any of
  them stays unresolved and blocks `done` (fail closed).
- `evidence_refs` are support, not proof. The validator only checks that the ids
  resolve; the judgment is the recorded `reason`. Where acceptance is a human
  observation, record it in `reason` — there is no `human_attestation` evidence
  type.
- Removing a requirement must be explicit: resolve the gate to `na` with actor
  and reason. Do not delete the key.

## Who writes gates

Gates should be written only through `scripts/update-completion-gate.rb`:

```bash
ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>]
ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002]
ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
```

This is a convention, not enforcement: a hand-edited gate carries no history
or `meta.yaml` record, so it is not auditable, and the validator checks
structure (plus, for authorization-bound gates, their refs against the ledger).

`--evidence` takes a comma-separated list and is valid only with `pass`.
`declare` creates the gate as `pending` and refuses a gate that already exists;
`pass` / `na` refuse a gate that was not declared first. `declare` accepts
`--requires-authorization <action>` and `pass` accepts `--authorization
authz-NNN[,…]` for bound gates (see
[authorization-ledger.md](authorization-ledger.md)).

It takes the task lock and the ownership fence, refuses to edit a `done` or
`aborted` task (exit `2`), appends a `status.yaml` history entry, and records a
`completion_gate_updated` event in `meta.yaml`. Arguments are read as UTF-8
whatever the locale (`LANG` unset included), so free text such as a Thai
`--reason` is stored as plain text, never YAML `!binary`. Exit codes: `0` ok; `2` usage
error (including an argument that is not valid UTF-8) or invalid transition;
`3` missing or unreadable `status.yaml`, a
`completion_gates` value that is not a map, an evidence id not in
`evidence.yaml`, an unreadable authorization ledger (Phase 1B.1), a malformed
stored ordering (Phase 2B) or run record (Phase 2C); `9` ownership fence refused. Gates originate from the
task's planning side (PM/operator declares them); the Office does not derive
them.

## Enforcement

`scripts/completion-guard.rb` is the single implementation
(`CompletionGuard.can_transition_to_done_in(status, task_dir)`, a wrapper over
the pure `can_transition_to_done`). It is called by every path that can produce
`done`:

| Path | On refusal |
|---|---|
| `scripts/sync-status-from-output.rb` (any output that would move the task to `done`, e.g. reviewer `approved`; any actor except free-roam that emits `next_action.agent: done`, e.g. devops on a standalone infra task, is guarded too) | exit `5`, status untouched |
| `scripts/reconcile-decision.rb` (human `approve`) | prints `blocked:<decision>:<gates>` (e.g. `blocked:approve:<gates>`), exit `0`, decision stays pending and applies on the next non-pm dispatch after gates resolve (nothing triggers by itself). When the decision carries `against_phase` and the task's phase differs by then, it is not applied: prints `stale:approve:<against>-><current>`, marks the decision applied and adds a `superseded` history entry |
| `scripts/force-status-route.rb ... done` | exit `5`, no implicit bypass |
| `scripts/decide-next-step.rb` (auto loop, when given the optional status file argument) | `terminal=false` and empty `next`, the loop does not announce completion (an unreadable status file also fails closed; a status path that does not exist skips the check, i.e. fails open, though the loop always has a status file) |
| `validate-yaml.rb` (stored state; uses the pure function only when no task directory is known) | error: phase/state `done` with an unresolved gate |

A refusal keeps the current phase, does not route to `validation_failed`, does
not consume `validation_failed_retries`, and records a `completion_blocked`
event in `meta.yaml` (identical repeats are not re-logged). `decide-next-step.rb`
is a pure decision and only warns; it does not write the event.

A refused role output is not re-applied automatically: the operator
re-dispatches the role or re-runs sync once the gates are resolved.

A held human `approve` is re-tried on each non-pm dispatch and applies only when
the gates resolve. If the decision carries `against_phase` (the dashboard writes
it) and the task has since moved to a different phase (e.g. the reviewer
requested changes), the approval is treated as stale and is not applied. Without
`against_phase` the approval can still apply late; this is a known limit of
Phase 1A.

A gate cannot be re-opened in Phase 1A: `declare` refuses an existing gate,
while `pass` and `na` can be switched between each other (audited in history and
`meta.yaml`).

Because dependent tasks unblock when their upstream reaches `done`
(`dependency_policy.unblock_when_upstream_phase`), the guard also prevents a
false `done` from releasing downstream work.

## Gates bound to an authorization (Phase 1B.1)

A gate can declare `requires_authorization: <action>` at declare time. Such a gate resolves only with valid `authorization_refs` (and `authorization_through`) — see [authorization-ledger.md](authorization-ledger.md). `na` on a bound gate is not an authorization waiver. The guard entry point for writers and the validator is `CompletionGuard.can_transition_to_done_in(status, task_dir)`; the pure `can_transition_to_done(status, authorizations:)` remains. Gates without `requires_authorization` never read the ledger and behave exactly as described above. This records and checks authorization as of the pass (a later revoke or expiry is kept for audit and does not reopen the gate); it does not block the action itself.

## Gate ordering (Phase 2B)

A gate can wait on other gates: `after: [gate, ...]`. It cannot be **passed** until every gate it waits on is resolved, judged exactly as the `done` guard judges it. That means `pass` or `na` with actor, reason and `updated_at`; a gate bound to an authorization also needs its recorded grant to hold, as of its own snapshot. `na` is not ordered: a gate that does not apply has nothing to wait for. Ordering adds no `done` rule.

```bash
# declare a gate that waits on another
ruby scripts/update-completion-gate.rb TASK-EXAMPLE-001 declare authenticated_staging \
  --actor pm --reason "staging smoke after implementation" --after implementation_verification

# add an ordering to a gate that already exists and is still pending
ruby scripts/update-completion-gate.rb TASK-EXAMPLE-001 depend implementation_verification \
  --after shared_lib_publication --actor pm --reason "verification runs against the published shared-lib"
```

- `--after G1,G2` takes one or more declared gates. A name that is unknown, the gate itself, repeated, already present, or that would create a cycle is refused (exit 2), and nothing is written.
- `depend` works only on a `pending` gate and requires `--reason`. It changes only `after`, and records a history row `gate X: after += …` and a `completion_gate_updated` meta event.
- Orderings are add-only. To drop a gate that no longer applies, mark it `na`.
- A refused pass names what it waits on, for example `waits on: shared_lib_publication (pending)`. A bound dependency that passed without a valid grant shows as `(pass, authorization not satisfied)`.
- The writer carries `after` forward on every transition. The validator checks the shape, that every name is a declared gate, that there are no cycles, and that no gate is `pass` while one of its `after` gates is unresolved.

Limits: ordering is enforced only when a gate passes. It does not stop work from starting and does not affect dispatch. `status.yaml` can be hand-edited to remove an ordering. Only gate-on-gate ordering exists. Spec: [`superpowers/specs/2026-10-08-gate-ordering-phase-2b-design.md`](superpowers/specs/2026-10-08-gate-ordering-phase-2b-design.md).

## Gate run records (Phase 2C)

A gate that passes can record **what actually ran**: who performed it and a reference to it. This is often not the gate's `actor`. For example, the operator merges and `dev-2` records the gate.

```bash
# pass with a record
ruby scripts/update-completion-gate.rb TASK-EXAMPLE-001 pass shared_lib_publication \
  --actor dev-2 --reason "merged to main" \
  --ran-by operator --ran-ref 05fae97f --ran-url https://github.com/SparqLab/shared-lib/pull/88

# require a record: at declare time, or added later while the gate is pending
ruby scripts/update-completion-gate.rb TASK-EXAMPLE-001 declare authenticated_staging \
  --actor pm --reason "staging smoke" --requires-record
ruby scripts/update-completion-gate.rb TASK-EXAMPLE-001 require-record shared_lib_publication \
  --actor pm --reason "publication must cite the merge"
```

- `ran` is stored on the gate as `{by, ref, url}`. `--ran-by` is required, together with `--ran-ref` and/or `--ran-url`. The URL must start with `https://`. `ran` may be given on any pass; it is written only by `pass`, replaced by a later pass, and dropped by `na`.
- `requires_record: true` makes `pass` refuse without a record (exit 2). It is add-only and carried forward on every transition. `require-record` works only on a `pending` gate, needs `--reason`, changes only `requires_record`, and records a history row `gate X: requires_record` and a `completion_gate_updated` meta event.
- A stored `pass` of a gate that requires a record but has no well-formed `ran` (for example, after a hand edit) is **not resolved**. It blocks `done`, and it blocks any gate ordered after it, which reports it as `(pass, missing ran record)`. The validator reports it as well.
- A gate can be both bound to an authorization and require a record. It is resolved only when both hold.

Limits: `by`, `ref` and `url` are not checked against GitHub or any other system. They are a structured claim at the trust level of `actor`. `ran` is not linked to `evidence.yaml`, which stays local. `status.yaml` can be hand-edited to remove `requires_record`. Spec: [`superpowers/specs/2026-10-08-gate-run-records-phase-2c-design.md`](superpowers/specs/2026-10-08-gate-run-records-phase-2c-design.md).

## Seeing gates (Phase 2D)

`run-agent.sh status <TASK>` prints a `Gates:` block for a task that has
`completion_gates`, and a `Revisions:` line for a task that has
`completion_gates` or `revisions`:

```
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass — ran: operator 05fae97f5ea5d38c7aded6f2eccbb627c0e72c2f
  implementation_verification: pending — can pass now
  authenticated_staging: pending — waits on implementation_verification (pending)
Revisions: none
```

- `can pass now`: a `pass` now would not be refused for ordering or
  authorization. ` (needs --ran-by and --ran-ref/--ran-url)` is appended when
  the gate requires a record.
- `waits on X (pending)`: the gate waits on unresolved gates, worded exactly
  as the writer's refusal words them.
- `waits for a <action> grant`: the gate is bound and no grant is valid now.
- `NOT resolved: <reason>`: the gate is `pass`/`na` but does not count, e.g.
  `missing ran record`.
- `Gates: unreadable (…; run validate-yaml.rb)`: the stored gates are
  malformed, or hold state the view cannot present truthfully: a
  `requires_authorization` key whose value is not a known action (e.g. `null`;
  the writer refuses it too), or `ran` text that is not UTF-8.
- `task is aborted` / `task is done`: the task is finished, so the writer
  refuses every gate edit and nothing can pass.
- If `authorization.yaml` cannot be read, bound gates fail closed as the
  done guard does: a bound `pass` shows `NOT resolved: authorization ledger
  unreadable`, and pending bound gates wait for a grant.

`run-agent.sh status` (all tasks) appends `gates=pass:2,pending:2,ready:1`,
where `ready` counts the gates that can pass now. The adapter JSON carries the
same view (see [runtime-adapter-contract.md](runtime-adapter-contract.md)).
Tasks without gates or revisions print exactly what they printed before, and
`Next:` is unchanged. Nothing is written.

Limits: "can pass now" is a snapshot. A grant can expire or be revoked
before `pass` runs, and the writer stays the authority. It does not check
`actor`/`reason` or verify `ran`. The dashboard does not show gates yet. Spec:
[`superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md`](superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md).

## Planning gates (Phase 2E)

The PM plans a task's gates in `pm-output.yaml`, and syncing the PM output declares them. No one hand-edits `completion_gates`:

```yaml
completion_gates:
  - name: shared_lib_publication
    reason: "Game and gateway consume the published contract"
    after: [product_contract]                  # optional
    requires_authorization: deploy_production  # optional
    requires_record: true                      # optional
```

- The validator checks the plan's shape:
  - names follow the gate-name grammar, with no duplicates;
  - every gate has a non-empty `reason`;
  - `after` is non-empty, has no duplicates and does not name the gate itself;
  - an action is a known one, and `requires_record` is `true`;
  - the listed gates contain no cycle.
- `sync-status-from-output.rb` applies the plan when it syncs the PM output, in the same lock, fence and single write as the transition. It is **add-only**:
  - **new gate:** declared `pending` with actor `pm`. The record, the history row (`gate X: absent -> pending`) and the `completion_gate_updated` meta event are the same as `declare` writes.
  - **unchanged gate:** left as it is. A repeated sync changes nothing.
  - **pending gate gaining `after` names or `requires_record`:** they are added with the same rows `depend` and `require-record` write.
  - **conflict:** the whole sync is refused with **exit 6** and nothing is written. A conflict is any plan that would change `requires_authorization`, drop an `after` name or `requires_record`, add to a gate that is no longer `pending`, name an unknown gate in `after`, or create a cycle. `run-agent.sh` routes exit 6 to `validation_failed` and records the conflict in the `status.yaml` history reason (`gate plan conflicts with status.yaml: <message>`) and in the `validation_failed` meta event (`conflict="<message>"`); dispatch the PM again with a corrected plan (the `validation_failed` halt does not apply to `pm`).
  - **gate missing from the plan:** kept. Retire a gate with `na` through the writer.
- Each role contract (`agents/pm.md`, `dev.md`, `dev-2.md`, `devops.md`, `reviewer.md`) carries a "Completion gates" rule.
- The dispatched prompt carries a `--- COMPLETION GATES ---` block with the same lines as `run-agent.sh status`. It is rendered by `scripts/gate-status-text.rb`. A task without gates or revisions gets no block.

Limits: roles may still not act on a gate; the writer and guards keep the rules. The PM decides which gates a task needs, and nothing infers them. Gates added mid-task do not require a 2A revision. Spec: [`superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md`](superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md).

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
