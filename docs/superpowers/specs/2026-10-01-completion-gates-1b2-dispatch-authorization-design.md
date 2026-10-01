# Phase 1B.2 — Dispatch-time Authorization Check

**Status:** design, pending review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1B.1 (authorization ledger and completion binding, PR #32, `22f32c06`).

## Summary

When the driver (`run-agent.sh`) dispatches a role that is configured as one that performs privileged work (default: `devops`), check whether the task has a completion gate that is **bound to an authorization** (`requires_authorization: <action>`) and still `pending`, and whether the task's authorization ledger holds a grant for that action that is valid **right now**. In `warn_only` mode (the default) a missing grant is recorded and warned about but never blocks; in `required` mode the dispatch is refused.

The check is **inferred from state the Office already holds**, so a caller cannot skip it by failing to declare an action (unlike `preflight`, which engages only when the caller declares an input source).

**What this slice is, and is not.** It is a check on dispatches the Office itself performs. It is **not** a sandbox: it does not stop an agent from running a shell command, an operator from running a production correction by hand, or a task without a bound gate from doing anything. The slice is named **Dispatch-time Authorization Check** for that reason. Do not describe it as blocking privileged actions.

Phase 1A and 1B.1 limits carry over unchanged: `actor` and `via` are unverified free text, so a grant can be recorded by whoever can run the writer; `scope` is audit-only and never compared.

## Why `warn_only` first

The 1B.1 spec deferred action-time enforcement until "runtime evidence shows it is needed". This slice produces that evidence before it enforces anything: every applicable dispatch records whether a valid grant existed, so the rate of dispatches without a grant can be counted before `required` is switched on. This mirrors the existing `reviewer.evidence_policy` rollout (`warn_only` → `required`).

## Concepts kept separate

| Concept | Question | Where |
|---|---|---|
| Decision | What should we do? | `decision.yaml` (unchanged) |
| Authorization | May this declared action be accepted as authorized? | `authorization.yaml` (unchanged, read here) |
| Completion | Is the task objectively complete? | `completion_gates` (unchanged) |
| Dispatch check | Does a dispatch of a configured role have a valid grant for the actions its pending gates require? | new, this slice |

The dispatch check never changes a task's phase, never writes `status.yaml`, never writes a gate, and never writes the ledger.

## Non-goals

- Blocking shell commands, runner sessions, or anything an agent does inside a dispatch; verifying what the dispatched role then does.
- Changes to `preflight`, `preflight.yaml`, `decision.yaml`, `approve -> done`, or the completion guard.
- Linking a grant to one dispatch, single-use or consumed grants, comparing `scope`, or verifying who granted.
- Inferring actions from anything other than pending authorization-bound gates (no declared-action variant in this slice).
- Checking roles that are not configured, and tasks that have no pending bound gate.
- A new per-task record file (the evidence is meta events; see below).

## Design

### 1. When the check applies

The check runs in `run-agent.sh` for a dispatch of role `R` of task `T` and is **applicable** only when all of these hold:

1. `authorization_dispatch.mode` is not `off`;
2. `R` is in `authorization_dispatch.roles`;
3. `runs/<T>/status.yaml` exists and has at least one gate that is `pending` **and** carries the key `requires_authorization`.

Conditions 1 and 2 need a readable `authorization_dispatch` block. If the block is malformed, conditions 1 and 2 cannot be evaluated, so the check is treated as applicable whenever condition 3 holds (conservative: a typo must not switch the check off) and the outcome is `config_error` (sections 3 and 4).

If a condition fails with a readable block the outcome is `not_applicable`: nothing is read beyond `status.yaml`, nothing is logged, and the dispatch proceeds exactly as before. In particular a task without bound gates never reads `authorization.yaml`.

The check reads `status.yaml` once, **before** any driver writer runs. Gates are not touched by the reconcile steps that follow, so the snapshot cannot go stale in a way that matters.

### 2. What is checked

For each pending bound gate, let `A` be its `requires_authorization`. The set of required actions is the set of distinct `A` values. For each `A` the task needs **at least one grant of exactly `A` that is valid as of `(T, S)`** where:

- `T` is the current time (`AuthorizationLedger.now_utc`, so the existing test hook applies);
- `S` is the ledger's current high-water id (`index.high_water_id`);
- validity is the existing 1B.1 rule: `id <= S`, `at <= T`, (`expires_at` absent or `T < expires_at`), and no revoke of it with `id <= S`.

Matching is exact on `action`; `scope` is never compared. A gate whose `requires_authorization` is not one of the six known actions can never be satisfied and counts as missing. A ledger that cannot be loaded (unreadable, corrupt, integrity-violating, wrong root shape) yields no grants, so every required action is missing. An **absent** `authorization.yaml` is an empty ledger: every required action is missing.

The library gains one pure method for this, `AuthorizationLedger::Index#any_valid_grant?(action:, at:, through:)`, built on the existing `valid_grant?`; the numeric id comparison and append-order revocation rules are reused, not reimplemented.

Outcomes:

| Outcome | Meaning |
|---|---|
| `not_applicable` | see section 1; nothing logged |
| `authorized` | every required action has a currently valid grant |
| `missing_authorization` | at least one required action has none; the output lists them |
| `config_error` | the check is applicable but `authorization_dispatch` is malformed (see section 4) |

This checks that a valid grant **exists**, not that this dispatch uses it. A dispatch of `devops` that only reads logs is checked the same as one that deploys, because the Office does not know what the role will do. That is the price of inferring instead of declaring, and it is why the default is `warn_only`.

### 3. Modes and what the driver does

| Mode | `authorized` | `missing_authorization` | `config_error` | the check itself fails (crash, unreadable file) |
|---|---|---|---|---|
| `off` | not applicable | not applicable | not applicable | not applicable |
| `warn_only` (default) | proceed | log + warn, **proceed** | log + warn, proceed | warn, **proceed** |
| `required` | proceed | log, **refuse** | log, **refuse** | **refuse** |

`warn_only` must never break a run: observability and a safety check that is not yet enforcing must not turn a defect in the checker into a failed dispatch. `required` fails closed: a gate that cannot decide must not let the work through (the same rule as `preflight`).

The checker is a standalone script, `scripts/authorization-dispatch-check.rb`:

```
ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>
```

It prints one line `outcome=<outcome> mode=<mode> actions=<a,b>` (actions empty when none) and exits `0` to proceed, `14` to refuse, `2` on a usage error. The exit codes are scoped to this script, as `preflight.rb`'s `10`–`13` are to that script; `scripts/event-gateway.rb` has its own code space and is never invoked on this path. A usage error and any unexpected exit are handled by the driver by the same fail-safe rule as a crash: the driver reads the mode itself and refuses only when the mode is `required`, or is an unknown value; otherwise it warns and proceeds. This keeps the `warn_only` guarantee even if the script cannot start.

`run-agent.sh` adds one block directly after the `preflight` block and before `reconcile_blocked_status`. It:

1. runs the checker (skipped when `AGENT` is `pm`, `auto`, or any non-role mode, exactly like the neighbouring blocks);
2. on `authorized`, `missing_authorization` or `config_error` appends an `authorization_dispatch_check` event to `meta.yaml` with `log_meta_event` (agent = the dispatched role; `details` = `task=… mode=… outcome=… actions=…`; the run id is attached by the existing mechanism);
3. on `missing_authorization` prints `Authorization check: <actions> have no valid grant for <TASK_ID>` and, in `required` mode, exits `1` with a message pointing at `scripts/record-authorization.rb`;
4. on `config_error` prints the configuration problem and refuses in `required`.

No new record file is created: the `meta.yaml` events are the record, and counting events of this type with `outcome=authorized` versus `outcome=missing_authorization` is the evidence needed before enabling `required`.

### 4. Configuration

A new top-level block in `office.config.yaml`:

```yaml
authorization_dispatch:
  # off | warn_only | required. Default warn_only: record and warn, never block.
  mode: warn_only
  # Roles whose dispatch is checked. Default [devops], the role preflight already
  # maps to the deploy capability. Values must be roles from agents/manifest.yaml.
  roles:
    - devops
```

- **Absent block:** the defaults above apply (`warn_only`, `[devops]`).
- **Malformed block** (mode not in the list, `roles` not a list of known roles): the check is applicable-but-unreadable → `config_error`, handled per section 3 (warn in `warn_only`, refuse in `required`). A safety gate must not fail open on a typo, and the shipped-config test below asserts the shipped block is valid.
- **Protected key.** The config resolver keeps gitignored local overlays from changing safety-relevant keys (`PROTECTED_PATHS` in `scripts/resolve-office-config.rb`). The whole `authorization_dispatch` block is added there: an overlay that could set `mode: off` or empty `roles` would silently weaken the check with no trace in `git status`, the same shape as `ownership.enabled`. A test pins that every key shipped in the block is protected, mirroring the existing `preflight` check.

### 5. Files

| File | Change |
|---|---|
| `scripts/authorization-dispatch-check.rb` | New. `decide` command, config validation (`config_errors`), outcome and exit-code contract. |
| `scripts/authorization-ledger.rb` | Add `Index#any_valid_grant?(action:, at:, through:)`. |
| `run-agent.sh` | New block after `preflight`, plus the driver fail-safe rule. |
| `office.config.yaml` | New `authorization_dispatch:` block. |
| `scripts/resolve-office-config.rb` | `%w[authorization_dispatch]` added to `PROTECTED_PATHS`. |
| `tests/integration/authorization-dispatch.sh` | New suite. |
| `docs/authorization-ledger.md`, `docs/policy-preflight.md` (one pointer sentence), `docs/task-transition-contract.md` | The check, its modes, its limits, how to read the evidence. |

## Tests

New suite `tests/integration/authorization-dispatch.sh`. Each behavior must be seen failing before its implementation.

Checker (`decide`), against temp runs dirs:
- no `completion_gates` / no bound gate / only resolved bound gates / only unbound pending gates → `not_applicable`, exit 0, and `authorization.yaml` is **not read** (prove with a corrupt ledger present).
- pending bound gate + a grant of exactly that action valid now → `authorized`; the same with no ledger, an absent ledger, a grant for a different action (including `external_side_effect` vs `deploy_production`), an expired grant (`expires_at` equal to now is not valid), a revoked grant (the revoke has an id below the high-water), and a corrupt ledger → `missing_authorization` listing the action.
- two pending bound gates with different actions, one satisfied → `missing_authorization` listing only the unsatisfied one; both satisfied → `authorized`.
- a pending bound gate with an unknown `requires_authorization` → `missing_authorization`.
- a revoke recorded after the check does not matter (the check is as of now); a grant revoked before the check does.
- role not in `roles`, `mode: off` → `not_applicable`.
- `warn_only` exits 0 for every outcome; `required` exits 14 for `missing_authorization` and `config_error` and 0 for `authorized` and `not_applicable`.
- malformed block (unknown mode, `roles` not a list, unknown role name) → `config_error`; absent block → defaults.
- `AI_OFFICE_NOW` is honored only against a non-live runs dir (the 1B.1 restriction applies here too).

Driver integration (`run-agent.sh`), using the same stub-runner approach as the existing driver tests:
- `warn_only`: a `devops` dispatch with a pending bound gate and no grant proceeds, prints the warning, and writes one `authorization_dispatch_check` event with `outcome=missing_authorization`; with a grant it proceeds and logs `outcome=authorized`; a `dev` dispatch logs nothing.
- `required`: the same dispatch exits 1, the runner is not invoked, status is untouched; with a grant it proceeds.
- fail-safe: with the checker made to crash, `warn_only` proceeds with a warning and `required` (and an unknown mode) refuses.
- the dispatch check never modifies `status.yaml`, the ledger, or any gate.

Config:
- the shipped `office.config.yaml` block validates and every key in it is in `PROTECTED_PATHS` (a key added without protection fails the test).
- a local overlay that tries to set `authorization_dispatch.mode: off` is ignored.

Regression: every Phase 1A and 1B.1 suite still passes unchanged; tasks without bound gates behave byte-for-byte as before.

## Rollout, evidence and rollback

- **Rollout:** ship with `mode: warn_only`. No existing task is affected unless it has a pending authorization-bound gate and dispatches a configured role; even then nothing is blocked.
- **Evidence before `required`:** count `authorization_dispatch_check` events by `outcome`. Before flipping to `required`, the operator should have observed enough applicable dispatches to judge two things: how often a dispatch that proceeded had no grant (the case the check exists for), and how often a warning was a false alarm because the dispatched role did not perform the gated action. If false alarms are common, `required` would block legitimate work and a declared-action variant (a later slice) is the better design. This slice does not decide that threshold; it makes the question answerable.
- **Rollback:** a revert, or `mode: off`. After a revert the events already written are ordinary `meta.yaml` events and remain valid (the validator checks `type` as a free string and `agent` against the actor enum, which a role satisfies). There is no data migration.

## Documented limits

- The check applies only to dispatches the Office performs, of configured roles, for tasks with a pending bound gate. It does not constrain what a dispatched role does, an operator working by hand (the VS-010 correction was done that way), a role outside `roles`, or a task without a bound gate.
- It checks that a valid grant **exists now**, not that this dispatch consumes it; one grant covers every dispatch until it expires or is revoked.
- The action is **inferred**, so a dispatch that does not perform the gated action is still checked.
- `actor` and `via` on a grant are unverified free text; a grant can be recorded by whoever can run the writer. `scope` is not compared.
- `warn_only` is advisory by design; only `required` blocks, and only dispatches.
- A gitignored local overlay cannot change the `authorization_dispatch` block (protected), but anyone who can edit the tracked `office.config.yaml` or the repository can.

## Deferred

A declared-action variant, checking roles beyond the configured list, single-use or dispatch-linked grants, scope comparison, identity or attestation, dashboard visibility of the events, Phase 1C (branch state) and 1D (failure classification).
