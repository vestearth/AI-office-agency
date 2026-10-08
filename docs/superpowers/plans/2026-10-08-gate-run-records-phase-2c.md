# Phase 2C Gate Run Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A passing gate can record what actually ran (`ran: {by, ref, url}`), and a gate can opt in to requiring that record (`requires_record: true`). A required record that is missing on a stored pass leaves the gate unresolved.

**Architecture:**
- `CompletionGuard` gets the shared record helpers (`ran_errors`, `missing_run_record?`, `run_record_errors`). Its `resolved?` gains the record condition, so the `done` guard and 2B ordering inherit it (Task 1).
- `update-completion-gate.rb` gets the `--requires-record` switch, the `require-record` action, `--ran-*` on pass, carry-forward of `requires_record`, and an ordering label for a missing record (Task 2).
- The validator, schema and parity check learn the stored-state rules (Task 3).
- Docs come last (Task 4).

There is no new writer and no new file in `runs/`.

**Tech Stack:** Ruby 2.6.10 stdlib (YAML/Psych, no gems), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-08-gate-run-records-phase-2c-design.md`](../specs/2026-10-08-gate-run-records-phase-2c-design.md) (PR #43, approved at 4835cfad). Read it before any task; this plan argues from it.

**Base:** `main` at 429c85e8 (2A and 2B merged). Nothing else needs to merge first.

## Global Constraints

- Ruby is 2.6.10: no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- Never put backticks inside double-quoted bash strings in tests (they execute).
- `ran` is a map with only `by`, `ref` and `url`. `by` is a non-empty string, and at least one of `ref` / `url` must be present. `ref` is a non-empty string. `url` matches `\Ahttps://\S+\z` (`CompletionGuard::RAN_URL_PATTERN`). `ran` is present only on a `pass`.
- `requires_record`, if present, is exactly `true`. It is add-only and carried forward on every transition.
- `resolved?` is false for a `pass` with `requires_record: true` and no well-formed `ran`. Nothing else about resolution changes.
- Writer exits: `2` for a usage error or refusal; `3` for unreadable or malformed state, which now includes a malformed stored run record; `9` for the ownership fence. Any refusal writes nothing.
- Gates without the new keys keep their exact bytes. The 2A golden (`plan-revisions.sh` section W) must keep passing unchanged.
- No change to the 1B.2 dispatch check, branches, the 2A revision writer or the evidence ledger.
- Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2c-impl` (branch `feat/issue-28-2c-gate-run-records`, cut from `origin/main`). Use absolute paths. Never touch the main checkout: another session owns it.

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **One malformed-state check.** `run_record_errors` is appended to the writer's existing stored-ordering check (`ordering_errors(gates) + run_record_errors(gates)`), so malformed orderings and run records give the same exit 3 message path. A missing record on a required pass is *not* malformed: it is an unresolved gate, as the spec says.
2. **`--ran-*` and `--requires-record` repeated are refused.** These are single-valued, so a repeat is an error rather than "last wins". This follows the 2B finding about silently dropped values.
3. **The validator reports a missing record twice by design.** If `ran` is present but malformed, both the shape error (`ran needs ref or url`) and the direct `requires_record but ran is missing or malformed` message appear, because both are true. The direct message is the one a reader needs.
4. **The reviewer's PR #43 suggestions are tested.** Section C pins that `requires_record` survives `depend` and that `after` survives `require-record`.
5. **The 2B deferred docs minor is folded in.** Task 4 extends the exit-3 sentence in `docs/completion-gates.md` with "a malformed stored ordering (Phase 2B) or run record (Phase 2C)". That sentence is the one 2C edits anyway.
6. **The rollback test is a strip test**, as in 2A/2B. The pre-2C validator's acceptance of both keys was checked by hand on main 429c85e8 and is recorded in the spec.
7. **Proof.** On 2026-10-08, every code block here was applied, task by task, to a scratch worktree at main 429c85e8. Each "verify it fails" step failed as written, and each "passes" step passed. The suite caught all five mutations: pass check off, carry-forward dropped, teeth removed from `resolved?`, `na` keeping `ran`, and the validator's missing-record rule off. These suites passed: `gate-records` (new), `gate-ordering`, `plan-revisions` (the 2A byte pin), `completion-gates`, `partial-branches`, `authorization-ledger`, `failure-recovery` and `schema-validator-parity` and `authorization-dispatch`. TASK-VS-003/004/006/008/010 validate, and so do the real EAR-384/385 files in the main checkout.

## Review Focus

1. A gate both bound to an authorization and requiring a record is refused without `ran` even when the grant is valid, and resolves only with both. → Task 2, section T.
2. A hand-edited `pass` without `ran` blocks `done` and its 2B dependants. The refusal names it `(pass, missing ran record)`. → Task 2, section T.
3. `ref`-only and `url`-only records are both valid, and a `url` that is not `https://` is refused. → Task 1 (U) and Task 2 (R, X).
4. `require-record` changes nothing on the gate but `requires_record`. → Task 2, section C.
5. A git-synced copy of a bound, recorded task validates. Stripping both keys still validates and still blocks `done` on pending gates. → Task 3, section S.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/completion-guard.rb` | `RAN_KEYS`, `RAN_URL_PATTERN`, `ran_errors`, `missing_run_record?`, `run_record_errors`; `resolved?` record condition; `gate_record(requires_record:, ran:)` | 1 |
| `scripts/update-completion-gate.rb` | `--requires-record` switch, `require-record` action, `--ran-*`, the pass check, carry-forward, exit 3 on malformed records, ordering label | 2 |
| `validate-yaml.rb` | `validate_gate_records`, called from `validate_completion_gates` | 3 |
| `schemas/status.schema.yaml` | `requires_record` and `ran` on the gate record | 3 |
| `tests/integration/schema-validator-parity.sh` | Pins the `ran` keys, the url grammar and `requires_record` | 3 |
| `tests/integration/gate-records.sh` | New suite: sections U (T1); R, X, C, T (T2); V, S (T3) | 1–3 |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | The record, the requirement, the exit codes, the limits | 4 |

The suite is one file built in sections. **Every task inserts its block immediately before the final line** `echo "[PASS] gate-records: gate run records (#28 Phase 2C)"`. Run it with `bash tests/integration/gate-records.sh` from the worktree root; it takes well under a minute.

Patch steps are given as small Ruby scripts. Each `rep!` is one exact old → new replacement that aborts if the old text is not found. Save the script to the session scratchpad (never inside the repo) and run it from the worktree root.

---

### Task 1: Run-record helpers and the resolution rule in `CompletionGuard`

**Files:**
- Modify: `scripts/completion-guard.rb`
- Create: `tests/integration/gate-records.sh`

**Interfaces:**
- Consumes: the existing `resolved?`, `gate_record`, `unresolved_dependencies` and `GATE_NAME_PATTERN`.
- Produces (all `module_function` on `CompletionGuard`):
  - `RAN_KEYS` (`%w[by ref url]`) and `RAN_URL_PATTERN` (`%r{\Ahttps://\S+\z}`).
  - `ran_errors(ran) -> Array<String>`, with messages `ran must be a map with by and ref and/or url`, `ran has unknown field(s): …`, `ran.by must be a non-empty string`, `ran needs ref or url`, `ran.ref must be a non-empty string` and `ran.url must start with https://`.
  - `missing_run_record?(gate) -> Boolean`
  - `run_record_errors(gates) -> Array<String>`, with messages `completion_gates.<name>.requires_record must be true`, `completion_gates.<name>.<ran message>` and `completion_gates.<name>.ran is only valid on a pass`.
  - `gate_record(…, after: nil, requires_record: nil, ran: nil)`, which places `requires_record` then `ran` after `after`, and only when set.
  - `resolved?` now returns false when `missing_run_record?`.

- [ ] **Step 1: Create the suite with its header, section U and the PASS line**

Create `tests/integration/gate-records.sh` (mode 755):

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2C — gate run records.
#
# A passing gate can record what actually ran: `ran: {by, ref, url}` (`by`
# required, plus `ref` and/or an https `url`). A gate can opt in to requiring
# it with `requires_record: true` (declare --requires-record, or the
# require-record action on a pending gate; add-only). A required record
# missing on a stored pass leaves the gate unresolved: it blocks done and 2B
# dependants. Sections: U shared helpers, R replay (EAR-384/385), X writer
# refusals, C carry-forward / malformed state / fence, T teeth, V stored-state
# validation and S team sync / revert safety.

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

# --- U: shared run-record helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
meta = { "actor" => "dev-2", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" }
good = { "by" => "operator", "ref" => "05fae97f", "url" => "https://github.com/SparqLab/shared-lib/pull/88" }
check "valid ran", CompletionGuard.ran_errors(good), []
check "ref only", CompletionGuard.ran_errors({ "by" => "operator", "ref" => "abc" }), []
check "url only", CompletionGuard.ran_errors({ "by" => "operator", "url" => "https://x.example/run/1" }), []
check "not a map", CompletionGuard.ran_errors("abc"), ["ran must be a map with by and ref and/or url"]
check "no by", CompletionGuard.ran_errors({ "ref" => "abc" }), ["ran.by must be a non-empty string"]
check "neither ref nor url", CompletionGuard.ran_errors({ "by" => "op" }), ["ran needs ref or url"]
check "empty ref", CompletionGuard.ran_errors({ "by" => "op", "ref" => " " }), ["ran.ref must be a non-empty string"]
check "http url", CompletionGuard.ran_errors({ "by" => "op", "url" => "http://x" }), ["ran.url must start with https://"]
check "unknown key", CompletionGuard.ran_errors(good.merge("sha" => "x")), ["ran has unknown field(s): sha"]
required = meta.merge("status" => "pass", "requires_record" => true)
check "missing record", CompletionGuard.missing_run_record?(required), true
check "record present", CompletionGuard.missing_run_record?(required.merge("ran" => good)), false
check "malformed record", CompletionGuard.missing_run_record?(required.merge("ran" => { "by" => "op" })), true
check "na needs no record", CompletionGuard.missing_run_record?(required.merge("status" => "na")), false
check "not required", CompletionGuard.missing_run_record?(meta.merge("status" => "pass")), false
check "resolved without record", CompletionGuard.resolved?(required), false
check "resolved with record", CompletionGuard.resolved?(required.merge("ran" => good)), true
check "na resolved", CompletionGuard.resolved?(required.merge("status" => "na")), true
check "unrequired pass resolved", CompletionGuard.resolved?(meta.merge("status" => "pass")), true
check "stored errors clean", CompletionGuard.run_record_errors({ "a" => required.merge("ran" => good), "b" => { "status" => "pending", "requires_record" => true } }), []
check "requires_record not true", CompletionGuard.run_record_errors({ "a" => { "status" => "pending", "requires_record" => "yes" } }),
      ["completion_gates.a.requires_record must be true"]
check "ran on a pending gate", CompletionGuard.run_record_errors({ "a" => { "status" => "pending", "ran" => good } }),
      ["completion_gates.a.ran is only valid on a pass"]
check "malformed stored ran", CompletionGuard.run_record_errors({ "a" => meta.merge("status" => "pass", "ran" => { "by" => "op" }) }),
      ["completion_gates.a.ran needs ref or url"]
check "gate_record with record",
      CompletionGuard.gate_record(status: "pass", actor: "dev-2", reason: "r", updated_at: "T", after: ["a"], requires_record: true, ran: good).keys,
      %w[status actor reason updated_at evidence_refs after requires_record ran]
check "gate_record without record is unchanged",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T").keys,
      %w[status actor reason updated_at evidence_refs]
RUBY

echo "[PASS] gate-records: gate run records (#28 Phase 2C)"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-records.sh`
Expected: FAIL with `undefined method 'ran_errors' for CompletionGuard:Module (NoMethodError)`.

- [ ] **Step 3: Patch `CompletionGuard`**

Save as `2c-guard-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2c-guard-patch.rb scripts/completion-guard.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "  BRANCH_NAME_PATTERN = GATE_NAME_PATTERN\n",
     "  BRANCH_NAME_PATTERN = GATE_NAME_PATTERN\n" \
     "  # Phase 2C: the keys of a gate's `ran` record and the shape of its url.\n" \
     "  RAN_KEYS = %w[by ref url].freeze\n" \
     "  RAN_URL_PATTERN = %r{\\Ahttps://\\S+\\z}.freeze\n")
rep!(s, "    return false unless gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate[\"status\"].to_s)\n\n    RESOLUTION_METADATA_KEYS.all?",
     "    return false unless gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate[\"status\"].to_s)\n" \
     "    return false if missing_run_record?(gate)\n\n    RESOLUTION_METADATA_KEYS.all?")
rep!(s, "                  authorization_refs: nil, authorization_through: nil, after: nil)\n",
     "                  authorization_refs: nil, authorization_through: nil, after: nil, requires_record: nil, ran: nil)\n")
rep!(s, "    record[\"after\"] = after unless after.nil?\n    record\n",
     "    record[\"after\"] = after unless after.nil?\n    record[\"requires_record\"] = true if requires_record\n    record[\"ran\"] = ran unless ran.nil?\n    record\n")
rep!(s, "  def unresolved_dependencies(gates, gate, authorizations)\n    gate_after(gate).reject do |dep|\n      authorizations ? gate_resolved?(gates[dep], authorizations) : resolved?(gates[dep])\n    end\n  end\n",
     "  def unresolved_dependencies(gates, gate, authorizations)\n    gate_after(gate).reject do |dep|\n      authorizations ? gate_resolved?(gates[dep], authorizations) : resolved?(gates[dep])\n    end\n  end\n" + <<~'RUBY')

  # Phase 2C run records. Problems with a `ran` record ([] when well formed):
  # `by` plus `ref` and/or an https `url`, and nothing else.
  def ran_errors(ran)
    return ["ran must be a map with by and ref and/or url"] unless ran.is_a?(Hash)

    errors = []
    unknown = ran.keys - RAN_KEYS
    errors << "ran has unknown field(s): #{unknown.join(', ')}" unless unknown.empty?
    errors << "ran.by must be a non-empty string" unless ran["by"].is_a?(String) && !ran["by"].strip.empty?
    errors << "ran needs ref or url" unless ran.key?("ref") || ran.key?("url")
    if ran.key?("ref") && !(ran["ref"].is_a?(String) && !ran["ref"].strip.empty?)
      errors << "ran.ref must be a non-empty string"
    end
    if ran.key?("url") && !(ran["url"].is_a?(String) && ran["url"].match?(RAN_URL_PATTERN))
      errors << "ran.url must start with https://"
    end
    errors
  end

  # A pass of a gate that requires a record but has no well-formed `ran`.
  # resolved? treats it as unresolved, so done and 2B dependants stay blocked.
  def missing_run_record?(gate)
    gate.is_a?(Hash) && gate["requires_record"] == true && gate["status"].to_s == "pass" &&
      !ran_errors(gate["ran"]).empty?
  end

  # Malformed stored run-record state, shared by update-completion-gate.rb
  # (exit 3) and validate-yaml.rb. A missing record on a required pass is not
  # malformed: it is an unresolved gate.
  def run_record_errors(gates)
    gates.each_with_object([]) do |(name, gate), errors|
      next unless gate.is_a?(Hash)

      if gate.key?("requires_record") && gate["requires_record"] != true
        errors << "completion_gates.#{name}.requires_record must be true"
      end
      next unless gate.key?("ran")

      errors.concat(ran_errors(gate["ran"]).map { |message| "completion_gates.#{name}.#{message}" })
      errors << "completion_gates.#{name}.ran is only valid on a pass" unless gate["status"] == "pass"
    end
  end
RUBY
File.write(path, s)
```

- [ ] **Step 4: Run the suite and the suites that use `resolved?`**

Run: `bash tests/integration/gate-records.sh && bash tests/integration/gate-ordering.sh && bash tests/integration/plan-revisions.sh && bash tests/integration/completion-gates.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own PASS line.

- [ ] **Step 5: Commit**

```bash
git add scripts/completion-guard.rb tests/integration/gate-records.sh
git commit -m "feat(office): gate run-record helpers and resolution rule (#28 Phase 2C)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Run records in `update-completion-gate.rb`

**Files:**
- Modify: `scripts/update-completion-gate.rb`
- Modify: `tests/integration/gate-records.sh` (sections R, X, C, T)

**Interfaces:**
- Consumes: the Task 1 helpers; the existing 2B ordered-pass block; `CompletionGuard.event_agent`, `gate_history_row` and `append_meta_event!`.
- Produces: the CLI.
  - `declare … --requires-record`. This is a switch with no value.
  - `require-record <GATE> --actor A --reason R`.
    - stdout: `gate <GATE>: requires_record`
    - history row: `gate <GATE>: requires_record`
    - meta event: `completion_gate_updated`, with details `gate=<GATE> requires_record actor=<A>`
  - `pass … --ran-by B [--ran-ref R] [--ran-url https://…]`.
  - Refusal for a pass without a required record: `gate '<GATE>' requires a ran record: pass it with --ran-by and --ran-ref/--ran-url`.
  - Ordering label: `<dep> (pass, missing ran record)`.

- [ ] **Step 1: Write sections R, X, C, T (failing)**

Insert before the PASS line:

````bash
SHA=05fae97f5ea5d38c7aded6f2eccbb627c0e72c2f
PR_URL=https://github.com/SparqLab/shared-lib/pull/88

# --- R: replay shapes ---
# EAR-384: the requirement is added to an existing pending gate, then the pass must carry the record.
D="$(task TASK-990)"
gate TASK-990 declare shared_lib_publication --actor pm --reason "publish shared-lib" >/dev/null
out="$(gate TASK-990 require-record shared_lib_publication --actor pm --reason "publication must cite the merge")"
assert_eq "$out" "gate shared_lib_publication: requires_record" "R require-record output"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.requires_record)" "true" "R requirement stored"
assert_eq "$(field "$D/status.yaml" history.1.phase)" "gate shared_lib_publication: requires_record" "R require-record history row"
grep -q "gate=shared_lib_publication requires_record actor=pm" "$D/meta.yaml" || fail "R require-record meta event"
expect_refusal 2 "R pass without the required record" TASK-990 pass shared_lib_publication --actor dev-2 --reason merged
grep -q "requires a ran record" "$RUNS/refusal.log" || fail "R refusal wording: $(cat "$RUNS/refusal.log")"
gate TASK-990 pass shared_lib_publication --actor dev-2 --reason "merged to main" --ran-by operator --ran-ref "$SHA" --ran-url "$PR_URL" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.by)" "operator" "R ran.by"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.ref)" "$SHA" "R ran.ref"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.url)" "$PR_URL" "R ran.url"
validate "$D/status.yaml" || fail "R EAR-384 invalid: $(cat "$RUNS/validate.log")"
force_done TASK-990 || fail "R done refused after the recorded pass: $(cat "$RUNS/force.log")"

# EAR-385: declared with the requirement; the operator performs, dev-2 records.
D="$(task TASK-991)"
gate TASK-991 declare authenticated_staging --actor pm --reason "staging smoke" --requires-record >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.requires_record)" "true" "R declare --requires-record"
gate TASK-991 pass authenticated_staging --actor dev-2 --reason "smoke passed" --ran-by operator --ran-url https://staging.example/run/42 >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.actor)" "dev-2" "R actor kept"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.ran.by)" "operator" "R by distinct from actor"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.ran.ref)" "" "R ref optional when url given"

# --- X: writer refusals write nothing ---
D="$(task TASK-992)"
gate TASK-992 declare a --actor pm --reason a >/dev/null
gate TASK-992 declare r --actor pm --reason r --requires-record >/dev/null
gate TASK-992 declare p --actor pm --reason p >/dev/null
gate TASK-992 pass p --actor reviewer --reason done >/dev/null
gate TASK-992 declare n --actor pm --reason n >/dev/null
gate TASK-992 na n --actor reviewer --reason "not needed" >/dev/null
expect_refusal 2 "X --ran-* on declare" TASK-992 declare e --actor pm --reason e --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on na" TASK-992 na a --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on depend" TASK-992 depend a --after p --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on require-record" TASK-992 require-record a --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-ref without --ran-by" TASK-992 pass a --actor pm --reason r --ran-ref x
expect_refusal 2 "X --ran-by without ref or url" TASK-992 pass a --actor pm --reason r --ran-by op
expect_refusal 2 "X empty --ran-ref" TASK-992 pass a --actor pm --reason r --ran-by op --ran-ref ""
expect_refusal 2 "X non-https --ran-url" TASK-992 pass a --actor pm --reason r --ran-by op --ran-url http://x
expect_refusal 2 "X repeated --ran-by" TASK-992 pass a --actor pm --reason r --ran-by op --ran-by other --ran-ref x
expect_refusal 2 "X --requires-record on pass" TASK-992 pass a --actor pm --reason r --requires-record
expect_refusal 2 "X repeated --requires-record" TASK-992 declare e --actor pm --reason e --requires-record --requires-record
expect_refusal 2 "X require-record on a passed gate" TASK-992 require-record p --actor pm --reason r
expect_refusal 2 "X require-record on an na gate" TASK-992 require-record n --actor pm --reason r
expect_refusal 2 "X require-record on an undeclared gate" TASK-992 require-record zz --actor pm --reason r
expect_refusal 2 "X require-record twice" TASK-992 require-record r --actor pm --reason r
expect_refusal 2 "X require-record without --reason" TASK-992 require-record a --actor pm
expect_refusal 2 "X pass a required gate without a record" TASK-992 pass r --actor pm --reason r
D="$(task TASK-993 done)"
expect_refusal 2 "X finished task" TASK-993 require-record a --actor pm --reason r

# --- C: carry-forward, optional record, malformed stored state, fence ---
D="$(task TASK-994)"
gate TASK-994 declare a --actor pm --reason a >/dev/null
gate TASK-994 declare b --actor pm --reason b --requires-record >/dev/null
gate TASK-994 depend b --after a --actor pm --reason "b after a" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives depend"
gate TASK-994 declare c --actor pm --reason c --after a >/dev/null
gate TASK-994 require-record c --actor pm --reason "c needs a record" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a" "C after survives require-record"
record_without() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); g = s["completion_gates"][ARGV[1]].dup; g.delete(ARGV[2]); print YAML.dump(g)' "$1" "$2" "$3"; }
gate TASK-994 declare d --actor pm --reason "d first" >/dev/null
before="$(record_without "$D/status.yaml" d requires_record)"
gate TASK-994 require-record d --actor reviewer --reason "added later" >/dev/null
assert_eq "$(record_without "$D/status.yaml" d requires_record)" "$before" "C require-record changes nothing but requires_record"
gate TASK-994 pass a --actor reviewer --reason ok --ran-by operator --ran-ref abc123 >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.a.ran.ref)" "abc123" "C optional record stored on an unrequired gate"
gate TASK-994 pass b --actor reviewer --reason ok --ran-by operator --ran-ref first >/dev/null
gate TASK-994 pass b --actor reviewer --reason again --ran-by operator --ran-ref second >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.ran.ref)" "second" "C a new pass replaces ran"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives pass"
gate TASK-994 na b --actor reviewer --reason "not needed after all" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.ran)" "" "C na drops ran"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives na"
D="$(task TASK-995)"
gate TASK-995 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "requires_record" => "yes"}'
expect_refusal 3 "C stored requires_record not true" TASK-995 pass a --actor pm --reason r
D="$(task TASK-996)"
gate TASK-996 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "ran" => {"by" => "op", "ref" => "x"}}'
expect_refusal 3 "C stored ran on a pending gate" TASK-996 pass a --actor pm --reason r
D="$(task TASK-997)"
gate TASK-997 declare a --actor pm --reason a >/dev/null
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-997 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$GATE" TASK-997 require-record a --actor pm --reason r >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced require-record wrote status.yaml"

# --- T: a required record missing on a stored pass has teeth ---
D="$(task TASK-998 review)"
gate TASK-998 declare deploy --actor pm --reason d --requires-record >/dev/null
gate TASK-998 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" deploy '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "requires_record" => true}'
expect_refusal 2 "T dependant of a pass without its record" TASK-998 pass smoke --actor reviewer --reason r
grep -q "waits on: deploy (pass, missing ran record)" "$RUNS/refusal.log" || fail "T ordering label: $(cat "$RUNS/refusal.log")"
gate TASK-998 na smoke --actor reviewer --reason "not needed" >/dev/null
if force_done TASK-998; then fail "T done allowed with a required record missing"; fi
grep -q "deploy" "$RUNS/force.log" || fail "T done refusal does not name the gate"
# Bound and requiring a record: resolved only with both a valid grant and a ran record.
D="$(task TASK-999 review)"
gate TASK-999 declare deploy --actor pm --reason d --requires-authorization deploy_staging --requires-record >/dev/null
ruby "$AUTHZ" TASK-999 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
expect_refusal 2 "T bound gate without its record" TASK-999 pass deploy --actor devops --reason deployed --authorization authz-001
gate TASK-999 pass deploy --actor devops --reason deployed --authorization authz-001 --ran-by devops --ran-url https://github.com/x/y/actions/runs/1 >/dev/null
force_done TASK-999 || fail "T bound + record pass did not resolve: $(cat "$RUNS/force.log")"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-records.sh`
Expected: FAIL. The first `require-record` hits `unknown action 'require-record' (expected declare, pass, na or depend)` plus the usage line (exit 2), and `set -e` stops the suite.

- [ ] **Step 3: Patch the writer**

Save as `2c-writer-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2c-writer-patch.rb scripts/update-completion-gate.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "# them. `after` is carried forward on every transition, like the binding.\n#\n# Usage:\n",
     "# them. `after` is carried forward on every transition, like the binding.\n#\n" \
     "# Phase 2C: a pass may record what actually ran (`--ran-by` plus `--ran-ref`\n" \
     "# and/or an https `--ran-url`). A gate may require that record\n" \
     "# (`--requires-record` on declare, or the `require-record` action on a\n" \
     "# pending gate; add-only, carried forward). `ran` is written only by pass.\n#\n# Usage:\n")
rep!(s, "#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>] [--after G1,G2]\n" \
        "#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002] [--authorization authz-001,authz-002]\n",
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>] [--after G1,G2] [--requires-record]\n" \
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002] [--authorization authz-001,authz-002] [--ran-by B --ran-ref R --ran-url https://...]\n")
rep!(s, "#   ruby scripts/update-completion-gate.rb <TASK_ID> depend  <GATE> --after G1,G2 --actor <A> --reason <R>\n",
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> depend  <GATE> --after G1,G2 --actor <A> --reason <R>\n" \
     "#   ruby scripts/update-completion-gate.rb <TASK_ID> require-record <GATE> --actor <A> --reason <R>\n")
rep!(s, "# stored ordering, unknown evidence id;", "# stored ordering or run record, unknown evidence id;")
rep!(s, 'TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na", "depend" => "pending" }.freeze',
     'TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na", "depend" => "pending", "require-record" => "pending" }.freeze')
rep!(s, 'warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na|depend> <GATE> --actor <A> [--reason <R>] " \\' + "\n" +
        '       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002] " \\' + "\n" +
        '       "[--after G1,G2]"',
     'warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na|depend|require-record> <GATE> --actor <A> [--reason <R>] " \\' + "\n" +
     '       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002] " \\' + "\n" +
     '       "[--after G1,G2] [--requires-record] [--ran-by B --ran-ref R --ran-url https://...]"')
rep!(s, %q{usage!("unknown action '#{action}' (expected declare, pass, na or depend)")},
     %q{usage!("unknown action '#{action}' (expected declare, pass, na, depend or require-record)")})
rep!(s, "until args.empty?\n  flag = args.shift\n  value = args.shift\n",
     "until args.empty?\n  flag = args.shift\n" \
     "  # The one switch: it takes no value.\n" \
     "  if flag == \"--requires-record\"\n" \
     "    usage!(\"duplicate --requires-record\") if opts.key?(:requires_record)\n" \
     "    opts[:requires_record] = true\n" \
     "    next\n" \
     "  end\n" \
     "  value = args.shift\n")
rep!(s, %Q{  when "--after" then (opts[:after] ||= []).concat(value.split(",", -1).map(&:strip))\n},
     %Q{  when "--after" then (opts[:after] ||= []).concat(value.split(",", -1).map(&:strip))\n} + <<~'RUBY')
  when "--ran-by", "--ran-ref", "--ran-url"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    usage!("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
RUBY
rep!(s, %q{usage!("--reason is required for #{action}") if %w[pass na depend].include?(action) && opts[:reason].to_s.empty?},
     %q{usage!("--reason is required for #{action}") if %w[pass na depend require-record].include?(action) && opts[:reason].to_s.empty?})
rep!(s, %Q{usage!("gate '\#{gate_name}' cannot wait on itself") if new_after.include?(gate_name)\n},
     %Q{usage!("gate '\#{gate_name}' cannot wait on itself") if new_after.include?(gate_name)\n} + <<~'RUBY')
usage!("--requires-record is only valid with declare") if opts.key?(:requires_record) && action != "declare"
ran_flags = %i[ran_by ran_ref ran_url].select { |key| opts.key?(key) }
usage!("--ran-by/--ran-ref/--ran-url are only valid with pass") if !ran_flags.empty? && action != "pass"
run_record = nil
unless ran_flags.empty?
  run_record = {}
  run_record["by"] = opts[:ran_by] if opts.key?(:ran_by)
  run_record["ref"] = opts[:ran_ref] if opts.key?(:ran_ref)
  run_record["url"] = opts[:ran_url] if opts.key?(:ran_url)
  record_problems = CompletionGuard.ran_errors(run_record)
  usage!("invalid run record: #{record_problems.join('; ')}") unless record_problems.empty?
end
RUBY
rep!(s, "ordering_problems = CompletionGuard.ordering_errors(gates)\n",
     "ordering_problems = CompletionGuard.ordering_errors(gates) + CompletionGuard.run_record_errors(gates)\n")
rep!(s, %Q{if action == "depend" && existing["status"] != "pending"\n  usage!("gate '\#{gate_name}' is \#{existing['status']}; an ordering can only be added to a pending gate")\nend\n},
     %Q{if action == "depend" && existing["status"] != "pending"\n  usage!("gate '\#{gate_name}' is \#{existing['status']}; an ordering can only be added to a pending gate")\nend\n} + <<~'RUBY')
if action == "require-record"
  if existing["status"] != "pending"
    usage!("gate '#{gate_name}' is #{existing['status']}; a record requirement can only be added to a pending gate")
  end
  usage!("gate '#{gate_name}' already requires a ran record") if existing["requires_record"] == true
end
if action == "pass" && existing["requires_record"] == true && run_record.nil?
  usage!("gate '#{gate_name}' requires a ran record: pass it with --ran-by and --ran-ref/--ran-url")
end
RUBY
rep!(s, %Q{      CompletionGuard.resolved?(gates[dep]) ? "\#{dep} (\#{state}, authorization not satisfied)" : "\#{dep} (\#{state})"\n},
     <<~'RUBY')
      if CompletionGuard.missing_run_record?(gates[dep]) then "#{dep} (#{state}, missing ran record)"
      elsif CompletionGuard.resolved?(gates[dep]) then "#{dep} (#{state}, authorization not satisfied)"
      else "#{dep} (#{state})"
      end
RUBY
rep!(s, %Q{  summary = "gate \#{gate_name}: after += \#{new_after.join(',')}"\nelse\n},
     %Q{  summary = "gate \#{gate_name}: after += \#{new_after.join(',')}"\n} + <<~'RUBY' + "else\n")
elsif action == "require-record"
  # require-record changes only `requires_record`; everything else stays.
  gates[gate_name] = existing.merge("requires_record" => true)
  history_row = {
    "phase" => "gate #{gate_name}: requires_record",
    "agent" => CompletionGuard.event_agent(opts[:actor]),
    "reason" => opts[:reason],
    "at" => now
  }
  event_details = "gate=#{gate_name} requires_record actor=#{opts[:actor]}"
  summary = "gate #{gate_name}: requires_record"
RUBY
rep!(s, "    after: carried_after\n  )\n",
     "    after: carried_after,\n" \
     "    requires_record: action == \"declare\" ? opts[:requires_record] : existing[\"requires_record\"] == true,\n" \
     "    ran: action == \"pass\" ? run_record : nil\n  )\n")
File.write(path, s)
```

Then run `ruby -c scripts/update-completion-gate.rb` (expect `Syntax OK`) and read the diff once.

- [ ] **Step 4: Run the suite and the existing writer suites**

Run: `bash tests/integration/gate-records.sh`
Expected: `[PASS] gate-records: gate run records (#28 Phase 2C)`

Run: `bash tests/integration/gate-ordering.sh && bash tests/integration/plan-revisions.sh && bash tests/integration/completion-gates.sh && bash tests/integration/partial-branches.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own PASS line.

- [ ] **Step 5: Prove four behaviours bite**

Apply each change below, run the suite, confirm the expected failure, then restore the original:

1. Change `if action == "pass" && existing["requires_record"] == true && run_record.nil?` to `if false` → expect `[FAIL] R pass without the required record exit`.
2. Change `requires_record: action == "declare" ? opts[:requires_record] : existing["requires_record"] == true,` to `requires_record: action == "declare" ? opts[:requires_record] : nil,` → expect `[FAIL] C requires_record survives pass`.
3. In `scripts/completion-guard.rb`, change `    return false if missing_run_record?(gate)` to `    nil` → expect `[FAIL] U resolved without record`.
4. Change `    ran: action == "pass" ? run_record : nil` to `    ran: run_record || existing.to_h["ran"]` → expect `[FAIL] C na drops ran`.

- [ ] **Step 6: Commit**

```bash
git add scripts/update-completion-gate.rb tests/integration/gate-records.sh
git commit -m "feat(office): gate run records and require-record (#28 Phase 2C)

A pass can record what actually ran (--ran-by plus --ran-ref/--ran-url); a
gate can require it (--requires-record at declare, or require-record while
pending; add-only, carried forward). ran is written only by pass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Validator, schema and parity

**Files:**
- Modify: `validate-yaml.rb`. `validate_completion_gates` calls a new `validate_gate_records`, defined directly before `validate_branches`.
- Modify: `schemas/status.schema.yaml`. Add `requires_record` and `ran` on the gate record, directly after the `after` property.
- Modify: `tests/integration/schema-validator-parity.sh`. Add the checks directly before `failed = false`.
- Modify: `tests/integration/gate-records.sh` (sections V, S).

**Interfaces:**
- Consumes: `CompletionGuard.run_record_errors`, `missing_run_record?`, `RAN_KEYS` and `RAN_URL_PATTERN`.
- Produces: the validator messages `<label>.<run_record_errors message>` and `<label>.completion_gates.<name>: requires_record but ran is missing or malformed`.

- [ ] **Step 1: Write sections V and S (failing)**

Insert before the PASS line:

````bash
# --- V: stored-state validation ---
# expect_invalid <status.yaml> <message fragment> <label>
expect_invalid() {
  if validate "$1"; then fail "V $3 validated"; fi
  grep -qF "$2" "$RUNS/validate.log" || fail "V $3 message: $(cat "$RUNS/validate.log")"
}
D="$(task TASK-1000)"
gate TASK-1000 declare a --actor pm --reason a --requires-record >/dev/null
gate TASK-1000 declare b --actor pm --reason b >/dev/null
validate "$D/status.yaml" || fail "V a pending requires_record gate was rejected: $(cat "$RUNS/validate.log")"
v_case() { # <label> <gate> <ruby hash> <fragment>
  local dir="$RUNS/v-$1"; mkdir -p "$dir"; cp "$D/status.yaml" "$dir/status.yaml"
  set_gate "$dir/status.yaml" "$2" "$3"
  expect_invalid "$dir/status.yaml" "$4" "$1"
}
PASSED='"status" => "pass", "actor" => "x", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []'
v_case not-true b '{"status" => "pending", "requires_record" => false}' "completion_gates.b.requires_record must be true"
v_case ran-on-pending b '{"status" => "pending", "ran" => {"by" => "op", "ref" => "x"}}' "completion_gates.b.ran is only valid on a pass"
v_case ran-no-by b "{$PASSED, \"ran\" => {\"ref\" => \"x\"}}" "completion_gates.b.ran.by must be a non-empty string"
v_case ran-no-ref-or-url b "{$PASSED, \"ran\" => {\"by\" => \"op\"}}" "completion_gates.b.ran needs ref or url"
v_case ran-http b "{$PASSED, \"ran\" => {\"by\" => \"op\", \"url\" => \"http://x\"}}" "completion_gates.b.ran.url must start with https://"
v_case ran-extra b "{$PASSED, \"ran\" => {\"by\" => \"op\", \"ref\" => \"x\", \"sha\" => \"y\"}}" "completion_gates.b.ran has unknown field(s): sha"
v_case missing-record a "{$PASSED, \"requires_record\" => true}" "completion_gates.a: requires_record but ran is missing or malformed"
mkdir -p "$RUNS/v-ok"; cp "$D/status.yaml" "$RUNS/v-ok/status.yaml"
set_gate "$RUNS/v-ok/status.yaml" a "{$PASSED, \"requires_record\" => true, \"ran\" => {\"by\" => \"operator\", \"ref\" => \"abc\"}}"
set_gate "$RUNS/v-ok/status.yaml" b "{$PASSED, \"ran\" => {\"by\" => \"operator\", \"url\" => \"https://x.example/1\"}}"
validate "$RUNS/v-ok/status.yaml" || fail "V recorded passes rejected: $(cat "$RUNS/validate.log")"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-999"
cp "$RUNS/TASK-999/status.yaml" "$RUNS/TASK-999/task.md" "$RUNS/TASK-999/authorization.yaml" "$RUNS/sync/TASK-999/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-999/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy with a bound, recorded gate does not validate: $(cat "$RUNS/validate.log")"
# As after a revert: stripping both keys leaves a valid task and the done rule unchanged.
D="$(task TASK-1001 review)"
gate TASK-1001 declare a --actor pm --reason a --requires-record >/dev/null
gate TASK-1001 declare b --actor pm --reason b >/dev/null
gate TASK-1001 pass a --actor pm --reason ok --ran-by operator --ran-ref abc >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].each_value { |g| g.delete("requires_record"); g.delete("ran") }; File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without the record keys invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-1001; then fail "S after stripping the keys, a pending gate no longer blocks done"; fi
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-records.sh`
Expected: FAIL with `[FAIL] V not-true validated`.

- [ ] **Step 3: Patch the validator**

Save as `2c-validator-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2c-validator-patch.rb validate-yaml.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "      validate_gate_ordering(gates, label, errors, task_dir)\n",
     "      validate_gate_ordering(gates, label, errors, task_dir)\n      validate_gate_records(gates, label, errors)\n")
rep!(s, "def validate_branches(data, label, errors)\n", <<~'RUBY' + "def validate_branches(data, label, errors)\n")
  # Phase 2C (issue #28): run records are well formed (`requires_record` is
  # true, `ran` has the right shape and sits only on a pass), and a pass that
  # requires a record carries one. The missing record also leaves the gate
  # unresolved (CompletionGuard.resolved?), which the done and ordering checks
  # report in their own terms.
  def validate_gate_records(gates, label, errors)
    CompletionGuard.run_record_errors(gates).each { |message| errors << "#{label}.#{message}" }
    gates.each do |name, gate|
      next unless CompletionGuard.missing_run_record?(gate)

      errors << "#{label}.completion_gates.#{name}: requires_record but ran is missing or malformed"
    end
  end

RUBY
File.write(path, s)
```

- [ ] **Step 4: Run the suite**

Run: `bash tests/integration/gate-records.sh`
Expected: `[PASS] gate-records: gate run records (#28 Phase 2C)`

- [ ] **Step 5: Add the parity checks (failing)**

In `tests/integration/schema-validator-parity.sh`, insert directly before the line `failed = false`:

```ruby
# --- gate run records (issue #28 Phase 2C) --------------------------------------
gate_props = YAML.load_file("schemas/status.schema.yaml")["properties"]["completion_gates"]["additionalProperties"]["properties"]
checks << ["status.completion_gates.ran keys", CompletionGuard::RAN_KEYS.sort, gate_props.fetch("ran")["properties"].keys.sort]
url_samples = ["https://github.com/x/y/pull/1", "http://x", "https://", "https://a b", "ftp://x", ""]
checks << ["status.completion_gates.ran.url grammar", url_samples.map { |s| CompletionGuard::RAN_URL_PATTERN.match?(s) },
           url_samples.map { |s| Regexp.new(gate_props.fetch("ran")["properties"]["url"]["pattern"]).match?(s) }]
checks << ["status.completion_gates.requires_record", [true], [gate_props.fetch("requires_record")["const"]]]
# --- end gate run records block -------------------------------------------------

```

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: FAIL with `` -:244:in `fetch': key not found: "ran" (KeyError) `` (the line number may differ).

- [ ] **Step 6: Add the keys to the schema**

In `schemas/status.schema.yaml`, insert directly after the two lines that end the `after` property's description:

```
            Existence, self-reference, cycles and the ordering invariant are
            validator-only.
```

with:

```yaml
        requires_record:
          const: true
          description: >
            Phase 2C (issue #28): this gate cannot pass without a `ran` record.
            Set with `declare --requires-record` or added while pending with
            `require-record`; add-only and carried forward on every transition.
            A pass without a well-formed `ran` is unresolved.
        ran:
          type: object
          additionalProperties: false
          required:
            - by
          anyOf:
            - required:
                - ref
            - required:
                - url
          properties:
            by:
              type: string
              minLength: 1
            ref:
              type: string
              minLength: 1
            url:
              type: string
              pattern: "^https://\\S+$"
          description: >
            Phase 2C (issue #28): what actually ran when the gate passed, as a
            structured, unverified claim. Present only on a pass; written by
            `update-completion-gate.rb pass --ran-by/--ran-ref/--ran-url`.
```

- [ ] **Step 7: Run parity and the suite**

Run: `bash tests/integration/schema-validator-parity.sh`
Expected: these three lines, then `[PASS] schema-validator-parity: …`:

```
  ok: status.completion_gates.ran keys (3 values agree)
  ok: status.completion_gates.ran.url grammar (6 values agree)
  ok: status.completion_gates.requires_record (1 values agree)
```

Run: `bash tests/integration/gate-records.sh`
Expected: `[PASS] gate-records: …`

- [ ] **Step 8: Prove the validator rule bites**

Change `    next unless CompletionGuard.missing_run_record?(gate)` in `validate_gate_records` to `    next` → expect `[FAIL] V missing-record validated`. Then restore the original.

- [ ] **Step 9: Commit**

```bash
git add validate-yaml.rb schemas/status.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/gate-records.sh
git commit -m "feat(office): validate gate run records in stored state (#28 Phase 2C)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs and full regression

**Files:**
- Modify: `docs/completion-gates.md`. Add a new section directly before `## Compatibility`, and extend the exit-code sentence.
- Modify: `docs/task-transition-contract.md`. Extend the `completion_gates` bullet.

**Interfaces:**
- Consumes: the CLI and the record from Tasks 2–3.
- Produces: documentation only.

- [ ] **Step 1: Add the section to `docs/completion-gates.md`**

Insert directly before the line `## Compatibility`:

````markdown
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

````

- [ ] **Step 2: Extend the exit-code sentence in `docs/completion-gates.md`**

Replace

```
`evidence.yaml`, or an unreadable authorization ledger (Phase 1B.1); `9` ownership fence refused.
```

with

```
`evidence.yaml`, an unreadable authorization ledger (Phase 1B.1), a malformed
stored ordering (Phase 2B) or run record (Phase 2C); `9` ownership fence refused.
```

- [ ] **Step 3: Extend the transition-contract bullet**

In `docs/task-transition-contract.md`, directly after the line

```
  [`docs/completion-gates.md`](completion-gates.md#gate-ordering-phase-2b).
```

insert

```
  A gate may also require a record of what actually ran (`requires_record`,
  `ran`, Phase 2C); a required record missing on a stored pass leaves the gate
  unresolved. See [`docs/completion-gates.md`](completion-gates.md#gate-run-records-phase-2c).
```

- [ ] **Step 4: Full regression**

Run from the worktree root:

```bash
for t in gate-records gate-ordering plan-revisions completion-gates partial-branches authorization-ledger failure-recovery schema-validator-parity; do bash "tests/integration/$t.sh" > "<scratchpad>/2c-$t.log" 2>&1 && echo "ok $t" || echo "FAIL $t"; done
```

Expected: eight `ok` lines. Then run `bash tests/integration/authorization-dispatch.sh` in the background (about 6 minutes) and confirm its final `[PASS]` line. Any failure in a pre-existing suite is a regression: fix the code, never the test.

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do ruby validate-yaml.rb "$t" >/dev/null && echo "ok $t" || echo "FAIL $t"; done
```

Expected: five `ok` lines. Optionally, validate the real `runs/TASK-EAR-384/status.yaml` and `runs/TASK-EAR-385/status.yaml` from the main checkout by path with this branch's validator. They are untracked there, so they are absent from the worktree.

- [ ] **Step 5: Commit**

```bash
git add docs/completion-gates.md docs/task-transition-contract.md
git commit -m "docs(office): gate run records (#28 Phase 2C)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Where |
|---|---|
| Design 1: `ran` shape, `requires_record` exactly true, add-only, carried forward, `ran` only on pass | T1 `ran_errors` / `run_record_errors`; T2 parse, pass check and carry-forward; tests U, X, C |
| Design 2: `resolved?` gains the record condition, reaching `done` and 2B ordering | T1 `resolved?`; tests U, T |
| Design 3: `--requires-record`, `require-record`, `--ran-*`, the pass refusal, `ran` replaced on pass and dropped on na, the ordering label | T2; tests R, X, C, T |
| Design 3: refusals (exit 2), malformed stored records (exit 3), fence (exit 9) | T2; tests X, C |
| Design 4: bound + record resolves only with both | test T (TASK-999) |
| Design 5: validator rules, schema, parity | T3; tests V, parity |
| Tests: EAR-384/385 replay, team-synced copy, revert safety, regression | T2 R; T3 S; T4 Step 4 (plus decision 6) |
| PR #43 review: `requires_record` survives `depend`; `after` survives `require-record` | test C (decision 4) |
| Docs | T4 |
