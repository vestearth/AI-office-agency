# Phase 1B.1 — Authorization Ledger & Completion Binding

**Status:** design, pending review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A (completion gates, PR #29, `a1f1e71f`).

## Summary

Add an append-only, per-task authorization ledger (`runs/<task>/authorization.yaml`) and let a completion gate declare that it requires an authorization for a named action. A gate that requires authorization can only be resolved to `pass` while a matching, valid grant exists, and the task cannot reach `done` while that is not true. The check is enforced when the gate is passed **and** when the task tries to reach `done` — never only by the stored-state validator.

**What this slice does not do.** It does not stop an operator or agent from performing a privileged action before a grant exists. Action-time enforcement (blocking a dispatch or a shell command) is out of scope and is left for a possible Phase 1B.2. This slice provides an auditable record of who authorized what and a completion binding that refuses to call the task done without it. Do not describe it as blocking privileged actions.

Phase 1A's accepted limits carry over unchanged: `actor` is free text and identity is not verified, so an agent can technically record a grant for itself. The ledger makes that visible and auditable; it does not prevent it.

## Concepts kept separate

| Concept | Question | Where |
|---|---|---|
| Decision | What should we do? | `decision.yaml` (unchanged; `approve → done` untouched) |
| Authorization | May this declared action be accepted as authorized? | `authorization.yaml` (new) |
| Completion | Is the task objectively complete? | `completion_gates` in `status.yaml` (extended) |

A grant never changes a task's phase. "Authorized" does not mean "done".

## Non-goals

- Dispatch-time or action-time enforcement (no change to `run-agent.sh` dispatch, no shell interception).
- Changes to `preflight.yaml` / preflight policy, or to `decision.yaml` / the `approve → done` semantics.
- Actor identity or authentication; separation of duties; independent attestation.
- Scope enforcement (see "Scope is descriptive" below).
- Single-use / consumption of grants.
- Wildcards, inheritance or hierarchy between actions.
- Automatic gate discovery, PM auto-declaration, dashboard UI, policy defaults for which task types must require authorization.

## Design

### 1. The authorization ledger

`runs/<task-id>/authorization.yaml`, one per task, append-only.

```yaml
task_id: TASK-VS-011
authorizations:
  - id: authz-001
    type: grant
    action: production_backfill
    scope: "rolling-window correction on prod slip-api DB"   # descriptive only
    actor: alice
    via: cli
    reason: "operator approved the residual-window correction in chat"
    at: "2026-09-30T00:30:00Z"
    expires_at: "2026-09-30T06:30:00Z"                       # optional

  - id: authz-002
    type: revoke
    revokes: authz-001
    actor: alice
    via: cli
    reason: "plan changed; correction no longer wanted"
    at: "2026-09-30T02:00:00Z"
```

**Common audit fields (both types):** `id`, `type`, `actor`, `via`, `reason`, `at`. All are non-empty Strings; `at` (and `expires_at`) are UTC ISO-8601 strings `YYYY-MM-DDTHH:MM:SSZ`, always written quoted so they load as Strings.

**Grant-only:** `action` (one of the six below), `scope` (non-empty String), `expires_at` (optional).

**Revoke-only:** `revokes` (an `authz-NNN` id).

**Actions (closed enum, exact match only):**
`deploy_staging`, `deploy_production`, `production_data_mutation`, `production_backfill`, `live_load`, `external_side_effect`.

There is no inheritance or wildcard: `external_side_effect` does not imply `deploy_production`, and `production_data_mutation` does not imply `production_backfill`, even if the taxonomy overlaps conceptually. The list lives in one Ruby constant (`AuthorizationLedger::ACTIONS`); the schemas and the parity test pin to it.

**Ledger integrity rules** (enforced by the writer when appending and by the validator on the stored file):

- `id` matches `^authz-\d{3,}$`, ids are unique, and they increase in file order.
- `type` is `grant` or `revoke`; grant-only and revoke-only fields appear only on their own type.
- `expires_at`, when present, is strictly after `at` (`expires_at <= at` is invalid).
- A `revoke` may only reference an **earlier** grant in the same ledger (no forward reference), the referenced entry must be a `grant`, and the revoke's `at` is not before that grant's `at`.
- A grant may be revoked at most once; a second revoke of the same grant is rejected.
- `at` values need not be globally monotonic (clocks differ), but every rule above is evaluated on the recorded values, deterministically.

### 2. Validity at a time T

Deterministic and pure. A grant `G` is valid at time `T` iff:

```
G.at <= T
AND (G.expires_at is absent OR T < G.expires_at)
AND no revoke of G exists with revoke.at <= T
```

For a completion gate, `T` is the moment the gate was resolved to `pass` (`gate.updated_at`). Consequences:

- grant → pass → later revoke: the gate stays resolved. Phase 1A has no reopen; the later revoke is kept for audit and does not retroactively reopen the gate.
- grant → revoke → pass: the `pass` is refused.
- expired before pass: the `pass` is refused.

Library: `scripts/authorization-ledger.rb` (`AuthorizationLedger`) owns these semantics — parsing, normalization, integrity validation, an index by id, and `valid_grant_at?(id, action:, at:)`. It has no CLI and is safe to `require`.

### 3. The writer: `scripts/record-authorization.rb`

```
ruby scripts/record-authorization.rb <TASK_ID> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
ruby scripts/record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R
```

- Takes the per-task `.lock` and allocates the next id under it, following the `record-evidence.sh` pattern (`max + 1` under the lock). **In addition**, it calls `TaskOwnership.fence!` — intentional governed-writer behavior: a stale, superseded owner must not be able to append an authorization. (`record-evidence.sh` takes the lock but does not fence; this writer deliberately does both.)
- `at` is the current UTC time, written by the writer (not supplied by the caller).
- Validates every integrity rule above before appending; a refused append leaves the file untouched.
- Refuses `grant` on a task whose phase is `done` or `aborted`. `revoke` is allowed in any phase (revoking after the fact is a legitimate audit record).
- Records an `authorization_recorded` event in `meta.yaml` (agent mapped through `CompletionGuard.event_agent`, actor kept in `details`) and prints `authz-NNN grant|revoke`.
- Exit codes: `0` ok; `2` usage / invalid append; `3` unreadable status or ledger; `9` ownership fence refused.
- Hand-editing `authorization.yaml` is possible and is not prevented; the validator checks structure and integrity, so a broken hand edit is caught, but a well-formed forged entry is not (same limit as Phase 1A gates).

### 4. Binding to completion gates

`completion_gates.<gate>` gains two optional fields:

```yaml
completion_gates:
  production_backfill:
    status: pass
    actor: alice
    reason: "backfill ran under authz-001; 1071 rows updated"
    updated_at: "2026-09-30T00:44:00Z"
    requires_authorization: production_backfill   # set at declare, never changed
    authorization_refs:
      - authz-001
    evidence_refs: []
```

- `requires_authorization` (an action from the enum) is set only when the gate is declared: `update-completion-gate.rb <TASK> declare <GATE> --actor A --requires-authorization <action>`. It is immutable afterwards. A gate without it behaves exactly as in Phase 1A.
- `pass` on a gate with `requires_authorization` requires `--authorization authz-NNN[,authz-NNN…]`: at least one ref, and **every** ref must be a grant of this task, with `action == gate.requires_authorization` (exact), that is valid at the moment of the `pass`. Otherwise the `pass` is refused (exit `2`; unreadable/missing ledger is exit `3`) and the gate stays as it was. The accepted refs are stored as `authorization_refs`.
- `pass --authorization` on a gate that does **not** declare `requires_authorization` is refused (a gate cannot carry refs it did not ask for).
- `na` on an authorization-bound gate means the protected action was not applicable / was not performed. It is **not an authorization waiver**: it needs no authorization refs and must not carry `authorization_refs`. The recorded `reason` is the only assertion; this is audited, not verified.
- Matching is exact on `action` only. `scope` is never compared.

### 5. The completion guard validates authorization truth

An authorization-bound gate is **not** resolved merely because `authorization_refs` is non-empty. That would recreate the Phase 1A bug class: a hand-edited status such as

```yaml
status: pass
authorization_refs: [authz-999]
```

must not reach `done` just because validation runs later.

Invariant:

> A declared authorization requirement cannot be satisfied by a missing, mismatched, expired, or already-revoked grant. The same rule is enforced when the gate is passed and when the task attempts to reach `done`.

`CompletionGuard` stays a pure function but takes the authorization ledger as an input:

```ruby
CompletionGuard.can_transition_to_done(status, authorizations: nil)
```

- `authorizations` is an `AuthorizationLedger` index (or `nil`). With no gate that has `requires_authorization`, it is ignored — such tasks are untouched and the ledger is not read.
- For each authorization-bound gate, resolved requires all of: the Phase 1A metadata rules (`status` pass/na with non-empty `actor`, `reason`, `updated_at`); and for `pass`: non-empty `authorization_refs`, every ref resolving to a grant in the ledger with `action == gate.requires_authorization` that is valid at `gate.updated_at` (parsed as a UTC timestamp; unparseable ⇒ unresolved); and for `na`: no `authorization_refs`.
- Fail closed: an authorization-bound gate with a missing or corrupt ledger, or `authorizations: nil`, is unresolved.
- Validity is evaluated **at the gate's `updated_at`**, not "now", so a later revoke or the passage of time does not reopen a resolved gate.

A convenience wrapper keeps callers small and keeps the core pure:

```ruby
CompletionGuard.can_transition_to_done_in(status, task_dir)   # loads the ledger only when a gate requires authorization
```

All five current callers of the guard switch to the wrapper: `sync-status-from-output.rb`, `reconcile-decision.rb`, `force-status-route.rb`, `decide-next-step.rb`, and `validate-yaml.rb` (the stored-state check). The stored-state validator remains defense in depth, not the first place a forged reference is discovered.

`blocked_message` gains a hint that an authorization-bound gate needs valid `authorization_refs`.

### 6. Validation, schema, parity

- `validate-yaml.rb`: validates `authorization.yaml` when present (shape and every integrity rule above); validates the two new gate fields (`requires_authorization` in the enum; `authorization_refs` shape `authz-NNN`; `na` carries none; refs only on gates that require authorization); a `done` task with an authorization-bound gate that the guard rejects is a validation error; refs must resolve and match action and be valid at `gate.updated_at`.
- `schemas/authorization.schema.yaml` (new, documentation like the other schemas): the ledger shape, with an `if/then` for grant-only vs revoke-only fields and non-empty strings.
- `schemas/status.schema.yaml`: `requires_authorization` (enum) and `authorization_refs` (array of `^authz-[0-9]{3,}$`) on the gate record.
- `tests/integration/schema-validator-parity.sh`: pin `AuthorizationLedger::ACTIONS` to both enums (ledger `grant.action`, gate `requires_authorization`), the id grammar, and the common audit key list to the schema.
- No database, no migration: this is a YAML contract inside the run store.

## Files

| File | Change |
|---|---|
| `scripts/authorization-ledger.rb` | New. Library: `ACTIONS`, id grammar, load/normalize/validate, index, `valid_grant_at?`. |
| `scripts/record-authorization.rb` | New. CLI writer (grant / revoke). |
| `scripts/completion-guard.rb` | `authorizations:` input; `can_transition_to_done_in`; message hint. |
| `scripts/update-completion-gate.rb` | `declare --requires-authorization`; `pass --authorization`; `na` rejects refs; validity check at pass. |
| `scripts/sync-status-from-output.rb`, `reconcile-decision.rb`, `force-status-route.rb`, `decide-next-step.rb` | Use `can_transition_to_done_in`. |
| `validate-yaml.rb` | Ledger + gate-field validation; stored-state check via the wrapper. |
| `schemas/authorization.schema.yaml`, `schemas/status.schema.yaml` | As above. |
| `tests/integration/schema-validator-parity.sh` | New rows. |
| `tests/integration/authorization-ledger.sh` | New suite. |
| `docs/authorization-ledger.md`, `docs/completion-gates.md`, `docs/task-transition-contract.md` | Contract, the "audit-only scope" and "no action-time enforcement" statements, limits. |

## Tests

New suite `tests/integration/authorization-ledger.sh`, plus additions to the completion-gates and parity suites. Each behavior change must be seen failing before its implementation.

Ledger and writer:
- grant appends `authz-001`; a second grant gets `authz-002`; concurrent writers never collide on an id.
- revoke references an earlier grant; a revoke that references a later or unknown id, a non-grant, or an already-revoked grant is rejected; duplicate revoke is rejected.
- `expires_at <= at` is rejected; `at` is set by the writer.
- `grant` on a `done` / `aborted` task is refused; `revoke` on a `done` task is allowed.
- a stale owner (fence refused) cannot append.
- exact action matching: an `external_side_effect` grant does not satisfy a `deploy_production` gate; `production_data_mutation` does not satisfy `production_backfill`.

Gate binding and guard:
- `pass` refused with no refs, an unknown ref, a mismatched action, an expired grant, or a grant revoked before the pass; gate stays as it was.
- grant → pass → later revoke: the gate stays resolved and the task can reach `done`.
- **forged or hand-edited `authorization_refs` are blocked by `CompletionGuard` itself** (through `sync`, `reconcile-decision` approve, and `force-status-route`), not merely by `validate-yaml.rb`.
- an authorization-bound gate with a missing or corrupt ledger fails closed.
- `na` on an authorization-bound gate needs no refs and rejects `authorization_refs`; `pass --authorization` on a gate without `requires_authorization` is refused.
- a task or gate without `requires_authorization` behaves identically to Phase 1A (the ledger is not even read).

Validator and parity:
- ledger shape and every integrity rule, dangling refs, gate-field shape, `done` with an authorization-bound gate the guard rejects.
- parity: action enum (both places), id grammar, common audit keys.

Regression: every Phase 1A suite still passes unchanged.

## Rollout and rollback

- Additive and opt-in. No existing task is affected: without `requires_authorization` no code path reads the ledger, and `validate-yaml.rb` only inspects `authorization.yaml` when the file exists.
- Rollback is a revert. After a revert, an existing `authorization.yaml` is inert, and a gate that still carries `requires_authorization` would be judged by the Phase 1A guard (metadata only), i.e. weaker. If a rollback happens while such gates exist, resolve or remove them by hand first.

## Documented limits

- No action-time enforcement: nothing here prevents the action itself. The slice is named **Authorization Ledger & Completion Binding** for that reason.
- `scope` is descriptive and audit-only. Only `action` is compared, so `scope: wallet-service` does not stop a grant being cited for a different service. A structured, machine-comparable scope key is deferred until real usage shows the need.
- `actor` / `via` are unverified free text; an agent can record a grant for itself.
- A revoke after a `pass` is retained but does not reopen the gate (no reopen in Phase 1A).
- Validity is judged at the gate's recorded `updated_at`; a hand-edited `updated_at` together with a hand-edited ledger is not detectable (same limit as Phase 1A).
- `na` is an audited assertion that the protected action did not happen, not a verified fact.

## Deferred

Phase 1B.2 (action-time enforcement), structured scope, single-use grants, dashboard UI, PM auto-declaration of authorization-bound gates, identity/attestation, Phase 1C (branch state) and 1D (failure classification).
