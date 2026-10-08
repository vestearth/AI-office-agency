# Phase 2B Gate Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A completion gate can declare `after: [gates]` and cannot be passed until those gates are resolved. The ordering is declared at declare time or added later to a pending gate through a new `depend` action, and is add-only and acyclic.

**Architecture:** `CompletionGuard` gets the shared ordering helpers (Task 1), which the writer and the validator both use. `update-completion-gate.rb` gets `--after`, the `depend` action, the ordered-pass check and carry-forward of `after` (Task 2). `validate-yaml.rb`, the schema and parity learn the stored-state rules (Task 3). Docs come last (Task 4). There is no new writer, no new `done` rule and no dispatch effect.

**Tech Stack:** Ruby 2.6.10 stdlib (YAML/Psych, no gems), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-08-gate-ordering-phase-2b-design.md`](../specs/2026-10-08-gate-ordering-phase-2b-design.md) (PR #41). Read it before any task; this plan argues from it.

**Base:** this plan builds on Phase 2A (PR #40, branch `feat/issue-28-2a-plan-revisions`, head cb7efa6f): it extends `CompletionGuard.gate_record`, and its tests use `scripts/revise-task-plan.rb`. Cut the implementation branch from `main` **after PR #40 merges**. If it has not merged, cut from `origin/feat/issue-28-2a-plan-revisions` and rebase onto `main` once it does.

## Global Constraints

- Ruby is 2.6.10: no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- Never put backticks inside double-quoted bash strings in tests (they execute).
- `after` is a non-empty list of declared gate names (`CompletionGuard::GATE_NAME_PATTERN`). It has no duplicates, never contains the gate's own name, and the relation across gates is acyclic.
- **Resolved** means exactly what the `done` guard means: `CompletionGuard.gate_resolved?(gate, index)`. Without an index (no bound dependency to check), this reduces to `CompletionGuard.resolved?(gate)`.
- `pass` is ordered. `na` is not ordered. `depend` works only on a `pending` gate, requires `--reason`, and changes only `after`.
- `after` is add-only and is carried forward on every transition, the same way `requires_authorization` is.
- Writer exits: `2` usage error or refusal, `3` unreadable or malformed state (now including a malformed stored ordering), `9` ownership fence. Any refusal writes nothing.
- Gates without `after` keep their exact bytes. The 2A golden (`plan-revisions.sh` section W) must keep passing unchanged.
- No change to the `done` rules, the 1B.2 dispatch check, branches, or the 2A revision writer.
- Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2b-impl` (branch `feat/issue-28-2b-gate-ordering`). Use absolute paths. Never touch the main checkout, which another session owns.

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **Validation always has a task directory.** Both `validate-yaml.rb` entry points pass `task_dir` into `validate_status` (`validate_task_dir` and the direct-path mode use `task_dir:` / `status_dir`), so the ordering invariant is always checked against the ledger when a dependency is bound. The spec's single-file, status-only branch is kept in `validate_gate_ordering` (`index = nil` when `task_dir` is nil) but is not reachable from the CLI today.
2. **Unresolved-dependency wording.** A dependency that is `pass` with metadata but bound without a satisfied grant is reported as `name (pass, authorization not satisfied)`. Any other unresolved dependency is reported as `name (<status>)`. Only direct dependencies are named; a transitive wait still blocks because the direct dependency cannot have passed.
3. **`--after` parsing** keeps empty elements (`split(",", -1)`), so `a,` is refused as a malformed name rather than silently trimmed. Whitespace around names is stripped.
4. **The rollback-tolerance test is a strip test**, the same as 2A decision 5. Running the pre-2B validator inside the suite would need a second checkout. The suite instead pins that removing every `after` leaves a valid task whose pending gates still block `done`. That the pre-2B validator accepts `after` was checked by hand on main 379ccd13 and is recorded in the spec.
5. **`depend` keeps the record's key order.** `depend` uses `existing.merge("after" => …)`. When the gate had no `after`, the key is appended last. `gate_record` also places `after` last, so a gate's bytes are the same whether its ordering came from `declare --after` or from `depend`.
6. **Proof.** On 2026-10-08, every code block here was applied, task by task, to a scratch worktree at cb7efa6f (PR #40 head). Each "verify it fails" step failed as written and each "passes" step passed. Four mutations were each caught by the suite: carry-forward dropped, ordered pass disabled, cycle check disabled, validator invariant disabled. The following passed: `gate-ordering` (new), `plan-revisions` (2A byte pin), `completion-gates`, `partial-branches`, `authorization-ledger`, `failure-recovery`, `schema-validator-parity` and `authorization-dispatch`. TASK-VS-003/004/006/008/010 validate.

## Review Focus

1. `depend` with several names where one is bad must add nothing; there is no partial ordering. → Task 2, section C (RF).
2. Whitespace around names in `--after` (`" a , b "`) is tolerated and stored trimmed. → Task 2, section C (RF).
3. An unreadable `authorization.yaml` while a bound dependency must be checked gives exit 3, not a crash or a silent pass. → Task 2, section C (RF).
4. A transitive wait (`c` after `b` after `a`) blocks `c` and names the direct dependency `b`. → Task 2, section C (RF).
5. A gate declared by the 2A revision writer can be ordered with `depend`, and its pass is then ordered. → Task 2, section C (RF).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/completion-guard.rb` | `gate_record(after:)`, `gate_after`, `gate_reaches?`, `ordering_errors`, `unresolved_dependencies` | 1 |
| `scripts/update-completion-gate.rb` | `--after` on declare, the `depend` action, ordered `pass`, carry-forward, exit 3 on malformed stored ordering | 2 |
| `validate-yaml.rb` | `validate_gate_ordering` called from `validate_completion_gates` | 3 |
| `schemas/status.schema.yaml` | `after` on the gate record | 3 |
| `tests/integration/schema-validator-parity.sh` | Pins the `after` item grammar | 3 |
| `tests/integration/gate-ordering.sh` | New suite. Sections U (T1), R/X/B/C (T2), V/S (T3) | 1–3 |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | The ordering, `depend`, the limits | 4 |

The suite is one file built in sections. **Every task inserts its block immediately before the final line** `echo "[PASS] gate-ordering: gate ordering (#28 Phase 2B)"`. Run it with `bash tests/integration/gate-ordering.sh` from the worktree root. It takes well under a minute.

Patch steps below are given as small Ruby scripts. Each `rep!` is one exact old → new replacement that aborts if the old text is not found. Save the script to the session scratchpad (never inside the repo) and run it from the worktree root, e.g. `ruby /path/to/scratchpad/2b-writer-patch.rb scripts/update-completion-gate.rb`.

---

### Task 1: Shared ordering helpers in `CompletionGuard`

**Files:**
- Modify: `scripts/completion-guard.rb` (replace the `gate_record` method; the helpers follow it)
- Create: `tests/integration/gate-ordering.sh`

**Interfaces:**
- Consumes: `CompletionGuard.resolved?`, `gate_resolved?`, `GATE_NAME_PATTERN` (existing).
- Produces (all `module_function` on `CompletionGuard`):
  - `gate_record(status:, actor:, reason:, updated_at:, evidence_refs: nil, requires_authorization: nil, authorization_refs: nil, authorization_through: nil, after: nil) -> Hash`. `after` is placed last, and only when non-nil.
  - `gate_after(gate) -> Array<String>` (`[]` when absent or not a map)
  - `gate_reaches?(gates, start, target) -> Boolean`
  - `ordering_errors(gates) -> Array<String>`. Messages are `completion_gates.<name>.after …`; on a cycle it returns one message, `completion_gates.<name>.after creates a cycle through <dep>`.
  - `unresolved_dependencies(gates, gate, authorizations) -> Array<String>` (direct dependencies only; `authorizations` is an `AuthorizationLedger` index, or nil for the status rule)

- [ ] **Step 1: Create the suite with its header, section U and the PASS line**

Create `tests/integration/gate-ordering.sh` (mode 755):

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2B — gate ordering.
#
# A completion gate may declare `after: [gates]`. It cannot be passed until
# those gates are resolved (the same definition the done guard uses); `na` is
# not ordered. Orderings are declared with `declare --after` or added to a
# pending gate with `depend`; add-only and acyclic.
# Sections: U shared helpers, R replay (EAR-384/385), X writer refusals,
# B bound dependencies, C carry-forward / malformed state / fence,
# V stored-state validation, S team sync and revert safety.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
OWN="$ROOT/scripts/task-ownership.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# field <file> <dotted.path> — numeric segments index into lists; prints "" when absent.
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) do |node, key|
  if node.is_a?(Array) && key.match?(/\A\d+\z/) then node[key.to_i]
  elsif node.is_a?(Hash) then node[key]
  end
end
puts value.nil? ? "" : (value.is_a?(Array) ? value.join(",") : value)
RUBY
}
# task <TASK_ID> [phase] — a minimal governed task.
task() {
  local dir="$RUNS/$1" phase="${2:-assigned}"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: $phase
state: $phase
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-01'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}
gate() { ruby "$GATE" "$@"; }
force_done() { ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-08 done done reviewer "accept" >"$RUNS/force.log" 2>&1; }
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }
# set_gate <status.yaml> <gate> <ruby hash literal> — hand-edit one gate record (stored-state cases).
set_gate() {
  ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time])
    (s["completion_gates"] ||= {})[ARGV[1]] = eval(ARGV[2]); File.write(p, YAML.dump(s))' "$1" "$2" "$3"
}
# expect_refusal <exit> <label> <TASK_ID> <gate writer args...> — exit code matches and nothing is written.
expect_refusal() {
  local code="$1" label="$2" task_id="$3"; shift 3
  local status="$RUNS/$task_id/status.yaml"
  cp "$status" "$RUNS/before.yaml"
  rc=0; ruby "$GATE" "$task_id" "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "$code" "$label exit ($(cat "$RUNS/refusal.log"))"
  cmp -s "$status" "$RUNS/before.yaml" || fail "$label wrote status.yaml"
}

# --- U: shared ordering helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
done = { "status" => "pass", "actor" => "x", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" }
g = { "a" => done, "b" => { "status" => "pending", "after" => ["a"] }, "c" => { "status" => "pending", "after" => ["b"] } }
check "gate_after", CompletionGuard.gate_after(g["c"]), ["b"]
check "gate_after none", CompletionGuard.gate_after(g["a"]), []
check "gate_after non-map", CompletionGuard.gate_after(nil), []
check "reaches", CompletionGuard.gate_reaches?(g, "c", "a"), true
check "does not reach", CompletionGuard.gate_reaches?(g, "a", "c"), false
check "valid ordering", CompletionGuard.ordering_errors(g), []
check "no ordering", CompletionGuard.ordering_errors({ "a" => done }), []
check "self", CompletionGuard.ordering_errors({ "a" => { "after" => ["a"] } }), ["completion_gates.a.after names the gate itself"]
check "unknown", CompletionGuard.ordering_errors({ "a" => { "after" => ["zz"] } }), ["completion_gates.a.after names zz, which is not a declared gate"]
check "empty list", CompletionGuard.ordering_errors({ "a" => { "after" => [] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "not a list", CompletionGuard.ordering_errors({ "a" => { "after" => "b" } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "bad name", CompletionGuard.ordering_errors({ "a" => { "after" => ["Bad"] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "duplicate", CompletionGuard.ordering_errors({ "a" => {}, "b" => { "after" => ["a", "a"] } }), ["completion_gates.b.after lists a gate twice"]
check "2-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "3-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["c"] }, "c" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "unresolved", CompletionGuard.unresolved_dependencies(g, g["c"], nil), ["b"]
check "resolved", CompletionGuard.unresolved_dependencies(g, g["b"], nil), []
check "na counts as resolved", CompletionGuard.unresolved_dependencies({ "a" => done.merge("status" => "na") }, { "after" => ["a"] }, nil), []
check "pass without metadata is unresolved", CompletionGuard.unresolved_dependencies({ "a" => { "status" => "pass" } }, { "after" => ["a"] }, nil), ["a"]
check "gate_record with after",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs after]
check "gate_record bound with after, key order",
      CompletionGuard.gate_record(status: "pass", actor: "rv", reason: "r", updated_at: "T", requires_authorization: "live_load",
                                  authorization_refs: ["authz-001"], authorization_through: "authz-001", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs requires_authorization authorization_refs authorization_through after]
check "gate_record without after is unchanged",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T").keys,
      %w[status actor reason updated_at evidence_refs]
RUBY

echo "[PASS] gate-ordering: gate ordering (#28 Phase 2B)"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-ordering.sh`
Expected: FAIL with `undefined method 'gate_after' for CompletionGuard:Module (NoMethodError)`.

- [ ] **Step 3: Replace `gate_record` and add the helpers**

In `scripts/completion-guard.rb`, replace the whole `def gate_record(…) … end` method (from `  def gate_record(` up to the line before `  def gate_history_row(`) with:

```ruby
  def gate_record(status:, actor:, reason:, updated_at:, evidence_refs: nil, requires_authorization: nil,
                  authorization_refs: nil, authorization_through: nil, after: nil)
    record = { "status" => status, "actor" => actor }
    record["reason"] = reason unless reason.to_s.empty?
    record["updated_at"] = updated_at
    record["evidence_refs"] = Array(evidence_refs)
    record["requires_authorization"] = requires_authorization unless requires_authorization.nil?
    unless authorization_refs.nil?
      record["authorization_refs"] = authorization_refs
      record["authorization_through"] = authorization_through
    end
    record["after"] = after unless after.nil?
    record
  end

  # Phase 2B gate ordering: the gates a gate waits on ([] when it declares none).
  def gate_after(gate)
    gate.is_a?(Hash) && gate["after"].is_a?(Array) ? gate["after"] : []
  end

  # True when `target` is reachable from `start` by following `after` edges.
  def gate_reaches?(gates, start, target)
    seen = {}
    stack = [start]
    until stack.empty?
      current = stack.pop
      return true if current == target
      next if seen[current]

      seen[current] = true
      stack.concat(gate_after(gates[current]))
    end
    false
  end

  # Problems with the stored orderings (shape, names, self-reference, cycles),
  # shared by update-completion-gate.rb (exit 3) and validate-yaml.rb.
  def ordering_errors(gates)
    errors = []
    gates.each do |name, gate|
      next unless gate.is_a?(Hash) && gate.key?("after")

      after = gate["after"]
      unless after.is_a?(Array) && !after.empty? && after.all? { |dep| dep.is_a?(String) && dep.match?(GATE_NAME_PATTERN) }
        errors << "completion_gates.#{name}.after must be a non-empty list of gate names"
        next
      end
      errors << "completion_gates.#{name}.after lists a gate twice" unless after.uniq.size == after.size
      errors << "completion_gates.#{name}.after names the gate itself" if after.include?(name)
      missing = after.reject { |dep| dep == name || gates.key?(dep) }
      errors << "completion_gates.#{name}.after names #{missing.join(', ')}, which is not a declared gate" unless missing.empty?
    end
    return errors unless errors.empty?

    gates.each do |name, gate|
      gate_after(gate).each do |dep|
        return ["completion_gates.#{name}.after creates a cycle through #{dep}"] if gate_reaches?(gates, dep, name)
      end
    end
    errors
  end

  # The gates in `gate`'s after list that are not resolved. With an
  # authorization index this is the done guard's definition (gate_resolved?);
  # with nil, the Phase 1A status rule only.
  def unresolved_dependencies(gates, gate, authorizations)
    gate_after(gate).reject do |dep|
      authorizations ? gate_resolved?(gates[dep], authorizations) : resolved?(gates[dep])
    end
  end
```

- [ ] **Step 4: Run the suite and the 2A byte pin**

Run: `bash tests/integration/gate-ordering.sh && bash tests/integration/plan-revisions.sh`
Expected: `[PASS] gate-ordering: gate ordering (#28 Phase 2B)` and `[PASS] plan-revisions: plan revision record (#28 Phase 2A)`

- [ ] **Step 5: Commit**

```bash
git add scripts/completion-guard.rb tests/integration/gate-ordering.sh
git commit -m "feat(office): gate ordering helpers in CompletionGuard (#28 Phase 2B)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ordering in `update-completion-gate.rb`

**Files:**
- Modify: `scripts/update-completion-gate.rb`
- Modify: `tests/integration/gate-ordering.sh` (sections R, X, B, C and the Review Focus cases)

**Interfaces:**
- Consumes: the Task 1 helpers; `AuthorizationLedger.load`; `CompletionGuard.event_agent`, `gate_history_row`, `append_meta_event!`.
- Produces: the CLI.
  - `declare <GATE> … [--after G1,G2]`
  - `depend <GATE> --after G1,G2 --actor A --reason R`, whose stdout is `gate <GATE>: after += G1,G2`. Its history row is `gate <GATE>: after += …`, and its meta event is `completion_gate_updated` with details `gate=<GATE> after+=G1,G2 actor=<A>`.
  - An ordered `pass` refusal reads `gate '<GATE>' waits on: <dep> (<status>)[, …]`.

- [ ] **Step 1: Write sections R, X, B, C (failing)**

Insert before the PASS line:

````bash
# --- R: replay shapes ---
# EAR-384: a four-gate chain declared with --after.
D="$(task TASK-960)"
gate TASK-960 declare product_contract --actor pm --reason "contract locked" >/dev/null
gate TASK-960 declare shared_lib_publication --actor pm --reason "publish shared-lib" --after product_contract >/dev/null
gate TASK-960 declare implementation_verification --actor pm --reason "verify implementation" --after shared_lib_publication >/dev/null
gate TASK-960 declare authenticated_staging --actor pm --reason "staging smoke" --after implementation_verification >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.after)" "implementation_verification" "R declare stores after"
expect_refusal 2 "R pass before its dependency" TASK-960 pass authenticated_staging --actor reviewer --reason early
grep -q "waits on: implementation_verification (pending)" "$RUNS/refusal.log" || fail "R refusal names the unresolved gate: $(cat "$RUNS/refusal.log")"
expect_refusal 2 "R pass two steps early" TASK-960 pass implementation_verification --actor reviewer --reason early
for g in product_contract shared_lib_publication implementation_verification authenticated_staging; do
  gate TASK-960 pass "$g" --actor reviewer --reason "done in order" >/dev/null
done
validate "$D/status.yaml" || fail "R EAR-384 chain invalid: $(cat "$RUNS/validate.log")"
force_done TASK-960 || fail "R EAR-384 done refused after an in-order chain: $(cat "$RUNS/force.log")"

# EAR-385: gates declared at intake without ordering; the chain is added later with depend.
D="$(task TASK-961)"
for g in shared_lib_publication persistence_and_contract_verification authenticated_staging; do
  gate TASK-961 declare "$g" --actor pm --reason intake >/dev/null
done
out="$(gate TASK-961 depend persistence_and_contract_verification --after shared_lib_publication --actor pm --reason "verify against the published contract")"
assert_eq "$out" "gate persistence_and_contract_verification: after += shared_lib_publication" "R depend output"
gate TASK-961 depend authenticated_staging --after persistence_and_contract_verification --actor pm --reason "staging last" >/dev/null
assert_eq "$(field "$D/status.yaml" history.4.phase)" "gate authenticated_staging: after += persistence_and_contract_verification" "R depend history row"
assert_eq "$(field "$D/status.yaml" history.4.reason)" "staging last" "R depend history reason"
grep -q "gate=authenticated_staging after+=persistence_and_contract_verification" "$D/meta.yaml" || fail "R depend meta event"
expect_refusal 2 "R EAR-385 pass out of order" TASK-961 pass authenticated_staging --actor reviewer --reason early
for g in shared_lib_publication persistence_and_contract_verification authenticated_staging; do
  gate TASK-961 pass "$g" --actor dev-2 --reason "in order" >/dev/null
done
validate "$D/status.yaml" || fail "R EAR-385 invalid: $(cat "$RUNS/validate.log")"

# depend changes only `after`, and adds to an existing list.
D="$(task TASK-962)"
gate TASK-962 declare a --actor pm --reason a >/dev/null
gate TASK-962 declare c --actor pm --reason c >/dev/null
gate TASK-962 declare b --actor pm --reason "b first" >/dev/null
gate_without_after() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); g = s["completion_gates"][ARGV[1]].dup; g.delete("after"); print YAML.dump(g)' "$1" "$2"; }
before="$(gate_without_after "$D/status.yaml" b)"
gate TASK-962 depend b --after a --actor reviewer --reason "added later" >/dev/null
gate TASK-962 depend b --after c --actor reviewer --reason "and c" >/dev/null
assert_eq "$(gate_without_after "$D/status.yaml" b)" "$before" "R depend changes nothing but after"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a,c" "R depend appends"

# --- X: writer refusals write nothing ---
D="$(task TASK-963)"
gate TASK-963 declare a --actor pm --reason a >/dev/null
gate TASK-963 declare b --actor pm --reason b --after a >/dev/null
gate TASK-963 declare c --actor pm --reason c >/dev/null
gate TASK-963 pass c --actor reviewer --reason done >/dev/null
gate TASK-963 declare d --actor pm --reason d >/dev/null
gate TASK-963 na d --actor reviewer --reason "not needed" >/dev/null
gate TASK-963 declare x --actor pm --reason x >/dev/null
gate TASK-963 declare y --actor pm --reason y --after x >/dev/null
gate TASK-963 declare z --actor pm --reason z --after y >/dev/null
expect_refusal 2 "X declare after an unknown gate" TASK-963 declare e --actor pm --reason e --after zz
expect_refusal 2 "X declare after itself" TASK-963 declare e --actor pm --reason e --after e
expect_refusal 2 "X declare with a repeated name" TASK-963 declare e --actor pm --reason e --after a,a
expect_refusal 2 "X declare with an empty name" TASK-963 declare e --actor pm --reason e --after "a,"
expect_refusal 2 "X depend on a name already present" TASK-963 depend b --after a --actor pm --reason r
expect_refusal 2 "X depend creating a 2-cycle" TASK-963 depend a --after b --actor pm --reason r
expect_refusal 2 "X depend creating a 3-cycle" TASK-963 depend x --after z --actor pm --reason r
expect_refusal 2 "X depend on a passed gate" TASK-963 depend c --after a --actor pm --reason r
expect_refusal 2 "X depend on an na gate" TASK-963 depend d --after a --actor pm --reason r
expect_refusal 2 "X depend on an undeclared gate" TASK-963 depend zz --after a --actor pm --reason r
expect_refusal 2 "X depend without --after" TASK-963 depend b --actor pm --reason r
expect_refusal 2 "X depend without --reason" TASK-963 depend b --after c --actor pm
expect_refusal 2 "X --after on pass" TASK-963 pass a --actor pm --reason r --after c
expect_refusal 2 "X --after on na" TASK-963 na a --actor pm --reason r --after c
D="$(task TASK-964 done)"
expect_refusal 2 "X finished task" TASK-964 declare e --actor pm --reason e --after a

# na is not ordered; an na dependency counts as resolved.
D="$(task TASK-965)"
gate TASK-965 declare a --actor pm --reason a >/dev/null
gate TASK-965 declare b --actor pm --reason b --after a >/dev/null
gate TASK-965 declare c --actor pm --reason c --after a >/dev/null
gate TASK-965 na b --actor reviewer --reason "not needed" >/dev/null || fail "X na refused while a dependency is pending"
gate TASK-965 na a --actor reviewer --reason "not needed" >/dev/null
gate TASK-965 pass c --actor reviewer --reason ok >/dev/null || fail "X an na dependency did not count as resolved"

# --- B: dependencies bound to an authorization ---
D="$(task TASK-966)"
gate TASK-966 declare deploy --actor pm --reason "staging deploy" --requires-authorization deploy_staging >/dev/null
gate TASK-966 declare smoke --actor pm --reason "smoke after deploy" --after deploy >/dev/null
expect_refusal 2 "B bound dependency pending" TASK-966 pass smoke --actor reviewer --reason early
ruby "$AUTHZ" TASK-966 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
gate TASK-966 pass deploy --actor devops --reason deployed --authorization authz-001 >/dev/null
gate TASK-966 pass smoke --actor reviewer --reason "smoke ok" >/dev/null || fail "B pass refused after the bound dependency passed"
D="$(task TASK-967)"
gate TASK-967 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-967 declare smoke --actor pm --reason s --after deploy >/dev/null
ruby "$AUTHZ" TASK-967 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
gate TASK-967 pass deploy --actor devops --reason deployed --authorization authz-001 >/dev/null
ruby "$AUTHZ" TASK-967 revoke authz-001 --actor operator --via chat --reason "window closed" >/dev/null
gate TASK-967 pass smoke --actor reviewer --reason "smoke ok" >/dev/null || fail "B a revocation after the dependency passed unresolved it"
D="$(task TASK-968)"
gate TASK-968 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-968 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" deploy '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "requires_authorization" => "deploy_staging"}'
expect_refusal 2 "B bound dependency passed without a grant" TASK-968 pass smoke --actor reviewer --reason early
grep -q "waits on: deploy (pass, authorization not satisfied)" "$RUNS/refusal.log" || fail "B refusal wording: $(cat "$RUNS/refusal.log")"

# --- C: carry-forward, malformed stored ordering, ownership fence ---
D="$(task TASK-970)"
gate TASK-970 declare a --actor pm --reason a >/dev/null
gate TASK-970 declare b --actor pm --reason b --after a >/dev/null
gate TASK-970 declare c --actor pm --reason c --after a >/dev/null
gate TASK-970 pass a --actor reviewer --reason ok >/dev/null
gate TASK-970 pass b --actor reviewer --reason ok >/dev/null
gate TASK-970 na c --actor reviewer --reason "not needed" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a" "C after carried forward on pass"
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a" "C after carried forward on na"
D="$(task TASK-971)"
gate TASK-971 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "after" => ["zz"]}'
expect_refusal 3 "C stored after names an unknown gate" TASK-971 declare c --actor pm --reason c
D="$(task TASK-972)"
set_gate "$D/status.yaml" a '{"status" => "pending", "after" => ["b"]}'
set_gate "$D/status.yaml" b '{"status" => "pending", "after" => ["a"]}'
expect_refusal 3 "C stored cycle" TASK-972 pass a --actor reviewer --reason r
D="$(task TASK-973)"
gate TASK-973 declare a --actor pm --reason a >/dev/null
gate TASK-973 declare b --actor pm --reason b >/dev/null
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-973 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$GATE" TASK-973 depend b --after a --actor pm --reason r >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced depend wrote status.yaml"
# Review Focus: a multi-name --after with one bad name adds nothing.
D="$(task TASK-974)"
gate TASK-974 declare a --actor pm --reason a >/dev/null
gate TASK-974 declare b --actor pm --reason b >/dev/null
expect_refusal 2 "RF depend with one unknown name among several" TASK-974 depend b --after a,zz --actor pm --reason r
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "" "RF no partial ordering recorded"
# Review Focus: spaces around names in --after are tolerated.
gate TASK-974 declare c --actor pm --reason c --after " a , b " >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a,b" "RF --after names are trimmed"
# Review Focus: an unreadable ledger while a bound dependency is checked is exit 3.
D="$(task TASK-975)"
gate TASK-975 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-975 declare smoke --actor pm --reason s --after deploy >/dev/null
printf 'authorizations: [\n' > "$D/authorization.yaml"
expect_refusal 3 "RF corrupt ledger with a bound dependency" TASK-975 pass smoke --actor reviewer --reason r
# Review Focus: only direct dependencies are named; a transitive wait still blocks through them.
D="$(task TASK-976)"
gate TASK-976 declare a --actor pm --reason a >/dev/null
gate TASK-976 declare b --actor pm --reason b --after a >/dev/null
gate TASK-976 declare c --actor pm --reason c --after b >/dev/null
expect_refusal 2 "RF transitive wait" TASK-976 pass c --actor reviewer --reason early
grep -q "waits on: b (pending)" "$RUNS/refusal.log" || fail "RF refusal names the direct dependency: $(cat "$RUNS/refusal.log")"
# Review Focus: a gate declared by a 2A revision can be ordered with depend.
D="$(task TASK-977)"
gate TASK-977 declare publish --actor pm --reason p >/dev/null
ruby "$ROOT/scripts/revise-task-plan.rb" TASK-977 scope_expanded --actor dev --reason "scope grew" --gate backfill >/dev/null
gate TASK-977 depend backfill --after publish --actor pm --reason "backfill after publication" >/dev/null
expect_refusal 2 "RF revision-declared gate is ordered" TASK-977 pass backfill --actor reviewer --reason early
validate "$D/status.yaml" || fail "RF revision + ordering invalid: $(cat "$RUNS/validate.log")"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-ordering.sh`
Expected: FAIL. The first `declare … --after` hits the writer's usage error (`unknown flag --after`, exit 2), and `set -e` stops the suite with the usage line `Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na> <GATE> …`.

- [ ] **Step 3: Patch the writer**

Save as `2b-writer-patch.rb` in the scratchpad and run `ruby <scratchpad>/2b-writer-patch.rb scripts/update-completion-gate.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "# and `authorization_through`, so the writer's decision and the guard's later\n# re-evaluation always agree (see scripts/authorization-ledger.rb).\n#\n# Usage:\n",
     "# and `authorization_through`, so the writer's decision and the guard's later\n# re-evaluation always agree (see scripts/authorization-ledger.rb).\n#\n" \
     "# Phase 2B: a gate may declare `after: [gates]` (`--after` on declare, or the\n" \
     "# `depend` action on a pending gate; add-only, acyclic). It cannot be passed\n" \
     "# until those gates are resolved, judged exactly as the done guard judges\n" \
     "# them. `after` is carried forward on every transition, like the binding.\n#\n# Usage:\n")
rep!(s, "#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>]\n",
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>] [--after G1,G2]\n")
rep!(s, "#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>\n",
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>\n" \
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> depend  <GATE> --after G1,G2 --actor <A> --reason <R>\n")
rep!(s, "# status.yaml / authorization ledger, non-map completion_gates, unknown\n# evidence id;",
     "# status.yaml / authorization ledger, non-map completion_gates, malformed\n# stored ordering, unknown evidence id;")
rep!(s, 'TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na" }.freeze',
     'TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na", "depend" => "pending" }.freeze')
rep!(s, 'warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na> <GATE> --actor <A> [--reason <R>] " \\' + "\n" +
        '       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002]"',
     'warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na|depend> <GATE> --actor <A> [--reason <R>] " \\' + "\n" +
     '       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002] " \\' + "\n" +
     '       "[--after G1,G2]"')
rep!(s, %q{usage!("unknown action '#{action}' (expected declare, pass or na)")},
     %q{usage!("unknown action '#{action}' (expected declare, pass, na or depend)")})
rep!(s, %Q{  when "--authorization" then opts[:authorization] = value.split(",").map(&:strip).reject(&:empty?).uniq\n},
     %Q{  when "--authorization" then opts[:authorization] = value.split(",").map(&:strip).reject(&:empty?).uniq\n} +
     %Q{  when "--after" then opts[:after] = value.split(",", -1).map(&:strip)\n})
rep!(s, %q{usage!("--reason is required for #{action}") if %w[pass na].include?(action) && opts[:reason].to_s.empty?},
     %q{usage!("--reason is required for #{action}") if %w[pass na depend].include?(action) && opts[:reason].to_s.empty?})
rep!(s, %Q{Array(opts[:authorization]).each do |ref|\n  usage!("authorization id '\#{ref}' must match authz-NNN") if AuthorizationLedger.id_number(ref).nil?\nend\n},
     %Q{Array(opts[:authorization]).each do |ref|\n  usage!("authorization id '\#{ref}' must match authz-NNN") if AuthorizationLedger.id_number(ref).nil?\nend\n} + <<~'RUBY')
       usage!("--after is only valid with declare or depend") if opts.key?(:after) && !%w[declare depend].include?(action)
       usage!("depend needs --after <gate>[,<gate>]") if action == "depend" && !opts.key?(:after)
       new_after = Array(opts[:after])
       new_after.each do |dep|
         usage!("gate name '#{dep}' in --after must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless dep.match?(CompletionGuard::GATE_NAME_PATTERN)
       end
       usage!("--after names a gate twice") unless new_after.uniq.size == new_after.size
       usage!("gate '#{gate_name}' cannot wait on itself") if new_after.include?(gate_name)
     RUBY
rep!(s, %Q{gates = (status["completion_gates"] ||= {})\nexisting = gates[gate_name]\nnew_status = TRANSITIONS.fetch(action)\n},
     %Q{gates = (status["completion_gates"] ||= {})\n} + <<~'RUBY' + %Q{existing = gates[gate_name]\nnew_status = TRANSITIONS.fetch(action)\n})
       ordering_problems = CompletionGuard.ordering_errors(gates)
       unless ordering_problems.empty?
         warn "status.yaml #{ordering_problems.first}; fix it by hand before using this helper."
         exit 3
       end
     RUBY
rep!(s, %Q{  usage!("gate '\#{gate_name}' is not declared for \#{task_id}; declare it first") unless existing.is_a?(Hash)\nend\n},
     %Q{  usage!("gate '\#{gate_name}' is not declared for \#{task_id}; declare it first") unless existing.is_a?(Hash)\nend\n} + <<~'RUBY')
       if action == "depend" && existing["status"] != "pending"
         usage!("gate '#{gate_name}' is #{existing['status']}; an ordering can only be added to a pending gate")
       end
       unknown_deps = new_after.reject { |dep| gates.key?(dep) }
       usage!("--after names #{unknown_deps.join(', ')}, which is not a declared gate") unless unknown_deps.empty?
       if action == "depend"
         present = new_after & CompletionGuard.gate_after(existing)
         usage!("gate '#{gate_name}' already waits on #{present.join(', ')}") unless present.empty?
         looped = new_after.select { |dep| CompletionGuard.gate_reaches?(gates, dep, gate_name) }
         usage!("--after #{looped.join(', ')} would create a cycle: it already waits on '#{gate_name}'") unless looped.empty?
       end

       # Ordered pass: every gate in `after` must be resolved, as the done guard
       # judges it (a bound dependency needs its recorded grant to hold).
       if action == "pass" && !CompletionGuard.gate_after(existing).empty?
         deps = CompletionGuard.gate_after(existing)
         dep_index = nil
         if deps.any? { |dep| gates[dep].is_a?(Hash) && gates[dep].key?("requires_authorization") }
           dep_index = begin
             AuthorizationLedger.load(task_dir)
           rescue AuthorizationLedger::Error => e
             warn e.message
             exit 3
           end
         end
         waiting = CompletionGuard.unresolved_dependencies(gates, existing, dep_index)
         unless waiting.empty?
           labels = waiting.map do |dep|
             state = gates[dep]["status"].to_s
             CompletionGuard.resolved?(gates[dep]) ? "#{dep} (#{state}, authorization not satisfied)" : "#{dep} (#{state})"
           end
           usage!("gate '#{gate_name}' waits on: #{labels.join(', ')}")
         end
       end
     RUBY
rep!(s, %Q{old_status = existing.is_a?(Hash) ? existing["status"].to_s : "absent"\n\ngates[gate_name] = CompletionGuard.gate_record(\n  status: new_status, actor: opts[:actor], reason: opts[:reason], updated_at: now,\n  evidence_refs: opts[:evidence], requires_authorization: bound_action,\n  authorization_refs: authorization_refs, authorization_through: authorization_through\n)\n\nstatus["updated_at"] = Date.today.to_s\nstatus["history"] = [] unless status["history"].is_a?(Array)\nstatus["history"] << CompletionGuard.gate_history_row(gate_name, old_status, new_status,\n                                                      actor: opts[:actor], reason: opts[:reason], at: now)\n},
     <<~'RUBY')
       old_status = existing.is_a?(Hash) ? existing["status"].to_s : "absent"

       if action == "depend"
         # depend changes only `after`; the gate's own status and metadata stay.
         gates[gate_name] = existing.merge("after" => CompletionGuard.gate_after(existing) + new_after)
         history_row = {
           "phase" => "gate #{gate_name}: after += #{new_after.join(',')}",
           "agent" => CompletionGuard.event_agent(opts[:actor]),
           "reason" => opts[:reason],
           "at" => now
         }
         event_details = "gate=#{gate_name} after+=#{new_after.join(',')} actor=#{opts[:actor]}"
         summary = "gate #{gate_name}: after += #{new_after.join(',')}"
       else
         # `after` is carried forward exactly like the binding: the record is rebuilt.
         carried_after = action == "declare" ? opts[:after] : existing["after"]
         gates[gate_name] = CompletionGuard.gate_record(
           status: new_status, actor: opts[:actor], reason: opts[:reason], updated_at: now,
           evidence_refs: opts[:evidence], requires_authorization: bound_action,
           authorization_refs: authorization_refs, authorization_through: authorization_through,
           after: carried_after
         )
         history_row = CompletionGuard.gate_history_row(gate_name, old_status, new_status,
                                                        actor: opts[:actor], reason: opts[:reason], at: now)
         event_details = "gate=#{gate_name} #{old_status}->#{new_status} actor=#{opts[:actor]}"
         summary = "gate #{gate_name}: #{old_status} -> #{new_status}"
       end

       status["updated_at"] = Date.today.to_s
       status["history"] = [] unless status["history"].is_a?(Array)
       status["history"] << history_row
     RUBY
rep!(s, %Q{  details: "gate=\#{gate_name} \#{old_status}->\#{new_status} actor=\#{opts[:actor]}"\n)\n\nputs "gate \#{gate_name}: \#{old_status} -> \#{new_status}"\n},
     %Q{  details: event_details\n)\n\nputs summary\n})
File.write(path, s)
```

Then run `ruby -c scripts/update-completion-gate.rb` (expect `Syntax OK`) and read the diff once. It touches the header comment, `TRANSITIONS`, the usage text, `--after` parsing and pre-lock checks, the stored-ordering exit 3, the `depend`/existence/cycle checks, the ordered-pass block, and the record/history build.

- [ ] **Step 4: Run the suite and the existing writer suites**

Run: `bash tests/integration/gate-ordering.sh`
Expected: `[PASS] gate-ordering: gate ordering (#28 Phase 2B)`

Run: `bash tests/integration/plan-revisions.sh && bash tests/integration/completion-gates.sh && bash tests/integration/partial-branches.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own PASS line. `plan-revisions` section W is the byte pin for gates without `after`.

- [ ] **Step 5: Prove three behaviours bite (evidence for the PR; revert each with `git checkout scripts/update-completion-gate.rb` and re-apply the patch, or keep a copy)**

1. Change `carried_after = action == "declare" ? opts[:after] : existing["after"]` to `… : nil` → expect `[FAIL] C after carried forward on pass`.
2. Change `if action == "pass" && !CompletionGuard.gate_after(existing).empty?` to `if false` → expect `[FAIL] R pass before its dependency exit`.
3. Change `looped = new_after.select { |dep| CompletionGuard.gate_reaches?(gates, dep, gate_name) }` to `looped = []` → expect `[FAIL] X depend creating a 2-cycle exit`.

- [ ] **Step 6: Commit**

```bash
git add scripts/update-completion-gate.rb tests/integration/gate-ordering.sh
git commit -m "feat(office): ordered gate pass, --after and depend (#28 Phase 2B)

A gate may wait on other gates; pass is refused until they are resolved as
the done guard judges them. Orderings are declared with --after or added to
a pending gate with depend (add-only, acyclic) and carried forward on every
transition.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Validator, schema and parity

**Files:**
- Modify: `validate-yaml.rb` (`validate_completion_gates` calls a new `validate_gate_ordering`, defined directly before `validate_branches`)
- Modify: `schemas/status.schema.yaml` (an `after` property on the gate record, directly after `authorization_through`)
- Modify: `tests/integration/schema-validator-parity.sh` (a check directly before `failed = false`)
- Modify: `tests/integration/gate-ordering.sh` (sections V, S)

**Interfaces:**
- Consumes: `CompletionGuard.ordering_errors`, `gate_after`, `unresolved_dependencies`; `AuthorizationLedger.load`.
- Produces: the validator messages `<label>.completion_gates.<name>.after …` and `<label>.completion_gates.<name>: status pass but after gate(s) unresolved: <deps>`.

- [ ] **Step 1: Write sections V and S (failing)**

Insert before the PASS line:

````bash
# --- V: stored-state validation ---
# expect_invalid <status.yaml> <message fragment> <label>
expect_invalid() {
  if validate "$1"; then fail "V $3 validated"; fi
  grep -qF "$2" "$RUNS/validate.log" || fail "V $3 message: $(cat "$RUNS/validate.log")"
}
D="$(task TASK-980)"
gate TASK-980 declare a --actor pm --reason a >/dev/null
gate TASK-980 declare b --actor pm --reason b --after a >/dev/null
validate "$D/status.yaml" || fail "V a valid ordering was rejected: $(cat "$RUNS/validate.log")"
v_case() { # <label> <gate> <ruby hash> <fragment>
  local dir="$RUNS/v-$1"; mkdir -p "$dir"; cp "$D/status.yaml" "$dir/status.yaml"
  set_gate "$dir/status.yaml" "$2" "$3"
  expect_invalid "$dir/status.yaml" "$4" "$1"
}
v_case unknown b '{"status" => "pending", "after" => ["zz"]}' "completion_gates.b.after names zz, which is not a declared gate"
v_case self b '{"status" => "pending", "after" => ["b"]}' "completion_gates.b.after names the gate itself"
v_case empty b '{"status" => "pending", "after" => []}' "completion_gates.b.after must be a non-empty list of gate names"
v_case cycle a '{"status" => "pending", "after" => ["b"]}' "creates a cycle through"
v_case early-pass b '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["a"]}' \
  "completion_gates.b: status pass but after gate(s) unresolved: a"
mkdir -p "$RUNS/v-na"; cp "$D/status.yaml" "$RUNS/v-na/status.yaml"
set_gate "$RUNS/v-na/status.yaml" b '{"status" => "na", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["a"]}'
validate "$RUNS/v-na/status.yaml" || fail "V na with a pending dependency rejected: $(cat "$RUNS/validate.log")"
# A bound dependency that passed without a grant does not resolve it, with the ledger in view.
D="$(task TASK-981)"
gate TASK-981 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-981 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" smoke '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["deploy"]}'
expect_invalid "$D/status.yaml" "completion_gates.smoke: status pass but after gate(s) unresolved: deploy" "bound dependency pending"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-966"
cp "$RUNS/TASK-966/status.yaml" "$RUNS/TASK-966/task.md" "$RUNS/TASK-966/authorization.yaml" "$RUNS/sync/TASK-966/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-966/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy with a bound dependency does not validate: $(cat "$RUNS/validate.log")"
# As after a revert: stripping every `after` leaves a valid task and the done rule unchanged.
D="$(task TASK-985 review)"
gate TASK-985 declare a --actor pm --reason a >/dev/null
gate TASK-985 declare b --actor pm --reason b --after a >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].each_value { |g| g.delete("after") }; File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without after invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-985; then fail "S after stripping after, pending gates no longer block done"; fi
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-ordering.sh`
Expected: FAIL with `[FAIL] V unknown validated`.

- [ ] **Step 3: Patch the validator**

Save as `2b-validator-patch.rb` in the scratchpad and run `ruby <scratchpad>/2b-validator-patch.rb validate-yaml.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "        validate_gate_authorization_fields(gate, glabel, errors)\n      end\n    else\n",
     "        validate_gate_authorization_fields(gate, glabel, errors)\n      end\n      validate_gate_ordering(gates, label, errors, task_dir)\n    else\n")
rep!(s, "def validate_branches(data, label, errors)\n", <<~'RUBY' + "def validate_branches(data, label, errors)\n")
  # Phase 2B (issue #28): the `after` orderings are well formed and acyclic, and
  # a passed gate's `after` gates are resolved, judged as the done guard judges
  # them (ledger-aware with a task directory). na and pending gates are not
  # checked against their ordering.
  def validate_gate_ordering(gates, label, errors, task_dir)
    problems = CompletionGuard.ordering_errors(gates)
    problems.each { |message| errors << "#{label}.#{message}" }
    return unless problems.empty?

    passed = gates.select { |_name, gate| gate.is_a?(Hash) && gate["status"] == "pass" && !CompletionGuard.gate_after(gate).empty? }
    return if passed.empty?

    index = nil
    bound_dependency = passed.values.flat_map { |gate| CompletionGuard.gate_after(gate) }.any? do |dep|
      gates[dep].is_a?(Hash) && gates[dep].key?("requires_authorization")
    end
    if task_dir && bound_dependency
      begin
        index = AuthorizationLedger.load(task_dir)
      rescue AuthorizationLedger::Error => e
        errors << "#{label}.completion_gates: cannot check gate ordering: #{e.message}"
        return
      end
    end
    passed.each do |name, gate|
      waiting = CompletionGuard.unresolved_dependencies(gates, gate, index)
      next if waiting.empty?

      errors << "#{label}.completion_gates.#{name}: status pass but after gate(s) unresolved: #{waiting.join(', ')}"
    end
  end

RUBY
File.write(path, s)
```

- [ ] **Step 4: Run the suite**

Run: `bash tests/integration/gate-ordering.sh`
Expected: `[PASS] gate-ordering: gate ordering (#28 Phase 2B)`

- [ ] **Step 5: Add the parity check (failing)**

In `tests/integration/schema-validator-parity.sh`, insert directly before the line `failed = false`:

```ruby
# --- gate ordering (issue #28 Phase 2B) -----------------------------------------
after_samples = ["a", "wave_1", "Bad", "1a", "a-b", ""]
checks << ["status.completion_gates.after item grammar", after_samples.map { |s| CompletionGuard::GATE_NAME_PATTERN.match?(s) },
           after_samples.map { |s| Regexp.new(pattern_at("schemas/status.schema.yaml", "properties", "completion_gates", "additionalProperties", "properties", "after", "items", "pattern")).match?(s) }]
# --- end gate ordering block ----------------------------------------------------

```

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: FAIL with `schema schemas/status.schema.yaml: missing ["properties", "completion_gates", "additionalProperties", "properties", "after", "items", "pattern"]`.

- [ ] **Step 6: Add `after` to the schema**

In `schemas/status.schema.yaml`, insert directly after the line `            passed (append-order snapshot). Absent on na.` (the end of `authorization_through`'s description, inside the gate record's `properties`):

```yaml
        after:
          type: array
          minItems: 1
          uniqueItems: true
          items:
            type: string
            pattern: "^[a-z][a-z0-9_]*$"
          description: >
            Phase 2B (issue #28): gates that must be resolved before this gate
            may pass. Set with `declare --after` or added while pending with
            `depend`; add-only and carried forward on every transition.
            Existence, self-reference, cycles and the ordering invariant are
            validator-only.
```

- [ ] **Step 7: Run parity and the suite**

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: `  ok: status.completion_gates.after item grammar (6 values agree)` and `[PASS] schema-validator-parity: …`

Run: `bash tests/integration/gate-ordering.sh`
Expected: `[PASS] gate-ordering: …`

- [ ] **Step 8: Prove the invariant bites**

Change `    next if waiting.empty?` in `validate_gate_ordering` to `    next` → expect `[FAIL] V early-pass validated`. Then restore it.

- [ ] **Step 9: Commit**

```bash
git add validate-yaml.rb schemas/status.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/gate-ordering.sh
git commit -m "feat(office): validate gate ordering in stored state (#28 Phase 2B)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs and full regression

**Files:**
- Modify: `docs/completion-gates.md` (a new section directly before `## Compatibility`)
- Modify: `docs/task-transition-contract.md` (the `completion_gates` bullet)

**Interfaces:**
- Consumes: the CLI and record from Tasks 2–3.
- Produces: documentation only.

- [ ] **Step 1: Add the section to `docs/completion-gates.md`**

Insert directly before the line `## Compatibility`:

````markdown
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

````

- [ ] **Step 2: Extend the transition-contract bullet**

In `docs/task-transition-contract.md`, replace

```
  `validate-yaml.rb` on stored state.
- `branches` (issue #28 Phase 1C
```

with

```
  `validate-yaml.rb` on stored state. A gate may wait on other gates
  (`after`, Phase 2B): it cannot pass until they are resolved. See
  [`docs/completion-gates.md`](completion-gates.md#gate-ordering-phase-2b).
- `branches` (issue #28 Phase 1C
```

- [ ] **Step 3: Full regression**

Run from the worktree root:

```bash
for t in gate-ordering plan-revisions completion-gates partial-branches authorization-ledger failure-recovery schema-validator-parity; do bash "tests/integration/$t.sh" > "<scratchpad>/2b-$t.log" 2>&1 && echo "ok $t" || echo "FAIL $t"; done
```

Expected: seven `ok` lines. Then run `bash tests/integration/authorization-dispatch.sh` in the background (about 6 minutes) and confirm its final `[PASS]` line. Any failure in a pre-existing suite is a regression: fix the code, never the test.

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do ruby validate-yaml.rb "$t" >/dev/null && echo "ok $t" || echo "FAIL $t"; done
```

Expected: five `ok` lines.

- [ ] **Step 4: Commit**

```bash
git add docs/completion-gates.md docs/task-transition-contract.md
git commit -m "docs(office): gate ordering (#28 Phase 2B)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Where |
|---|---|
| Design 1: `after` shape, existence, no self/duplicates, acyclic, add-only, carried forward | T1 `ordering_errors`; T2 parse/depend checks and carry-forward; tests U, X, C |
| Design 2: `declare --after`, `depend` (pending only, `--reason`, changes only `after`, history row + meta event) | T2; tests R (EAR-385, "depend changes nothing but after"), X |
| Design 2: ordered pass using the done guard's definition, ledger only for bound dependencies, refusal names the unresolved gates | T2 ordered-pass block; tests R, B, RF |
| Design 2: `na` not ordered | T2 (no check on na); test X ("na is not ordered") |
| Design 2 refusals (exit 2) and exit 3 on a malformed stored ordering; exit 9 | T2; tests X, C, RF |
| Design 3: 1B.1 snapshot rule (revocation after the dependency passed does not unresolve it) | T2; test B (TASK-967) |
| Design 3: 2A revision-declared gates can be ordered with `depend` | test RF (TASK-977) |
| Design 4: validator rules, ordering invariant, schema, parity | T3; tests V, parity |
| Tests: EAR-384/385 replay, sync copy, revert safety, regression | T2 R; T3 S; T4 Step 3 (plus decision 4) |
| Docs | T4 |
