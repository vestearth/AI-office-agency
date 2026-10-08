# Phase 2D — Gate Status View

**Status:** design, approved in conversation 2026-10-08; pending written-spec review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A–1D, 2A plan revisions, 2B gate ordering and 2C gate run records (all merged; main be3f2ad2).

## Summary

Make completion gates visible where operators and agents actually look. A read-only helper, `CompletionGuard.gate_view`, derives each gate's state from the same rules the guard enforces:

- whether it is resolved;
- what it is waiting on;
- whether a grant is available;
- whether a record is required, or recorded;
- whether it can be passed **right now**.

`run-agent.sh status` (the single-task and all-tasks views) and `scripts/adapter-status.rb` (the runtime/agent JSON) render that view, together with a short summary of plan revisions. Nothing is written, and `next_command` / `Next:` are unchanged.

## Evidence

- **Gates are invisible on the status surfaces.**
  - `run-agent.sh status TASK-EAR-384` prints phase, agent, validation, `Next:` and recent history. It prints nothing about the task's four `completion_gates`, two of which are pending.
  - The all-tasks line shows a branch count but no gate count.
  - `scripts/adapter-status.rb` exports `branches` but not `completion_gates`.
  - The dashboard (`dashboard/server`, `runScanner`) reads `status.yaml` directly and shows neither gates nor branches.
- **Gate state drifts from the work.** TASK-EAR-385's history reads "Authenticated admin smoke passed", yet its `authenticated_staging` gate is still `pending`.
- **Nothing from 2A–2C is used yet.** Across the 519 runs in the main checkout:
  - 0 use `revisions`, 0 use `after` (the single `after:` hit, in TASK-EAR-381, is prose), and 0 use `requires_record` or `ran`;
  - only TASK-EAR-384/385 use `completion_gates`, and both in the basic form.

  Operators cannot act on state they cannot see.

## Concepts kept separate

| Concept | Where | 2D change |
|---|---|---|
| Completion rules (resolution, ordering, records, authorization) | `CompletionGuard`, writers, validator | none |
| Routing (`next_command`, `Next:`) | `run-agent.sh`, `adapter-status.rb` | none |
| **Gate view** (derived, read-only) | `CompletionGuard.gate_view` | **new** |
| **Rendering** | `run-agent.sh status`, `adapter-status.rb` | **adds gate and revision output** |

## Non-goals

- Any change to how gates resolve, pass or block `done`, or to `next_command` / `Next:`. Runtimes and agents may execute `next_command`.
- The dashboard UI (`dashboard/`). It is deferred to its own slice.
- Writing anything: no status, meta, ledger or evidence writes, and no fixing of drift.
- Verifying `actor`, `reason` or `ran` against reality, or predicting future grant expiry.
- Detecting prose/gate drift automatically.

## Design

### 1. `CompletionGuard.gate_view(status, task_dir, now: nil)`

The helper is read-only and never raises for state problems. It returns a hash:

```ruby
{
  "readable" => true,            # false: see "problem"
  "problem"  => nil,             # e.g. "completion_gates.b.after names zz, which is not a declared gate"
  "gates" => [                   # one per gate, in declaration order
    {
      "name" => "implementation_verification",
      "status" => "pending",
      "resolved" => false,
      "waits_on" => ["shared_lib_publication (pending)"],
      "requires_authorization" => nil,   # or the action
      "grant" => nil,                    # "available" | "missing" | "unknown" for a pending bound gate
      "requires_record" => false,
      "ran" => nil,                      # the stored ran map on a pass
      "passable" => false,               # pending gates only; false otherwise
      "unresolved_reason" => nil         # for a pass/na that is not resolved
    }
  ],
  "summary" => { "total" => 4, "resolved" => 2, "passable" => 1,
                 "by_status" => { "pass" => 2, "pending" => 2 } },
  "revisions" => { "count" => 0, "latest" => nil }   # latest: { "id", "kind", "at" }
}
```

**Field rules**

- **`resolved`:** `CompletionGuard.gate_resolved?(gate, index)`, the done guard's definition. It includes 1B.1 authorization (judged on the gate's recorded snapshot) and the 2C record rule.
- **`waits_on`:** the gates in the gate's `after` that are unresolved, as returned by `unresolved_dependencies(gates, gate, index)`. Each is labelled exactly as the 2B/2C pass refusal labels it:
  - `name (status)`;
  - `name (pass, missing ran record)`;
  - `name (pass, authorization not satisfied)`.
- **`grant`:** for a `pending` gate with `requires_authorization`:
  - `available` if `index.any_valid_grant?(action:, at: now, through: index.high_water_id)`;
  - `missing` if not;
  - `unknown` if the ledger cannot be loaded.
- **`passable`:** true only for a `pending` gate whose `waits_on` is empty and which, if bound, has `grant == "available"`. A required record does **not** make a gate un-passable. The record is supplied at pass time, and the renderer shows it as a hint. `actor` and `reason` are not considered.
- **`unresolved_reason`:** for a `pass`/`na` gate that is not resolved:
  - `missing ran record` when `missing_run_record?`;
  - otherwise `authorization not satisfied` when a bound gate has its metadata but no satisfied grant;
  - otherwise `missing actor/reason/updated_at`.
- **`revisions`:** the count of entries in `status["revisions"]` when it is a list. `latest` is the last entry's `id`, `kind` and `at`.
- **`now`:** defaults to `AuthorizationLedger.now_utc`, falling back to `Time.now.utc` if the test hook raises. Tests pass it explicitly.
- **Unreadable state.** `readable` is false, `gates` is `[]`, and `problem` holds the first error, in either of these cases:
  - `status` is not a map, or `completion_gates` is present but not a map;
  - any gate record is not a map;
  - `ordering_errors` or `run_record_errors` is non-empty.

  `summary` and `revisions` are still filled where they can be.
- **Ledger.** It is loaded once, only when some gate is bound. A load error makes every bound gate's `grant` `unknown`, and judges `resolved` / `waits_on` status-only (index `nil`). It does not make the view unreadable.

### 2. `run-agent.sh status <TASK>` (single task)

After the `Branches:` block and before `Validation:`, when the task has `completion_gates` or `revisions`:

```
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass — ran: operator 05fae97f
  implementation_verification: pending — can pass now
  authenticated_staging: pending — waits on implementation_verification (pending)
Revisions: none
```

Line forms per gate:

| Gate state | Line |
|---|---|
| `pass` or `na`, resolved | `<name>: pass` or `<name>: na`. A `pass` with `ran` appends ` — ran: <by> <ref or url>`. |
| `pass` or `na`, not resolved | `<name>: pass — NOT resolved: <unresolved_reason>` |
| `pending`, passable | `<name>: pending — can pass now`, plus ` (needs --ran-by and --ran-ref/--ran-url)` when `requires_record` |
| `pending`, waiting on gates | `<name>: pending — waits on <waits_on joined by ', '>` |
| `pending`, no waits, bound, `grant` missing | `<name>: pending — waits for a <action> grant` |
| `pending`, no waits, bound, `grant` unknown | `<name>: pending — waits for a <action> grant (authorization ledger unreadable)` |

Other cases:
- **Unreadable view:** `Gates: unreadable (<problem>; run validate-yaml.rb)`.
- **`Revisions:` line:** `Revisions: none`, or `Revisions: <count>, latest <id> <kind> @<at>`.
- **Task with neither `completion_gates` nor `revisions`:** the output is byte-identical to today's.

### 3. `run-agent.sh status` (all tasks)

For a task with `completion_gates`, append one part to its line:

```
gates=pass:2,pending:2,ready:1
```

- `ready` is `summary["passable"]`.
- The `by_status` order follows first appearance in declaration order.
- An unreadable view appends `gates=unreadable`.
- Tasks without gates keep byte-identical lines.

### 4. `scripts/adapter-status.rb`

Add keys only when present, as `branches` is today:

- `"completion_gates"`: `gate_view["gates"]`, plus `"readable"` / `"problem"` folded in as `"gates_readable"` and `"gates_problem"` when not readable. Note that this is a **list of derived entries** in declaration order, not the stored `completion_gates` map from `status.yaml`. Consumers that need the raw record read `status.yaml`.
- `"gates_summary"`: `gate_view["summary"]`.
- `"revisions"`: `gate_view["revisions"]`, when `status` has a `revisions` key.

A task with neither key yields exactly today's JSON key set and values. `next_command` is unchanged, and the query stays read-only: `status.yaml`, `authorization.yaml` and `meta.yaml` are byte-identical after it.

### 5. Docs

- `docs/runtime-adapter-contract.md`: the three optional keys and their shapes.
- `docs/completion-gates.md`: a "Seeing gates (Phase 2D)" section with the `status` lines and what `passable` does and does not promise.

### 6. Files

| File | Change |
|---|---|
| `scripts/completion-guard.rb` | `gate_view` (plus a small label helper shared with the 2B/2C pass refusal, so the wording cannot drift) |
| `scripts/update-completion-gate.rb` | uses the shared label helper for its ordered-pass refusal; the messages stay byte-identical |
| `run-agent.sh` | the `status` renderer requires `scripts/completion-guard` and prints the Gates/Revisions block and the list part |
| `scripts/adapter-status.rb` | the three optional keys |
| `tests/integration/gate-status.sh` | new suite |
| `docs/runtime-adapter-contract.md`, `docs/completion-gates.md` | Design 5 |

## Tests

New suite `tests/integration/gate-status.sh`. Each behaviour is seen failing before its implementation.

**Helper**
- `waits_on` labels for a pending, a record-missing and an authorization-missing dependency.
- `passable` cases:
  - unbound pending;
  - bound with and without a grant;
  - with an unresolved dependency;
  - with `requires_record` (still passable);
  - on `pass`/`na` (false).
- `grant` is `unknown` with a corrupt ledger, with no raise and no unreadable view.
- `unresolved_reason` for each of its three causes.
- An unreadable view for a non-map `completion_gates`, a non-map gate, a malformed ordering and a malformed record, with no raise.
- `revisions` count and latest.
- A fixed `now:` makes grant expiry deterministic.

**Agreement with the writer.** For a matrix of gate states, `passable` true means `update-completion-gate.rb pass` succeeds when given `--ran-*` if `requires_record`. `passable` false for a pending gate means it is refused with exit 2. This pins the view to the enforcing code.

**Single-task `status`:**
- EAR-384 replay: four gates, ordering added with `depend`, and the exact lines from Design 2.
- Every line form in the Design 2 table, plus the unreadable line and both Revisions lines.
- A task without gates or revisions gives output identical to the pre-2D renderer. The suite compares against the base code via `git show <base>:run-agent.sh` run on the same fixture, or against a pinned golden.

**All-tasks `status`:** the `gates=…` part, `gates=unreadable`, and unchanged lines for tasks without gates.

**Adapter:**
- The three keys and their values.
- The key set for a task without gates equals today's.
- `next_command` is unchanged.
- `status.yaml`, `authorization.yaml` and `meta.yaml` are byte-identical after the query.

**Regression:** every suite from 1A–1D and 2A–2C, plus `adapter-status.sh` and `partial-branches.sh` (which reads `status` output), passes unchanged.

## Rollout, evidence and rollback

- **Read-only and additive.** No writer, guard rule or file under `runs/` changes. Output for tasks without gates or revisions is unchanged.
- **Evidence that it earns its place:** after release, check whether gates in active runs (EAR-384/385 and new ones) move in step with their history, with fewer "done in prose, pending in the gate" cases, and whether `depend` and `require-record` start being used.
- **Rollback:** a revert. No data was written, so nothing needs cleaning up.

## Documented limits

- `passable` is a snapshot. A grant can expire or be revoked before `pass` runs, and the writer stays the authority.
- It does not consider `actor` or `reason`, and does not verify `ran`.
- The dashboard UI is unchanged in this slice.

## Deferred

- Dashboard UI rendering of gates, branches and revisions.
- Automatic detection of prose/gate drift.
- Governed intake declaration of gates.
- Authorization actions for merge and push.
- Ordering of branches.
- The Execution Blueprint.
