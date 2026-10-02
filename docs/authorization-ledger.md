# Authorization Ledger, Completion Binding & Dispatch Check (Phase 1B.1–1B.2)

Issue: vestearth/AI-office-agency#28. Design: [`docs/superpowers/specs/2026-09-30-completion-gates-1b1-authorization-design.md`](superpowers/specs/2026-09-30-completion-gates-1b1-authorization-design.md). Opt-in; builds on [completion gates](completion-gates.md).

## What it is — and is not

An append-only, per-task record of who authorized which action (`runs/<task>/authorization.yaml`), and a way for a completion gate to **require** such an authorization. A task cannot reach `done` if, at the time the gate was passed, the grant was missing, mismatched, expired or already revoked. A revoke or expiry that comes after the pass is kept for audit and does not reopen the gate.

It does **not** stop anyone from performing a privileged action before a grant exists. Phase 1B.2 adds a dispatch-time check (below): the driver records, and in `required` mode refuses, dispatches of configured roles that lack a currently valid grant. There is still no action-time enforcement. What this slice provides is an auditable record and a completion binding that refuses to call the task done without it.

| Concept | Question | Where |
|---|---|---|
| Decision | What should we do? | `decision.yaml` (unchanged; `approve → done` untouched) |
| Authorization | May this declared action be accepted as authorized? | `authorization.yaml` |
| Completion | Is the task objectively complete? | `completion_gates` in `status.yaml` |

A grant never changes a task's phase.

## The ledger

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
    reason: "plan changed"
    at: "2026-09-30T02:00:00Z"
```

- Root keys: an existing ledger must be a map with **both** `task_id` and `authorizations` (a list). `task_id` must equal the name of the directory holding the file (the runtime loader enforces only this), so a ledger copied from another task is rejected by the loader, the guard, the writer (exit `3`) and `validate-yaml.rb` (for a task directory and for `authorization.yaml` validated as a single file); `validate-yaml.rb` additionally requires `task_id` to match the task-id grammar. Only an absent file is treated as an empty ledger.
- Common fields: `id`, `type`, `actor`, `via`, `reason`, `at`. Grant: `action`, `scope`, optional `expires_at`. Revoke: `revokes`. Timestamps are UTC, `YYYY-MM-DDTHH:MM:SSZ`.
- `action` is a closed enum matched **exactly**: `deploy_staging`, `deploy_production`, `production_data_mutation`, `production_backfill`, `live_load`, `external_side_effect`. There is no hierarchy: `external_side_effect` does not imply `deploy_production`.
- `scope` is **descriptive and audit-only**. Only `action` is compared, so `scope: wallet-service` does not stop a grant being cited for a different service.
- Ids are compared by their **numeric suffix** (`authz-999 < authz-1000`); uniqueness is by numeric value and ids must increase in file order. Every comparison goes through `AuthorizationLedger.id_number` (`scripts/authorization-ledger.rb`); the guard and validator never compare id strings.
- `at` values are informational for ordering and need not be monotonic; **revocation is decided by append order, never by the clock.** The writer never refuses an append because the local clock moved backwards.
- A revoke may reference only an earlier grant; a grant may be revoked once; `expires_at` must be strictly after `at`.

Write it only with `scripts/record-authorization.rb`:

```bash
ruby scripts/record-authorization.rb <TASK> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
ruby scripts/record-authorization.rb <TASK> revoke <authz-NNN> --actor X --via V --reason R
```

It takes the task lock and the ownership fence, writes `at` itself (never caller-supplied), allocates the next id, and records an `authorization_recorded` event in `meta.yaml`. On success it prints `authz-NNN grant` or `authz-NNN revoke`. It refuses a grant on a `done`/`aborted` task (exit `2`); a revoke is always allowed. Exit codes: `0` ok; `2` usage error, invalid flag combination or an append that would break a ledger integrity rule; `3` missing or corrupt `status.yaml`, or an unreadable / integrity-violating ledger; `9` ownership fence refused.

## Validity: `(T, S)`

A grant is valid as of time `T` and snapshot `S` (an authorization id) iff `id <= S`, `at <= T`, (`expires_at` absent or `T < expires_at`), and no revoke of it with `id <= S`. Timestamps decide only a grant's start and expiry.

For a gate, `T` is the pass time (`updated_at`) and `S` the ledger's highest id at that moment (`authorization_through`). A revoke recorded later has a higher id and never reopens the gate, even if a skewed clock gives it an earlier `at`.

## Binding a gate

```bash
ruby scripts/update-completion-gate.rb <TASK> declare <GATE> --actor A --requires-authorization <action>
ruby scripts/update-completion-gate.rb <TASK> pass    <GATE> --actor A --reason R --authorization authz-NNN[,…]
ruby scripts/update-completion-gate.rb <TASK> na      <GATE> --actor A --reason R
```

- `requires_authorization` is set only at declare (the flag is refused on `pass`/`na`), must be one of the action enum values, and is immutable; the writer carries it forward on every transition.
- A bound `pass` needs `--authorization`: every ref must be a grant of this task for exactly the required action and valid as of `(T, S)`. The writer reads the clock and the ledger high-water id **once**, under the task lock, and stores them as `updated_at` and `authorization_through`. `record-authorization.rb` takes the same lock, so a revoke cannot interleave between the check and the write.
- Refusals: `--authorization` missing on a bound gate, an empty ledger, or any ref that is unknown, of the wrong action, expired, revoked, or not yet granted exit `2`; `--authorization` on a gate that is not bound exits `2`; an unreadable ledger exits `3`. Output on success is `gate <GATE>: <old> -> <new>`.
- `na` on a bound gate means the protected action was not applicable / not performed. It is **not** an authorization waiver: it carries no `authorization_refs` or `authorization_through`.

## Enforcement

`CompletionGuard.can_transition_to_done_in(status, task_dir)` loads the ledger only when a gate carries `requires_authorization`, and evaluates each bound `pass` gate **as of its recorded `(updated_at, authorization_through)`**: `authorization_through` must be an entry in the ledger, every ref must be at or below it, and each ref must be a valid grant for exactly the required action as of that `(T, S)`. A forged or hand-edited `authorization_refs` is therefore blocked by the guard itself (unless it cites a validly hand-appended grant; see Documented limits) — through `sync-status-from-output.rb`, human `approve` in `reconcile-decision.rb`, `force-status-route.rb` and `decide-next-step.rb` — not only by `validate-yaml.rb`. An **absent** `authorization.yaml` is an empty ledger: a bound `pass` gate is then unresolved (no ref can resolve), and a bound `na` gate is unaffected (resolved only if it carries neither `authorization_refs` nor `authorization_through`). A ledger that **cannot be loaded** (unreadable, corrupt, integrity-violating, wrong root shape, `task_id` mismatch) is reported on stderr and leaves **every** bound gate unresolved, `na` included (fail closed); the same holds for the pure function when `authorizations:` is `nil`. Gates without `requires_authorization` never read the ledger. The pure function `can_transition_to_done(status, authorizations:)` remains for callers that have already loaded a ledger.

## Dispatch-time authorization check (Phase 1B.2)

Design: [`docs/superpowers/specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md`](superpowers/specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md).

When `run-agent.sh` dispatches a role listed in `authorization_dispatch.roles` (default `[devops]`) for a task that has a completion gate that is `pending` **and** carries `requires_authorization`, it checks that the ledger holds a grant of exactly that action that is valid **now** (current time, current high-water id; the validity rule above). The check is inferred from state the Office already holds, so a caller cannot skip it by not declaring an action. It is a check on dispatches the Office performs, **not** a sandbox: it does not constrain what the dispatched role does, an operator working by hand, a role outside `roles`, or a task without a pending bound gate.

| Mode (`office.config.yaml`) | `authorized` | `missing_authorization` | `config_error` | `check_error` |
|---|---|---|---|---|
| `"off"` | — | — | — | — |
| `warn_only` (shipped) | log | log + warn, proceed | log + warn, proceed | log + warn, proceed |
| `required` | log | log, **refuse** | log, **refuse** | log, **refuse** |

- **Where:** immediately before `record_run_start`, i.e. after the human-decision reroute, the `auto` umbrella and every routing / dependency / loop / budget guard, but before the run record, the ownership lease and the input-integrity snapshot. A refusal leaves no run record and no lease.
- **Evidence:** every applicable attempt appends one `authorization_dispatch_check` event to `meta.yaml` (`details: task=… mode=… outcome=… actions=…`, `agent` = the dispatched role). The events carry **no `run_id`**: they are **admission-attempt** evidence. Steps after the check (`ownership_acquire`, the integrity snapshot) can still stop the attempt, so an event does not prove the runner started; correlate with `ownership_acquired` / run records for that. The event write is guarded: if it fails, `warn_only` warns on stderr and proceeds, `required` refuses.
- **Configuration:** only a **wholly absent** `authorization_dispatch` block means the defaults (`warn_only`, `[devops]`). A present block with `mode` missing, `null`, not a string, or not `off`/`warn_only`/`required` is a `config_error` under effective mode `required`. Under `warn_only`/`required`, `roles` missing or not a list of concrete roles from `agents/manifest.yaml` is a `config_error` under that mode. Write `"off"` **quoted**: YAML reads an unquoted `off` (and `no`, `false`) as a boolean, which is not a string and therefore fails closed. The whole block is in `PROTECTED_PATHS`: a gitignored local overlay or a profile cannot change it, so switching to `required` is a reviewed change to the tracked `office.config.yaml`.
- **When the checker cannot answer** (crash, load error, usage error, unexpected exit, missing or inconsistent output), the driver records `check_error` and decides mode and scope **itself**, from the resolver's typed `dump` of the merged config and `status.yaml`, without the checker. Out-of-scope dispatches (no pending bound gate, a role outside a trustworthy `roles`, `"off"`) stay silent; anything it cannot show out of scope is in scope. The driver never reads this block through `config_value` / `config_list_values`, which flatten lists and coerce scalars.
- **Reading the evidence before `required`:** count `authorization_dispatch_check` events by `outcome`. The denominator is admission attempts, not executed dispatches. Unexplained `check_error` events, or event-write warnings on stderr, mean the dataset is incomplete.
- **What `required` proves:** a valid grant existed at admission. The task lock is not held through the runner, so a revoke recorded afterwards does not stop an admitted dispatch (TOCTOU). One grant covers every dispatch until it expires or is revoked, and the action is inferred, so a dispatch that does not perform it is still checked.

Checker CLI: `ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>` prints `outcome=<o> mode=<m> actions=<a,b>` and exits `0` (proceed), `14` (refuse), `2` (usage) or `3` (task state cannot be judged; the driver treats every exit other than a consistent `0`/`14` as `check_error`). Rollback: a revert, or `mode: "off"`; events already written stay valid `meta.yaml` events.

## Documented limits

- No action-time enforcement: nothing here prevents the action itself. The 1B.2 dispatch check gates only dispatches the Office performs (see above).
- `actor` / `via` are unverified free text; an agent can record a grant for itself.
- `scope` is not compared.
- A revoke after a `pass` is kept for audit and does not reopen the gate (there is no reopen). This rests on append order, so it holds under clock skew.
- A hand-edited gate that stays internally consistent is undetectable. The hostile edit is **lowering** `authorization_through` to before an already-present revoke while keeping it at or above every cited ref (grant `authz-001`, revoke `authz-002`, forged `authorization_through: authz-001` hides the revoke). It cannot be told apart from a genuine pass that preceded a later revoke. Raising the value only makes more revokes visible and is more restrictive. Hand-appending a grant is likewise undetectable. The same goes for removing `requires_authorization` from a gate by hand.
- `na` is an audited assertion, not a verified fact.

## Rollback

Code rollback is a revert, but it is **not semantics-preserving while authorization-bound gates are active.** After a revert, `authorization.yaml` is inert and a gate that still carries `requires_authorization` is judged by the Phase 1A guard (metadata only). Resolving the gates is not a safe boundary: a task with a bound gate already `pass` but not yet `done` still depends on this guard for its later transition. For every task with an authorization-bound gate (including one still `pending`), before reverting either let the task reach its terminal state (`done` or `aborted`) under 1B.1, or freeze/abort it and carry out an explicitly logged data migration recorded in its history and `meta.yaml`. Reverting first and cleaning up afterwards is not supported.

## Test hook

`AI_OFFICE_NOW=YYYY-MM-DDTHH:MM:SSZ` overrides the clock for `record-authorization.rb` and `update-completion-gate.rb` (a malformed value exits `2`). It is honored ONLY when `AI_OFFICE_RUNS_DIR` is set to a directory other than the live `<repo>/runs` (compared by real path, so a trailing slash or symlink does not bypass it); otherwise the writers exit `2` with an error. It is therefore refused against the live `runs/` directory, so on the live store `at` is always written by the writer. (A task directory that is itself a symlink into the live store, placed inside a different runs directory, would still reach it; that needs filesystem write access and is the same class as hand-editing the ledger — see Documented limits.) It overrides the ledger `at`, the gate `updated_at` and the gate history `at`. It does not change the `meta.yaml` event timestamps or the top-level `updated_at` of `status.yaml`, which use the real clock. It exists for tests, like `AI_OFFICE_RUNS_DIR`. The guard and validator never read the clock; they use the gate's recorded `updated_at`.
