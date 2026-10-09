# Open a Task with Gates (#55, first slice)

**Status:** design, approved in conversation 2026-10-09; pending written-spec review. **Issue:** vestearth/AI-office-agency#55, a follow-up from the #28 acceptance audit. **Builds on:** #28 Phases 1A–2F (main f87cd9a5).

## Summary

Add a governed way to **open a task**: `./run-agent.sh open <TASK_ID>`. A conductor uses it instead of writing `status.yaml` by hand.

- It creates the run (`task.md`, `status.yaml`, `meta.yaml`).
- It **requires a decision about completion gates** when the task is opened. That decision is one of: one or more named **presets** (`staging`, `production`, `backfill`), custom gates, or `--no-gates "<reason>"`.
- Gates are declared with the same record construction the gate writer uses.

The goal is that gates are declared where tasks actually start.

## Evidence

- **Adoption is the gap.** On the main checkout, 2 of 519 tasks have `completion_gates` (TASK-EAR-384/385, hand-written). There are 0 `pm-output.yaml` with `completion_gates`, and 0 revisions, grants, failure classifications or branches.
- **Tasks are not opened through the PM path.**
  - Of the recent tasks (TASK-VS-012/014/015/016/017, TASK-EAR-378/383), none has a `pm-output.yaml`, a meta event or a run record.
  - Their `status.yaml` was written by a conductor session; for example, the first history rows read `pm created -> assigned` and `Codex conductor`.
  - So the #28 Phase 2E path (PM output declares gates on sync) does not fire in practice.
  - No task has been opened since 2E merged (2026-10-08), so that path is also unexercised.
- **Conductors are never told about gates.** `AGENTS.md` (Operator model) and `docs/codex.md` do not mention completion gates. Only the role contracts (`agents/*.md`, 2E) do, and a conductor hand-writing `status.yaml` never reaches the PM output contract.
- **Keyword signals are too noisy to automate.** 338 of 427 `task.md` files mention staging, production, deploy, backfill, migration or smoke. A rule that guessed gates from text would put gates on almost every task.
- **The real runs show which gate sets recur.**
  - VS-006 and VS-008 (and EAR-384/385's `authenticated_staging`): a staging deploy, then a runtime check.
  - VS-003 and VS-008: promotion main → staging → production, then production acceptance (VS-008 is #28's motivating missing runtime acceptance).
  - VS-010: a small fix that grew into a production backfill with no gate declared.

## Non-goals

- **No guessing gates from task text.** The conductor chooses.
- **No change to `run-agent.sh <TASK> pm` or the 2E PM path.** They keep working as now.
- **No migration of TASK-EAR-384/385.** Their gates are live task data. Moving them onto the writer is a separate, operator-approved step that uses the existing writer after this ships.
- **No git commit, push or sync from `open`.**
- **No dashboard change.**

## Design

### 1. The command

```
./run-agent.sh open <TASK_ID> --title "<title>" [--agent <role>] [--description "<text>"] [--actor <role>]
    ( --preset <name> ... | --gate <name>:"<reason>" ... | --no-gates "<reason>" )
```

- **The gate decision is required.**
  - Accepted: at least one `--preset` or `--gate` (either or both, each repeatable), or `--no-gates "<reason>"` alone.
  - Giving none of them, or combining `--no-gates` with `--preset`/`--gate`, is a usage error.
- **`--agent <role>`** must be a role that can take work: `pm dev dev-2 reviewer debugger devops free-roam`.
  - `done` is refused (exit 2), because the validator forbids `done` as `assignment.primary`.
  - The default is `pm`, which opens the task in phase `pending`. Any other allowed role opens it in phase `assigned`.
- **`--actor <role>`** is who opens it, recorded in history and meta. The default is `pm`. Operators (Claude, Codex) stay in free text, per the operator model.
- **`--gate <name>:"<reason>"`** declares a custom pending gate with that reason and nothing else.
  - **Ordering and records** can be added after opening with `update-completion-gate.rb depend` / `require-record`.
  - **An authorization binding cannot be added later.** The writer accepts `--requires-authorization` only on `declare`, and a binding is immutable. So a gate that needs a grant is declared at open through a preset (`staging`, `production`, `backfill` carry the bound gates).
  - A bound gate that no preset covers is declared as a **new** gate after opening, with `update-completion-gate.rb declare <gate> --requires-authorization <action>`. It is never bound onto an existing custom gate.
- **All argument text goes through `CompletionGuard.utf8_argv`**, so Thai titles and reasons are stored as UTF-8 whatever the locale. An argument that is not valid UTF-8 is a usage error.
- **Normalization, before any merge, check or reconcile:**
  - Every gate name and reason — from flags and from the presets file — is `.strip`ped, exactly as the writer strips `--reason`, `--actor` and `--requires-authorization`. So is the `--no-gates` reason, `--title` and `--actor`.
  - An empty value after stripping is an error: exit 2 for a flag, exit 3 for a presets-file entry.
  - `reconcile_gate_plan` stores reasons as given, so without this step a reason such as `" reason "` would pass the plan check but differ in bytes from the writer's record and history row.

**What it writes**, only after every check has passed:

- **`runs/<TASK_ID>/task.md`:** `# <TASK_ID>: <title>`, then the description, or a one-line placeholder telling the conductor to fill in scope and acceptance.
- **`runs/<TASK_ID>/status.yaml`:**
  - `task_id`, `task_label` (the title);
  - `phase` and `state`, `iteration: 0`, `current_agent`, `ready: true`;
  - `blocked_on: []`, `waiting_for: []`;
  - `assignment: { primary: <agent>, parallel: false }`;
  - `created_at`, `updated_at`;
  - `history`;
  - `completion_gates` (absent with `--no-gates`).
  - `history` starts with one row, `created -> <phase>`, with the actor and a reason. With gates, the reason is `opened with completion gates: <comma-separated names>`. With `--no-gates`, it is `opened without completion gates: <reason>`.
  - Then come the gate history rows produced by the reconciliation below.
- **Gate records:**
  - The presets and custom gates are combined into one plan in 2E's `completion_gates` format.
  - The plan is checked with `CompletionGuard.plan_gate_errors`, then applied with `CompletionGuard.reconcile_gate_plan({}, plan, actor:, at:)`.
  - So every record and history row is byte-identical to what `ruby scripts/update-completion-gate.rb <TASK> declare <gate> --actor <A> --reason <R> [--requires-authorization …] [--after …] [--requires-record]` writes for the same gate in the same order.
- **`meta.yaml`:** a `task_opened` event, with details `gates=<names>` or `gates=none reason=<reason>`. With gates, it also gets a `completion_gate_updated` event per gate, using the writer's details.
  - `CompletionGuard.append_meta_event!` swallows write errors (it warns and returns `false`). `open` checks every call's result, and a `false` is a write failure (exit 5, see Atomicity).

### 2. Presets

**The file:** presets live in `tasks/templates/gate-presets.yaml` (tracked), next to `tasks/templates/new-task.yaml`. Each preset is a list of gates in 2E's plan format: `name`, `reason`, and optionally `after`, `requires_authorization`, `requires_record: true`.

| Preset | Gates, in order |
|---|---|
| `staging` | `implementation_verification` (requires a record) → `deploy_staging` (bound to `deploy_staging`, requires a record, after `implementation_verification`) → `staging_acceptance` (requires a record, after `deploy_staging`) |
| `production` | the three `staging` gates → `deploy_production` (bound to `deploy_production`, requires a record, after `staging_acceptance`) → `production_acceptance` (requires a record, after `deploy_production`) |
| `backfill` | `production_backfill` (bound to `production_backfill`, requires a record) |

- `production` includes the staging chain, because production in this workspace is promoted through staging.
- Each gate's `reason` states what must be shown. For example, `deploy_staging`: "the staging deploy ran from the reviewed commit".

**Composition:**
- Presets are taken in the order given, then custom gates. Gates are merged by name.
- A repeated name with an **identical** definition is merged (so `--preset staging --preset production` works). The same name with a **different** definition is a usage error naming the gate.
- The merged plan must pass `plan_gate_errors` and `CompletionGuard.ordering_errors` (no unknown `after`, no cycle).

**Loading:**
- An unreadable or malformed presets file, or a preset that fails `plan_gate_errors`, makes `open` refuse with exit 3, naming the preset and the problem. It never opens with a partial set.
- `AI_OFFICE_GATE_PRESETS` overrides the file path as a **test hook**. It is honoured only when `AuthorizationLedger.clock_override_allowed?` is true (`AI_OFFICE_RUNS_DIR` points at a non-live runs directory), the same rule as `AI_OFFICE_NOW`. Set against the live runs directory, it makes `open` refuse with exit 2.

### 3. Wiring

- **`scripts/task-namespace.rb` (new)** carries, with the same messages, the namespace rules `run-agent.sh` makes inline:
  - the registry rule from `enforce_new_task_namespace`: once `office.team.yaml` lists `prefixes:`, a new id must be `TASK-<your registered prefix>-NNN`;
  - intake's prefix rules: grammar, and `PKG`/`GW` reserved;
  - and one rule of its own: an id in the reserved `TASK-PKG-…`/`TASK-GW-…` namespaces is refused even in solo mode.
- **Who uses which rule:**
  - `open` applies all of them.
  - `run-agent.sh` keeps its inline checks unchanged, intake's and the PM creation gate's alike. `tests/integration/team-prefix-registry.sh` runs both from a sandboxed office that copies `run-agent.sh` without `scripts/`, so delegating to the module would break an existing suite. The event gateway still creates `TASK-GW-N` through `run-agent.sh … pm`.
  - So the two copies cannot drift unnoticed, `tests/integration/open-task.sh` pins the module's messages against intake and the PM gate in a sandboxed office.
- **`run-agent.sh open …`** delegates to `ruby scripts/open-task.rb` and exits with its status, the same way `intake` is dispatched. The usage text gains one line.
- **Intake** keeps `Next: ./run-agent.sh <ID> pm` and adds one line: `Or open it as a conductor: ./run-agent.sh open <ID> --title "…" (--preset … | --no-gates "…")`.
- **Atomicity:**
  - The task directory is created with `Dir.mkdir`, which fails if it exists, so two concurrent opens of one id cannot both succeed.
  - The files are written under the task's `.lock`, as the other writers do.
  - Any failure after the directory is created rolls the whole open back: the task directory is removed and the exit is 5. That covers a `task.md`/`status.yaml` write error, an exception, or an `append_meta_event!` returning `false`.
  - **Signals.** INT, TERM and HUP are deferred from just before the directory is created until the task is fully written (the handler only records the signal), so no signal can land between `mkdir` and the rollback that owns the directory. A recorded signal then rolls the open back and ends the run with that same signal. Only SIGKILL cannot be deferred.
  - The removal runs only on the directory this invocation created, never on one that already existed (that case is exit 4 before anything is written).
  - **Test hook `AI_OFFICE_OPEN_FAIL_AT=<task_md|status|meta>`** simulates a write failure at that step. It is honoured only when `AuthorizationLedger.clock_override_allowed?` is true, like the presets hook; set against the live runs, it is exit 2.
- **Ownership:** a newly opened task has no ownership record, so it is ungoverned (the existing rule). A lease can be taken later as usual.
- **Docs:**
  - `AGENTS.md` (Operator model): a conductor opens a new task with `./run-agent.sh open`, never by hand-writing `status.yaml`, and chooses presets or `--no-gates "<reason>"`; gates change afterwards only through `update-completion-gate.rb`.
  - `docs/codex.md`: the same rule for Codex as conductor.
  - `docs/completion-gates.md`: a new "Opening a task with gates" section with the preset table and composition rules.
  - `docs/skills/office-intake.md`: the open step after intake.

### 4. Exit codes

| Code | Meaning (nothing is written for any non-zero code) |
|---|---|
| 0 | opened |
| 1 | namespace refused: unregistered or wrong prefix, or the reserved `PKG`/`GW`. Same messages as `run-agent.sh` and intake. |
| 2 | usage error: missing `--title`; no gate decision; `--no-gates` combined with other gate flags; an unknown preset; a bad gate spec or name; conflicting duplicate definitions; plan or ordering errors; an unknown `--agent`/`--actor` or `--agent done`; a value that is empty after stripping; a malformed task id; non-UTF-8 text; a test hook (`AI_OFFICE_GATE_PRESETS`, `AI_OFFICE_OPEN_FAIL_AT`) used against the live runs |
| 3 | the presets file is unreadable or malformed |
| 4 | `runs/<TASK_ID>` already exists |
| 5 | a write failed after the task directory was created; the directory was removed |

### 5. Files

| File | Change |
|---|---|
| `scripts/open-task.rb` | new |
| `scripts/task-namespace.rb` | new: the namespace rules for `open` (mirrors `run-agent.sh`) |
| `scripts/gate-presets.rb` | new: load, normalize and compose presets |
| `tasks/templates/gate-presets.yaml` | new: the three presets |
| `run-agent.sh` | `open` dispatch and usage line; intake prints the open line (its namespace checks are unchanged) |
| `AGENTS.md`, `docs/codex.md`, `docs/completion-gates.md`, `docs/skills/office-intake.md` | conductor rule and docs |
| `tests/integration/open-task.sh` | new |

## Tests

**`tests/integration/open-task.sh` (new):**

- **O1 `--preset staging`:**
  - It creates `task.md`, `status.yaml` and `meta.yaml`.
  - `completion_gates` and the gate history rows are byte-identical to a task built with `update-completion-gate.rb declare` (same flags, same order).
  - The same holds for a custom gate whose reason has surrounding spaces (`--gate smoke:" staging smoke "`): it is stored stripped, exactly as the writer stores `--reason " staging smoke "`.
  - `validate-yaml.rb` passes, `run-agent.sh status` shows the Gates block, and `gate-view-json.rb` reads the task as readable.
- **O2 composition:** `production` contains the staging chain; `staging` plus `production` merges cleanly; `backfill` composes with either.
- **O3 custom gates and presets:** custom gates come after presets. The same name with a different definition is refused with exit 2, and nothing is written.
- **O4 `--no-gates "docs only"`:** there is no `completion_gates` key, and the reason is in the first history row and in the `task_opened` event. Combined with `--preset`, it is refused with exit 2.
- **O5** no gate decision, or a missing `--title`, gives exit 2 and nothing is written.
- **O6 namespace:**
  - With a registry, a wrong or unregistered prefix gives exit 1.
  - `PKG` and `GW` give exit 1.
  - With an empty registry, any valid id opens.
- **O7** an existing task directory gives exit 4, and its files are unchanged.
- **O8** a malformed presets file, or a preset failing `plan_gate_errors`, gives exit 3. The hook against the live runs gives exit 2.
- **O9** a Thai title and reason with `LANG` unset are stored as plain UTF-8, never `!binary`.
- **O10** `--agent dev` gives phase `assigned`; the default gives `pending`; `--agent done` and an unknown role give exit 2.
- **O11** two concurrent opens of one id: exactly one exits 0 and the other exits 4.
- **O12** `run-agent.sh open` passes the exit status through, and intake prints the open line.
- **O13 rollback:** with `AI_OFFICE_OPEN_FAIL_AT` set to `task_md`, `status` and `meta` in turn, `open` exits 5 and leaves no `runs/<TASK_ID>` directory; the same id then opens normally. Against the live runs, the hook gives exit 2.

**Regression:**
- `team-prefix-registry.sh`, `task-id-guidance-policy.sh` and `event-gateway.sh` pass unmodified.
- Every suite in the full integration set is checked for its own final PASS line, not only exit 0. The #28 audit found suites that exit 0 after aborting.

## Rollout, evidence and rollback

- **Rollout:** merge. Nothing persisted changes, and existing tasks are untouched.
- **Rollback:** revert. Tasks opened with `open` remain valid ordinary runs.
- **Evidence of success** is measured after merge, not in tests. The next real task is opened with `open`, and when it involves deploy or data work its gates appear in `run-agent.sh status` and in the dashboard's Action Center or Monitor.

## Documented limits

- **`open` relies on conductors using it.** A conductor can still hand-write `status.yaml`; the docs make `open` the rule, but nothing enforces it.
- **Custom gates carry only a name and a reason.** Ordering and record requirements are added later with the writer's `depend` / `require-record`. An authorization binding cannot be added to an existing gate: a gate that needs a grant comes from a preset, or is declared as a new gate with `declare --requires-authorization`.
- **The three presets are the starting set.** Add a preset when a real task needs a recurring set that none of them covers.
