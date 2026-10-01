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

### 1. Where the check runs, and when it applies

**Placement: the final stable dispatch-admission point.** `AGENT` is not final where `preflight` runs. Reading `run-agent.sh` in order: `preflight` → `reconcile_blocked_status` → human-decision reconciliation, which is the **only** place `AGENT` is reassigned (a decision such as `request_changes` or `escalate` routes the task to `status.current_agent`) → the `validation_failed`, loop, route-enforcement, blocked-dispatch and execution-budget guards → the `auto` umbrella, which re-enters `run-agent.sh` as a subprocess for each concrete role and then exits → agent-file checks and prompt assembly → `record_run_start` → `ownership_acquire` → the runner. The check is placed **immediately before `record_run_start`**, i.e. after every step that can reassign the role or stop the run and before any run record, ownership lease or runner exists. At that point `AGENT` is the role that will actually be dispatched, and:

- a role introduced by a human-decision reroute is the one checked (the original requested role is not);
- a dispatch stopped by a guard (blocked, dependency, route mismatch, loop, execution budget, `validation_failed`) never reaches the check and produces no evidence;
- the `auto` umbrella is never checked itself; each concrete sub-dispatch it launches is a fresh `run-agent.sh` process that passes through the whole flow and reaches the check with its own role, as do the parallel dev lanes;
- a refusal leaves no run record and no lease; and
- `scaffold`, `status`, `intake`, `verify` and `cleanup` never reach it. `preflight` stays where it is.

The check is **applicable** when, after the configuration is normalized (section 4):

1. the effective mode is not `off`;
2. the dispatched role is in `authorization_dispatch.roles` (every concrete manifest role may be configured, `pm` included; there is no special-case skip, so a configured role is always checkable);
3. `runs/<T>/status.yaml` exists and has at least one gate that is `pending` **and** carries the key `requires_authorization`.

When normalization yields `config_error` (section 4), conditions 1 and 2 cannot be evaluated and the check is applicable. Condition 3 is evaluated first and does not depend on the configuration. If it fails, the outcome is `not_applicable` whatever the configuration says: nothing is read beyond `status.yaml`, nothing is logged, and the dispatch proceeds exactly as before. In particular a task without a pending bound gate never reads `authorization.yaml` and is never affected by a configuration typo.

The check reads `status.yaml` once at this point. Gates are not written by anything between here and the runner except the dispatched role itself.

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
| `config_error` | the check is applicable (condition 3) but the configuration cannot give a trustworthy enforcement answer (see section 4) |
| `check_error` | **driver-synthetic**: the checker could not produce a trustworthy result (crash, usage error, unexpected exit); recorded by the driver, see section 3 |

This checks that a valid grant **exists**, not that this dispatch uses it. A dispatch of `devops` that only reads logs is checked the same as one that deploys, because the Office does not know what the role will do. That is the price of inferring instead of declaring, and it is why the default is `warn_only`.

### 3. Modes and what the driver does

| Effective mode | `authorized` | `missing_authorization` | `config_error` | `check_error` |
|---|---|---|---|---|
| `off` | not applicable | not applicable | not applicable | not applicable |
| `warn_only` (default) | log, proceed | log + warn, **proceed** | log + warn, **proceed** | log + warn, **proceed** |
| `required` | log, proceed | log, **refuse** | log, **refuse** | log, **refuse** |

`warn_only` must never break a run: observability and a safety check that is not yet enforcing must not turn a defect in the checker into a failed dispatch. `required` fails closed: a gate that cannot decide must not let the work through (the same rule as `preflight`).

**Every applicable dispatch is recorded, including the ones the checker could not judge.** If crashes, usage errors or unexpected exits only warned, blind dispatches would be absent from the dataset used to decide whether `required` is safe, and the authorized/missing ratio would look healthier than it is (survivorship bias). So the driver records a synthetic `check_error` outcome whenever the checker does not return a trustworthy result.

The checker is a standalone script, `scripts/authorization-dispatch-check.rb`:

```
ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>
```

It prints one line `outcome=<outcome> mode=<mode> actions=<a,b>` (actions empty when none) and exits `0` to proceed, `14` to refuse, `2` on a usage error. The exit codes are scoped to this script, as `preflight.rb`'s `10`–`13` are to that script; `scripts/event-gateway.rb` has its own code space and is never invoked on this path.

**Driver contract.** The driver treats the checker's result as trustworthy only if it exited `0` or `14` **and** printed a well-formed `outcome=` line consistent with that exit code. Anything else (exit `2`, any other exit, a signal, empty or malformed output, an exit code that disagrees with the printed outcome) is a `check_error`. For a `check_error` the driver cannot rely on the checker's mode, so it reads the mode itself with the same normalization as section 4 and applies the table: `warn_only` logs, warns and proceeds; `required`, and any mode that cannot be normalized to `warn_only` or `off`, logs and refuses. A `check_error` for a configured `off` is not applicable (nothing was going to be checked).

`run-agent.sh` adds one block immediately before `record_run_start`. It:

1. runs the checker (it runs for every concrete role dispatch; applicability is decided by the checker, not by a role skip in the driver);
2. on every outcome other than `not_applicable` appends an `authorization_dispatch_check` event to `meta.yaml` with `log_meta_event` (agent = the dispatched role; `details` = `task=… mode=… outcome=… actions=…`; the run id is attached by the existing mechanism);
3. on `missing_authorization` prints `Authorization check: <actions> have no valid grant for <TASK_ID>`; on `config_error` or `check_error` prints the problem; and, where the table says **refuse**, exits `1` with a message pointing at `scripts/record-authorization.rb` (for `missing_authorization`) or at the configuration (for the others).

No new record file is created: the `meta.yaml` events are the record. Counting events of this type by `outcome` is the evidence needed before enabling `required`; `check_error` events are part of that dataset, not noise.

**What `required` proves, and does not.** It proves that a valid grant existed **at dispatch admission**. The task lock is not held through the runner, so a revoke recorded after the check does not stop an already-admitted dispatch. That is consistent with this slice not being action-time enforcement.

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

- `roles` values must be concrete roles from `agents/manifest.yaml` (`pm`, `dev`, `dev-2`, `reviewer`, `debugger`, `devops`, `free-roam`). A configured role is always checkable: the driver has no per-role skip.

**Normalization (one deterministic rule, applied in this order, only once condition 3 of section 1 holds):**

| # | Configuration | Result |
|---|---|---|
| 1 | block absent | defaults: `warn_only`, `[devops]` |
| 2 | block present but not a mapping | no trustworthy mode: `config_error`, effective mode **`required`** |
| 3 | `mode` missing, not a string, or not one of `off` / `warn_only` / `required` | no trustworthy mode: `config_error`, effective mode **`required`** |
| 4 | `mode: off` | `not_applicable`. `off` is a deliberate kill switch and is honored without reading `roles`; a malformed `roles` under `off` is not reported at dispatch (the shipped-config test covers the shipped block) |
| 5 | `mode: warn_only` or `required`, and `roles` missing or not a list of known concrete roles | `config_error`, effective mode **the configured mode** |
| 6 | `mode: warn_only` or `required`, `roles` valid | normal; the role check (condition 2) applies |

So `{mode: off, roles: <anything>}` is `not_applicable`; a typo in `mode` (`of`, `warn-only`, an absent key) fails closed instead of silently disabling the check; and a typo in `roles` under an enforcing mode is a `config_error` handled by that mode (warn in `warn_only`, refuse in `required`). A safety gate must not fail open on a typo. The driver's `check_error` path uses this same normalization (it cannot trust the checker's own reading), so it needs a shared helper rather than a second implementation; the checker exposes it as `scripts/authorization-dispatch-check.rb mode` printing the effective mode.
- **Protected key.** The config resolver keeps gitignored local overlays from changing safety-relevant keys (`PROTECTED_PATHS` in `scripts/resolve-office-config.rb`). The whole `authorization_dispatch` block is added there: an overlay that could set `mode: off` or empty `roles` would silently weaken the check with no trace in `git status`, the same shape as `ownership.enabled`. A test pins that every key shipped in the block is protected, mirroring the existing `preflight` check. Consequence, stated for operators: unlike `reviewer.evidence_policy`, switching `warn_only` → `required` or changing `roles` requires a change to the **tracked** `office.config.yaml`, not a local overlay. That is intentional.

### 5. Files

| File | Change |
|---|---|
| `scripts/authorization-dispatch-check.rb` | New. `decide` and `mode` commands, the shared config normalization (section 4), outcome and exit-code contract. |
| `scripts/authorization-ledger.rb` | Add `Index#any_valid_grant?(action:, at:, through:)`. |
| `run-agent.sh` | New block immediately before `record_run_start`, plus the `check_error` driver contract. |
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
- role not in `roles`, `mode: off` → `not_applicable`; every concrete manifest role (`pm` included) can be configured and is then checked.
- `warn_only` exits 0 for every outcome; `required` exits 14 for `missing_authorization` and `config_error` and 0 for `authorized` and `not_applicable`.
- the normalization table, row by row: absent block → defaults; non-mapping block, missing mode, non-string mode, `of` / `warn-only` → `config_error` with effective mode `required` (exit 14); `{mode: off, roles: <malformed>}` → `not_applicable`; `{mode: warn_only|required, roles: <malformed or unknown role>}` → `config_error` handled by the configured mode; and a malformed configuration on a task WITHOUT a pending bound gate → `not_applicable` (condition 3 is evaluated first).
- the `mode` command prints the same effective mode the checker uses.
- `AI_OFFICE_NOW` is honored only against a non-live runs dir (the 1B.1 restriction applies here too).

Driver integration (`run-agent.sh`), using the same stub-runner approach as the existing driver tests:
- `warn_only`: a `devops` dispatch with a pending bound gate and no grant proceeds, prints the warning, and writes one `authorization_dispatch_check` event with `outcome=missing_authorization`; with a grant it proceeds and logs `outcome=authorized`; a `dev` dispatch logs nothing.
- `required`: the same dispatch exits 1, the runner is not invoked, status is untouched; with a grant it proceeds.
- `check_error`: with the checker made to crash, to exit `2`, to exit with another code, to print nothing, and to print an `outcome=` line that disagrees with its exit code, the driver records one `authorization_dispatch_check` event with `outcome=check_error`; `warn_only` warns and proceeds, `required` and an unnormalizable mode refuse, `off` records nothing.
- placement: a human decision that reroutes the dispatch (for example `request_changes` → `debugger`, with `debugger` configured and `devops` not) checks the **rerouted** role and logs it, and a dispatch whose original role was configured but is rerouted to an unconfigured role logs nothing; a dispatch stopped by a guard (blocked task, route mismatch, loop guard, execution budget) produces no event; the `auto` umbrella itself produces no event while a concrete sub-dispatch it launches does; a refusal in `required` leaves no run record and no ownership lease.
- the dispatch check never modifies `status.yaml`, the ledger, or any gate.

Config:
- the shipped `office.config.yaml` block validates and every key in it is in `PROTECTED_PATHS` (a key added without protection fails the test).
- a local overlay that tries to set `authorization_dispatch.mode: off` is ignored.

Regression: every Phase 1A and 1B.1 suite still passes unchanged; tasks without bound gates behave byte-for-byte as before.

## Rollout, evidence and rollback

- **Rollout:** ship with `mode: warn_only`. No existing task is affected unless it has a pending authorization-bound gate and dispatches a configured role; even then nothing is blocked.
- **Evidence before `required`:** count `authorization_dispatch_check` events by `outcome`. Before flipping to `required`, the operator should have observed enough applicable dispatches to judge two things: how often a dispatch that proceeded had no grant (the case the check exists for), and how often a warning was a false alarm because the dispatched role did not perform the gated action. If false alarms are common, `required` would block legitimate work and a declared-action variant (a later slice) is the better design. A third criterion is **checker reliability**: the observation window should contain no unexplained `check_error` events, otherwise the other two ratios rest on an incomplete denominator. This slice does not decide the thresholds; it makes the questions answerable.
- **Who flips the switch:** because the block is protected, moving to `required` is a reviewed change to the tracked `office.config.yaml`.
- **Rollback:** a revert, or `mode: off`. After a revert the events already written are ordinary `meta.yaml` events and remain valid (the validator checks `type` as a free string and `agent` against the actor enum, which a role satisfies). There is no data migration.

## Documented limits

- The check applies only to dispatches the Office performs, of configured roles, for tasks with a pending bound gate. It does not constrain what a dispatched role does, an operator working by hand (the VS-010 correction was done that way), a role outside `roles`, or a task without a bound gate.
- It checks that a valid grant **exists now**, not that this dispatch consumes it; one grant covers every dispatch until it expires or is revoked.
- The action is **inferred**, so a dispatch that does not perform the gated action is still checked.
- `actor` and `via` on a grant are unverified free text; a grant can be recorded by whoever can run the writer. `scope` is not compared.
- `warn_only` is advisory by design; only `required` blocks, and only dispatches.
- TOCTOU: the check proves a valid grant existed at dispatch admission; it is not held through the run, so a revoke afterwards does not stop an already-admitted dispatch.
- A gitignored local overlay cannot change the `authorization_dispatch` block (protected), but anyone who can edit the tracked `office.config.yaml` or the repository can.

## Deferred

A declared-action variant, checking roles beyond the configured list, single-use or dispatch-linked grants, scope comparison, identity or attestation, dashboard visibility of the events, Phase 1C (branch state) and 1D (failure classification).
