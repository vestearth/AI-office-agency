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
`completion_gate_updated` event in `meta.yaml`. Exit codes: `0` ok; `2` usage
error or invalid transition; `3` missing or unreadable `status.yaml`, a
`completion_gates` value that is not a map, an evidence id not in
`evidence.yaml`, or an unreadable authorization ledger (Phase 1B.1); `9` ownership fence refused. Gates originate from the
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

A gate can declare `requires_authorization: <action>` at declare time. Such a gate resolves only with valid `authorization_refs` (and `authorization_through`) — see [authorization-ledger.md](authorization-ledger.md). `na` on a bound gate is not an authorization waiver. The guard entry point for writers and the validator is `CompletionGuard.can_transition_to_done_in(status, task_dir)`; the pure `can_transition_to_done(status, authorizations:)` remains. Gates without `requires_authorization` never read the ledger and behave exactly as described above. This records and checks authorization at completion; it does not block the action itself.

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
