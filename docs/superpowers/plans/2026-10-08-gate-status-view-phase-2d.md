# Phase 2D Gate Status View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make completion gates visible on the status surfaces. A read-only `CompletionGuard.gate_view` derives each gate's state from the enforcing rules, and `run-agent.sh status` and `scripts/adapter-status.rb` render it with a plan-revision summary.

**Architecture:**
- **Task 1:** `CompletionGuard` gets `gate_view` (plus `gate_view_entry` and `revision_summary`) and a shared `dependency_label`. The ordered-pass refusal in `update-completion-gate.rb` switches to `dependency_label`, so its wording is shared and stays byte-identical.
- **Task 2:** the `status` renderer in `run-agent.sh` prints the `Gates:` / `Revisions:` block and the all-tasks `gates=` part.
- **Task 3:** `adapter-status.rb` adds three optional keys.
- **Task 4:** docs.

Nothing writes. `next_command` and `Next:` are untouched.

**Tech Stack:** Ruby 2.6.10 stdlib, bash (`run-agent.sh` embeds the renderer as a `ruby -` heredoc), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md`](../specs/2026-10-08-gate-status-view-phase-2d-design.md) (PR #45). Read it before any task; this plan argues from it.

**Base:** `main` at be3f2ad2 (1A–1D, 2A–2C merged). Nothing else needs to merge first.

## Global Constraints

- Ruby is 2.6.10: no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- Never put backticks inside double-quoted bash strings in tests (they execute).
- **Read-only:**
  - `gate_view`, the renderer and the adapter never write.
  - `status.yaml`, `authorization.yaml` and `meta.yaml` stay byte-identical across a query.
  - `gate_view` never raises for state problems.
- **"Resolved"** is `gate_resolved?(gate, index)` when an authorization index is loaded, and otherwise `resolved?(gate)`. **`passable`** is a pending gate with no unresolved `after` and, if bound, a grant valid now (`any_valid_grant?`). A required record never makes a gate unpassable.
- **The wait label wording** is exactly the 2B/2C refusal wording, from the one helper `dependency_label`:
  - `name (status)`
  - `name (pass, missing ran record)`
  - `name (pass, authorization not satisfied)`
- **Unchanged output:** tasks without `completion_gates` or `revisions` produce byte-identical `status` output, all-tasks line and adapter JSON. `next_command` and `Next:` never change.
- **ASCII source:** `run-agent.sh` runs its renderer through `ruby -`, which reads source as US-ASCII when `LANG` is unset. Code added there writes the em dash as `"—"`, never as a literal.
- **Patch heredocs:** patch scripts use plain `<<'RUBY'` heredocs, never `<<~`, so inserted code keeps its indentation (the 2C plan defect).
- Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2d-impl` (branch `feat/issue-28-2d-gate-status-view`). Use absolute paths. Never touch the main checkout, which another session owns.

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **When each line prints.** The `Gates:` block prints when the task has `completion_gates`. The `Revisions:` line prints when the task has `completion_gates` or `revisions`. The spec groups the two under "when the task has completion_gates or revisions"; this split avoids an empty `Gates: 0/0` block on a revisions-only task. An explicitly empty `completion_gates: {}` still prints `Gates: 0/0 resolved` and `gates=ready:0`.
2. **The em dash is escaped** as `"—"` in the `run-agent.sh` heredoc. The output text is identical, and the diff to `run-agent.sh` is ASCII-only.
3. **Agreement tests clone tasks.** A clone also rewrites `authorization.yaml`'s `task_id`, because 1B.1 rejects a ledger copied from another task.
4. **The clock is pinned.** Grants are recorded at `T0` via `AI_OFFICE_NOW`. The view is evaluated with `now:` at `NOW`, and the writer and adapter calls run with `AI_OFFICE_NOW=$NOW`. Expiry cases are therefore deterministic.
5. **Which adapter condition the mutation targets.** The outer `if status.key?("completion_gates") || status.key?("revisions")` only avoids computing the view; changing it to `if true` is an equivalent mutant. The inner key guards are what keep gateless JSON unchanged, so the mutation in Task 3 targets those.
6. **`Validation: fail` in the gateless golden is pre-existing.** `validate-yaml.rb <TASK_ID>` resolves against the live `runs/`, not `AI_OFFICE_RUNS_DIR`. The golden was captured from the unmodified renderer.
7. **Piped `grep -q` is avoided** under `set -o pipefail`. An early-exiting `grep -q` can SIGPIPE the producer and fail the pipeline, so checks read from a file or a here-string.
8. **Unreadable summary.** When the view is unreadable, `summary` is all zeros and `revisions` is still computed. This is the spec's "where they can be".
9. **Proof.** On 2026-10-08 every code block here was applied, task by task, to a scratch worktree at main be3f2ad2. Each "verify it fails" step failed as written, and each "passes" step passed.
   - **Mutations:** six were each caught.
     - passable ignoring `waits_on`;
     - grant ignoring validity;
     - the shared label losing `missing ran record` (caught by `gate-records.sh`'s refusal test);
     - the renderer dropping the record hint;
     - the adapter's inner key guard set to `if true`;
     - the outer guard was confirmed to be an equivalent mutant.
   - **Suites passed:** `gate-status` (new), `gate-records`, `gate-ordering`, `plan-revisions`, `completion-gates`, `partial-branches`, `authorization-ledger`, `failure-recovery`, `schema-validator-parity`, `adapter-status` and `authorization-dispatch`.
   - **Real runs:** TASK-VS-003/004/006/008/010 validate. The real TASK-EAR-384/385 files validate, and `status TASK-EAR-384` renders their gates:

```
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass
  implementation_verification: pending — can pass now
  authenticated_staging: pending — can pass now
Revisions: none
```

## Review Focus

1. A stored gate status that is unexpected (for example `blocked`) never raises, is never passable, and renders as `name: blocked`. → Task 1 (U, RF) and Task 2 (C, RF).
2. `gate_view` without a task directory gives a bound gate `grant: unknown`, not a crash. → Task 1 (RF).
3. A `revisions` list whose last entry is not a map counts, renders as `Revisions: N`, and has `latest: null`. → Task 1 (RF) and Task 2 (RF).
4. An explicitly empty `completion_gates: {}` renders `gates=ready:0` in the all-tasks view. → Task 2 (RF).
5. Neither the single-task nor the all-tasks `status` changes `status.yaml`. → Task 2 (RF).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/completion-guard.rb` | `dependency_label`, `gate_view`, `gate_view_entry`, `revision_summary` | 1 |
| `scripts/update-completion-gate.rb` | the ordered-pass refusal uses `dependency_label` (same bytes) | 1 |
| `run-agent.sh` | the `status` renderer: `gate_status_lines`, `gate_status_suffix`, `gate_status_part` | 2 |
| `scripts/adapter-status.rb` | `completion_gates`, `gates_summary` and `revisions` (plus `gates_readable` / `gates_problem` when unreadable) | 3 |
| `tests/integration/gate-status.sh` | new suite: sections U and A (T1), C and L (T2), J (T3) | 1–3 |
| `docs/runtime-adapter-contract.md`, `docs/completion-gates.md` | the keys and the `status` lines | 4 |

The suite is one file built in sections. **Every task inserts its block immediately before the final line** `echo "[PASS] gate-status: gate status view (#28 Phase 2D)"`. Run it with `bash tests/integration/gate-status.sh` from the worktree root.

Patch steps are small Ruby scripts. Each `rep!` / `sub!` is one exact old → new replacement that aborts if the old text is missing. Save each to the session scratchpad (never inside the repo) and run it from the worktree root. Insert test blocks and docs with a UTF-8 Ruby script (`# encoding: utf-8`), not a `ruby -e` one-liner: the blocks contain an em dash, and a one-liner reads its source as US-ASCII.

---

### Task 1: `gate_view` and the shared wait label

**Files:**
- Modify: `scripts/completion-guard.rb` (new methods directly after `run_record_errors`)
- Modify: `scripts/update-completion-gate.rb` (the ordered-pass `labels` block)
- Create: `tests/integration/gate-status.sh`

**Interfaces:**
- Consumes: `resolved?`, `gate_resolved?`, `unresolved_dependencies`, `missing_run_record?`, `ordering_errors`, `run_record_errors`; `AuthorizationLedger.load`, `now_utc`, `Index#any_valid_grant?`, `Index#high_water_id`.
- Produces (all `module_function` on `CompletionGuard`):
  - `dependency_label(gates, dep) -> String`
  - `gate_view(status, task_dir, now: nil) -> Hash`, with keys `readable`, `problem`, `gates`, `summary` (`total`, `resolved`, `passable`, `by_status`) and `revisions` (`count`, `latest`).
    - Each gate entry has `name`, `status`, `resolved`, `waits_on`, `requires_authorization`, `grant`, `requires_record`, `ran`, `passable` and `unresolved_reason`.
    - Unreadable problems are reported as `status.yaml is not a map`, `completion_gates is not a map`, `completion_gates.<name> is not a map`, or the first `ordering_errors` / `run_record_errors` message.
  - `gate_view_entry(...)` and `revision_summary(status)` are internal helpers.

- [ ] **Step 1: Create the suite (header, sections U and A, the PASS line)**

Create `tests/integration/gate-status.sh` (mode 755):

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2D — gate status view.
#
# CompletionGuard.gate_view derives each gate's state (resolved, waits_on,
# grant, record, passable now) from the enforcing rules, read-only.
# run-agent.sh status and scripts/adapter-status.rb render it with a revisions
# summary; tasks without gates or revisions are unchanged, and next_command is
# never touched. Sections: U the view, A agreement with the writer, C the
# single-task status, L the all-tasks status, J the adapter JSON.

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
REVISE="$ROOT/scripts/revise-task-plan.rb"
RUN_AGENT="$ROOT/run-agent.sh"
ADAPTER="$ROOT/scripts/adapter-status.rb"

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

T0=2026-10-08T01:00:00Z
NOW=2026-10-08T12:00:00Z
# view <TASK_ID> <ruby expression over v (the view) and g.(name)> — prints the result (JSON for non-strings).
view() {
  ruby -ryaml -rdate -rjson - "$ROOT" "$RUNS/$1" "$2" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
s = YAML.safe_load(File.read(File.join(ARGV[1], "status.yaml")), permitted_classes: [Date, Time])
v = CompletionGuard.gate_view(s, ARGV[1], now: Time.utc(2026, 10, 8, 12, 0, 0))
g = ->(name) { v["gates"].find { |x| x["name"] == name } }
r = eval(ARGV[2])
puts(r.is_a?(String) ? r : JSON.generate(r))
RUBY
}
# clone_task <SRC> <DST> — copies a task directory under a new id.
clone_task() {
  mkdir -p "$RUNS/$2"
  cp "$RUNS/$1"/*.yaml "$RUNS/$1/task.md" "$RUNS/$2/" 2>/dev/null || true
  local f
  for f in "$RUNS/$2/status.yaml" "$RUNS/$2/authorization.yaml"; do
    [[ -f "$f" ]] || continue
    ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["task_id"] = ARGV[1] if s.is_a?(Hash); File.write(p, YAML.dump(s))' "$f" "$2"
  done
}
PASSED='"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []'

# --- U: the derived gate view ---
D="$(task TASK-1101)"
gate TASK-1101 declare a --actor pm --reason a >/dev/null
gate TASK-1101 declare b --actor pm --reason b --after a >/dev/null
gate TASK-1101 declare c --actor pm --reason c --requires-authorization deploy_staging >/dev/null
gate TASK-1101 declare d --actor pm --reason d --requires-record >/dev/null
gate TASK-1101 declare e --actor pm --reason e >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1101 pass e --actor dev-2 --reason merged --ran-by operator --ran-ref 05fae97f >/dev/null
set_gate "$D/status.yaml" f "{$PASSED, \"requires_record\" => true}"
set_gate "$D/status.yaml" g "{$PASSED, \"requires_authorization\" => \"deploy_staging\"}"
gate TASK-1101 declare h --actor pm --reason h >/dev/null
gate TASK-1101 na h --actor reviewer --reason "not needed" >/dev/null
set_gate "$D/status.yaml" i '{"status" => "pass", "reason" => "no actor"}'
gate TASK-1101 declare j --actor pm --reason j --after f >/dev/null
gate TASK-1101 declare k --actor pm --reason k --after g >/dev/null
assert_eq "$(view TASK-1101 'v["readable"]')" "true" "U readable"
assert_eq "$(view TASK-1101 'g.("a").values_at("passable", "waits_on", "resolved")')" '[true,[],false]' "U unbound pending is passable"
assert_eq "$(view TASK-1101 'g.("b").values_at("passable", "waits_on")')" '[false,["a (pending)"]]' "U waits on a pending gate"
assert_eq "$(view TASK-1101 'g.("c").values_at("passable", "requires_authorization", "grant")')" '[false,"deploy_staging","missing"]' "U bound without a grant"
assert_eq "$(view TASK-1101 'g.("d").values_at("passable", "requires_record")')" '[true,true]' "U a required record does not block passable"
assert_eq "$(view TASK-1101 'g.("e").values_at("resolved", "passable", "unresolved_reason") + [g.("e")["ran"]["by"]]')" '[true,false,null,"operator"]' "U recorded pass"
assert_eq "$(view TASK-1101 'g.("f")["unresolved_reason"]')" "missing ran record" "U pass missing its record"
assert_eq "$(view TASK-1101 'g.("g")["unresolved_reason"]')" "authorization not satisfied" "U bound pass without a grant"
assert_eq "$(view TASK-1101 'g.("h").values_at("resolved", "passable")')" '[true,false]' "U na"
assert_eq "$(view TASK-1101 'g.("i")["unresolved_reason"]')" "missing actor/reason/updated_at" "U pass missing metadata"
assert_eq "$(view TASK-1101 'g.("j")["waits_on"]')" '["f (pass, missing ran record)"]' "U waits on a record-missing gate"
assert_eq "$(view TASK-1101 'g.("k")["waits_on"]')" '["g (pass, authorization not satisfied)"]' "U waits on an authorization-missing gate"
assert_eq "$(view TASK-1101 'v["gates"].map { |x| x["name"] }.join(",")')" "a,b,c,d,e,f,g,h,i,j,k" "U declaration order"
assert_eq "$(view TASK-1101 'v["summary"]')" '{"total":11,"resolved":2,"passable":2,"by_status":{"pending":6,"pass":4,"na":1}}' "U summary"
assert_eq "$(view TASK-1101 'v["revisions"]')" '{"count":0,"latest":null}' "U no revisions"
D="$(task TASK-1102)"
gate TASK-1102 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
AI_OFFICE_NOW=$T0 ruby "$AUTHZ" TASK-1102 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
assert_eq "$(view TASK-1102 'g.("deploy").values_at("grant", "passable")')" '["available",true]' "U bound with a valid grant"
D="$(task TASK-1103)"
gate TASK-1103 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
AI_OFFICE_NOW=$T0 ruby "$AUTHZ" TASK-1103 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok --expires-at 2026-10-08T06:00:00Z >/dev/null
assert_eq "$(view TASK-1103 'g.("deploy").values_at("grant", "passable")')" '["missing",false]' "U an expired grant is missing"
D="$(task TASK-1104)"
gate TASK-1104 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
printf 'authorizations: [\n' > "$D/authorization.yaml"
assert_eq "$(view TASK-1104 'v["readable"].to_s + " " + g.("deploy")["grant"]')" "true unknown" "U an unreadable ledger is unknown, not unreadable"
D="$(task TASK-1105)"; printf 'completion_gates: []\n' >> "$D/status.yaml"
assert_eq "$(view TASK-1105 'v.values_at("readable", "problem", "gates")')" '[false,"completion_gates is not a map",[]]' "U non-map gates"
D="$(task TASK-1106)"; gate TASK-1106 declare a --actor pm --reason a >/dev/null; set_gate "$D/status.yaml" b "nil"
assert_eq "$(view TASK-1106 'v.values_at("readable", "problem")')" '[false,"completion_gates.b is not a map"]' "U non-map gate"
D="$(task TASK-1107)"; set_gate "$D/status.yaml" a '{"status" => "pending", "after" => ["zz"]}'
assert_eq "$(view TASK-1107 'v.values_at("readable", "problem")')" '[false,"completion_gates.a.after names zz, which is not a declared gate"]' "U malformed ordering"
D="$(task TASK-1108)"; set_gate "$D/status.yaml" a '{"status" => "pending", "requires_record" => "yes"}'
assert_eq "$(view TASK-1108 'v.values_at("readable", "problem")')" '[false,"completion_gates.a.requires_record must be true"]' "U malformed record"
D="$(task TASK-1109)"
gate TASK-1109 declare a --actor pm --reason a >/dev/null
ruby "$REVISE" TASK-1109 plan_changed --actor dev --reason "second root cause" --no-new-gates "same files" >/dev/null
assert_eq "$(view TASK-1109 'v["revisions"]["count"].to_s + " " + v["revisions"]["latest"].values_at("id", "kind").join(" ")')" "1 rev-001 plan_changed" "U revisions"
ruby - "$ROOT" <<'RUBY' || fail "U a non-map status must not raise"
require File.join(ARGV[0], "scripts", "completion-guard")
v = CompletionGuard.gate_view("not a map", nil, now: Time.utc(2026, 10, 8))
abort "readable" unless v["readable"] == false && v["problem"] == "status.yaml is not a map"
RUBY

# Review Focus: an unexpected stored status never raises and is never passable.
D="$(task TASK-1110)"; set_gate "$D/status.yaml" odd '{"status" => "blocked"}'
assert_eq "$(view TASK-1110 'g.("odd").values_at("status", "passable", "resolved")')" '["blocked",false,false]' "RF unexpected status"
# Review Focus: without a task directory a bound gate's grant is unknown, not a crash.
ruby - "$ROOT" <<'RUBY' || fail "RF gate_view without task_dir"
require File.join(ARGV[0], "scripts", "completion-guard")
v = CompletionGuard.gate_view({ "completion_gates" => { "d" => { "status" => "pending", "requires_authorization" => "deploy_staging" } } }, nil, now: Time.utc(2026, 10, 8))
abort "grant #{v['gates'].first['grant']}" unless v["gates"].first.values_at("grant", "passable") == ["unknown", false]
RUBY
# Review Focus: a malformed last revision still counts, with no latest.
D="$(task TASK-1111)"; printf 'revisions:\n- not a map\n' >> "$D/status.yaml"
assert_eq "$(view TASK-1111 'v["revisions"]')" '{"count":1,"latest":null}' "RF malformed last revision"
# --- A: the view agrees with the writer ---
# For each case: passable from the view, then pass on a fresh copy at the same instant.
agree() { # <SRC TASK> <gate> <extra writer args...>
  local src="$1" name="$2"; shift 2
  local copy="TASK-$((1200 + RANDOM % 7000))"
  while [[ -d "$RUNS/$copy" ]]; do copy="TASK-$((1200 + RANDOM % 7000))"; done
  local passable; passable="$(view "$src" "g.(\"$name\")[\"passable\"]")"
  clone_task "$src" "$copy"
  rc=0; AI_OFFICE_NOW=$NOW ruby "$GATE" "$copy" pass "$name" --actor reviewer --reason r "$@" >/dev/null 2>&1 || rc=$?
  if [[ "$passable" == "true" ]]; then
    assert_eq "$rc" "0" "A $src $name passable but the writer refused"
  else
    assert_eq "$rc" "2" "A $src $name not passable but the writer did not refuse"
  fi
}
agree TASK-1101 a
agree TASK-1101 b
agree TASK-1101 c
agree TASK-1101 d --ran-by op --ran-ref x
agree TASK-1101 j
agree TASK-1101 k
agree TASK-1102 deploy --authorization authz-001
agree TASK-1103 deploy --authorization authz-001

echo "[PASS] gate-status: gate status view (#28 Phase 2D)"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-status.sh`
Expected: FAIL with `[FAIL] U readable: expected 'true', got ''`. The Ruby subprocess raises `undefined method 'gate_view' for CompletionGuard:Module` on stderr.

- [ ] **Step 3: Patch `CompletionGuard` and the writer**

Save as `2d-guard-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2d-guard-patch.rb scripts/completion-guard.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
# Plain (non-squiggly) heredoc: the inserted methods keep their two-space indent.
methods = <<'RUBY'

  # The label a waiting gate shows for one unresolved dependency. Shared by the
  # ordered-pass refusal in update-completion-gate.rb and gate_view, so the
  # wording cannot drift between the writer and the status surfaces.
  def dependency_label(gates, dep)
    state = gates[dep].is_a?(Hash) ? gates[dep]["status"].to_s : ""
    if missing_run_record?(gates[dep]) then "#{dep} (#{state}, missing ran record)"
    elsif resolved?(gates[dep]) then "#{dep} (#{state}, authorization not satisfied)"
    else "#{dep} (#{state})"
    end
  end

  # Phase 2D: a read-only view of a task's gates for status surfaces, derived
  # from the same rules the guard enforces. Never raises for state problems:
  # malformed gates give readable=false with the first problem; an unreadable
  # authorization ledger gives grant "unknown" and status-only judgement.
  def gate_view(status, task_dir, now: nil)
    view = {
      "readable" => true, "problem" => nil, "gates" => [],
      "summary" => { "total" => 0, "resolved" => 0, "passable" => 0, "by_status" => {} },
      "revisions" => revision_summary(status)
    }
    return view.merge("readable" => false, "problem" => "status.yaml is not a map") unless status.is_a?(Hash)

    gates = status["completion_gates"]
    if status.key?("completion_gates") && !gates.is_a?(Hash)
      return view.merge("readable" => false, "problem" => "completion_gates is not a map")
    end
    gates ||= {}
    bad = gates.find { |_name, gate| !gate.is_a?(Hash) }
    return view.merge("readable" => false, "problem" => "completion_gates.#{bad.first} is not a map") if bad

    problems = ordering_errors(gates) + run_record_errors(gates)
    return view.merge("readable" => false, "problem" => problems.first) unless problems.empty?

    index = nil
    ledger_unreadable = false
    if task_dir && gates.values.any? { |gate| gate.key?("requires_authorization") }
      begin
        index = AuthorizationLedger.load(task_dir)
      rescue AuthorizationLedger::Error
        ledger_unreadable = true
      end
    end
    now ||= begin
      AuthorizationLedger.now_utc
    rescue AuthorizationLedger::Error
      Time.now.utc
    end

    entries = gates.map { |name, gate| gate_view_entry(gates, name, gate, index, ledger_unreadable, now) }
    by_status = entries.each_with_object({}) { |entry, counts| counts[entry["status"]] = counts.fetch(entry["status"], 0) + 1 }
    view.merge(
      "gates" => entries,
      "summary" => {
        "total" => entries.size,
        "resolved" => entries.count { |entry| entry["resolved"] },
        "passable" => entries.count { |entry| entry["passable"] },
        "by_status" => by_status
      }
    )
  end

  def gate_view_entry(gates, name, gate, index, ledger_unreadable, now)
    state = gate["status"].to_s
    resolved = index ? gate_resolved?(gate, index) : resolved?(gate)
    waits_on = unresolved_dependencies(gates, gate, index).map { |dep| dependency_label(gates, dep) }
    action = gate["requires_authorization"]
    grant = nil
    if action && state == "pending"
      grant = if ledger_unreadable || index.nil? then "unknown"
              elsif index.any_valid_grant?(action: action, at: now, through: index.high_water_id) then "available"
              else "missing"
              end
    end
    unresolved_reason = nil
    if %w[pass na].include?(state) && !resolved
      unresolved_reason = if missing_run_record?(gate) then "missing ran record"
                          elsif resolved?(gate) then "authorization not satisfied"
                          else "missing actor/reason/updated_at"
                          end
    end
    {
      "name" => name,
      "status" => state,
      "resolved" => resolved,
      "waits_on" => waits_on,
      "requires_authorization" => action,
      "grant" => grant,
      "requires_record" => gate["requires_record"] == true,
      "ran" => state == "pass" && gate["ran"].is_a?(Hash) ? gate["ran"] : nil,
      "passable" => state == "pending" && waits_on.empty? && (action.nil? || grant == "available"),
      "unresolved_reason" => unresolved_reason
    }
  end

  def revision_summary(status)
    revisions = status.is_a?(Hash) && status["revisions"].is_a?(Array) ? status["revisions"] : []
    last = revisions.last
    latest = last.is_a?(Hash) ? { "id" => last["id"], "kind" => last["kind"], "at" => last["at"] } : nil
    { "count" => revisions.size, "latest" => latest }
  end
RUBY
anchor = "      errors << \"completion_gates.\#{name}.ran is only valid on a pass\" unless gate[\"status\"] == \"pass\"\n    end\n  end\n"
rep!(s, anchor, anchor + methods)
File.write(path, s)
```

Save as `2d-writer-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2d-writer-patch.rb scripts/update-completion-gate.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
old = <<'RUBY'
    labels = waiting.map do |dep|
      state = gates[dep]["status"].to_s
      if CompletionGuard.missing_run_record?(gates[dep]) then "#{dep} (#{state}, missing ran record)"
      elsif CompletionGuard.resolved?(gates[dep]) then "#{dep} (#{state}, authorization not satisfied)"
      else "#{dep} (#{state})"
      end
    end
RUBY
new = <<'RUBY'
    labels = waiting.map { |dep| CompletionGuard.dependency_label(gates, dep) }
RUBY
s.sub!(old) { new } or abort "no match: labels block"
File.write(path, s)
```

- [ ] **Step 4: Run the suite and the suites that check the refusal wording**

Run: `bash tests/integration/gate-status.sh && bash tests/integration/gate-ordering.sh && bash tests/integration/gate-records.sh && bash tests/integration/plan-revisions.sh && bash tests/integration/completion-gates.sh && bash tests/integration/authorization-ledger.sh`
Expected: each prints its own PASS line. `gate-ordering.sh` and `gate-records.sh` pin the refusal labels byte for byte.

- [ ] **Step 5: Prove three behaviours bite**

Apply each change, run the named suite, confirm the failure, then restore the file.

1. In `scripts/completion-guard.rb`, change `"passable" => state == "pending" && waits_on.empty? && (action.nil? || grant == "available"),` to `"passable" => state == "pending" && (action.nil? || grant == "available"),`. Run `gate-status.sh` and expect `[FAIL] U waits on a pending gate`.
2. Change `elsif index.any_valid_grant?(action: action, at: now, through: index.high_water_id) then "available"` to `elsif index.high_water_id then "available"`. Run `gate-status.sh` and expect `[FAIL] U an expired grant is missing`.
3. In `dependency_label`, change `then "#{dep} (#{state}, missing ran record)"` to `then "#{dep} (#{state})"`. Run `gate-records.sh` and expect `[FAIL] T ordering label`.

- [ ] **Step 6: Commit**

```bash
git add scripts/completion-guard.rb scripts/update-completion-gate.rb tests/integration/gate-status.sh
git commit -m "feat(office): read-only gate view and shared wait label (#28 Phase 2D)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gates in `run-agent.sh status`

**Files:**
- Modify: `run-agent.sh` (the `show_office_status` Ruby heredoc)
- Modify: `tests/integration/gate-status.sh` (sections C and L)

**Interfaces:**
- Consumes: `CompletionGuard.gate_view` (Task 1).
- Produces (heredoc-local methods):
  - `gate_status_lines(status, task_dir) -> Array<String>`
  - `gate_status_suffix(gate) -> String`
  - `gate_status_part(status, task_dir) -> String or nil`

- [ ] **Step 1: Write sections C and L (failing)**

Insert before the PASS line, using a UTF-8 Ruby script (the block contains em dashes):

````bash
SHA=05fae97f5ea5d38c7aded6f2eccbb627c0e72c2f
# gates_block <TASK_ID> — the lines between "Waiting for:"/"Branches:" output and "Validation:".
gates_block() {
  bash "$RUN_AGENT" status "$1" | ruby -e 'lines = STDIN.read.lines; i = lines.index { |l| l.start_with?("Gates:") || l.start_with?("Revisions:") }; j = lines.index { |l| l.start_with?("Validation:") }; print(i ? lines[i...j].join : "")'
}

# --- C: single-task status ---
# EAR-384 replay: two gates passed, the chain added with depend.
D="$(task TASK-1300)"
for g in product_contract shared_lib_publication implementation_verification authenticated_staging; do gate TASK-1300 declare "$g" --actor pm --reason intake >/dev/null; done
gate TASK-1300 depend implementation_verification --after shared_lib_publication --actor pm --reason "verify against the published contract" >/dev/null
gate TASK-1300 depend authenticated_staging --after implementation_verification --actor pm --reason "staging last" >/dev/null
gate TASK-1300 pass product_contract --actor dev-2 --reason "operator locked the contract" >/dev/null
gate TASK-1300 pass shared_lib_publication --actor dev-2 --reason merged --ran-by operator --ran-ref "$SHA" >/dev/null
cat > "$RUNS/c-expected.txt" <<TXT
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass — ran: operator $SHA
  implementation_verification: pending — can pass now
  authenticated_staging: pending — waits on implementation_verification (pending)
Revisions: none
TXT
gates_block TASK-1300 > "$RUNS/c-actual.txt"
diff -u "$RUNS/c-expected.txt" "$RUNS/c-actual.txt" || fail "C EAR-384 gates block"
grep -q "^Next: ./run-agent.sh TASK-1300 dev$" <<<"$(bash "$RUN_AGENT" status TASK-1300)" || fail "C Next: changed"
# Every other line form, from the U fixture.
block="$(gates_block TASK-1101)"
for line in \
  "Gates: 2/11 resolved" \
  "  c: pending — waits for a deploy_staging grant" \
  "  d: pending — can pass now (needs --ran-by and --ran-ref/--ran-url)" \
  "  e: pass — ran: operator 05fae97f" \
  "  f: pass — NOT resolved: missing ran record" \
  "  g: pass — NOT resolved: authorization not satisfied" \
  "  h: na" \
  "  i: pass — NOT resolved: missing actor/reason/updated_at" \
  "  b: pending — waits on a (pending)"; do
  grep -qxF "$line" <<<"$block" || fail "C missing line '$line' in: $block"
done
grep -qxF "  deploy: pending — waits for a deploy_staging grant (authorization ledger unreadable)" <<<"$(gates_block TASK-1104)" || fail "C unreadable ledger line"
assert_eq "$(gates_block TASK-1105 | head -1)" "Gates: unreadable (completion_gates is not a map; run validate-yaml.rb)" "C unreadable view"
grep -q "^Revisions: 1, latest rev-001 plan_changed @20" <<<"$(gates_block TASK-1109)" || fail "C revisions line: $(gates_block TASK-1109)"
# A task without gates or revisions: output identical to the pre-2D renderer.
D="$(task TASK-1100)"
cat > "$RUNS/n-expected.txt" <<TXT
Task: TASK-1100
Phase: assigned
State: assigned
Current agent: dev
Ready: true
Iteration: 1
Blocked on: none
Waiting for: none
Validation: fail
Next: ./run-agent.sh TASK-1100 dev
TXT
bash "$RUN_AGENT" status TASK-1100 > "$RUNS/n-actual.txt"
diff -u "$RUNS/n-expected.txt" "$RUNS/n-actual.txt" || fail "C a task without gates changed its status output"

# --- L: all-tasks status ---
bash "$RUN_AGENT" status > "$RUNS/list.txt"
grep -q "^TASK-1300 | .* | gates=pass:2,pending:2,ready:1$" "$RUNS/list.txt" || fail "L gates part: $(grep '^TASK-1300 ' "$RUNS/list.txt")"
grep -q "^TASK-1105 | .* | gates=unreadable$" "$RUNS/list.txt" || fail "L unreadable part"
grep -qxF "TASK-1100 | phase=assigned | agent=dev | ready=true | iteration=1 | validation=fail | next=./run-agent.sh TASK-1100 dev" "$RUNS/list.txt" \
  || fail "L a task without gates changed its line: $(grep '^TASK-1100 ' "$RUNS/list.txt")"
# Review Focus: an empty gate map, a malformed revision line, and read-only status.
D="$(task TASK-1112)"; printf 'completion_gates: {}\n' >> "$D/status.yaml"
bash "$RUN_AGENT" status > "$RUNS/rf-list.txt"
grep -q "^TASK-1112 | .* | gates=ready:0$" "$RUNS/rf-list.txt" || fail "RF empty gate map part: $(grep '^TASK-1112 ' "$RUNS/rf-list.txt")"
assert_eq "$(gates_block TASK-1111)" "Revisions: 1" "RF revision line without a latest entry"
assert_eq "$(gates_block TASK-1110 | grep -c '^  odd: blocked$')" "1" "RF unexpected status line"
cp "$RUNS/TASK-1300/status.yaml" "$RUNS/rf-status.before"
bash "$RUN_AGENT" status TASK-1300 >/dev/null; bash "$RUN_AGENT" status >/dev/null
cmp -s "$RUNS/TASK-1300/status.yaml" "$RUNS/rf-status.before" || fail "RF status changed status.yaml"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-status.sh`
Expected: FAIL with `[FAIL] C EAR-384 gates block`, after a `diff -u` that shows the expected `Gates:` lines as missing.

- [ ] **Step 3: Patch the renderer**

Save as `2d-status-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2d-status-patch.rb run-agent.sh`. The em dash is written as `"—"`.

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "office_dir, runs_dir, task_filter = ARGV\n", <<'RUBY')
office_dir, runs_dir, task_filter = ARGV
require File.join(office_dir, "scripts", "completion-guard")

# Phase 2D: the Gates/Revisions lines for one task, rendered from the
# read-only CompletionGuard.gate_view (see docs/completion-gates.md).
def gate_status_lines(status, task_dir)
  return [] unless status.is_a?(Hash) && (status.key?("completion_gates") || status.key?("revisions"))

  view = CompletionGuard.gate_view(status, task_dir)
  lines = []
  if status.key?("completion_gates")
    if view["readable"]
      lines << "Gates: #{view['summary']['resolved']}/#{view['summary']['total']} resolved"
      view["gates"].each { |gate| lines << "  #{gate['name']}: #{gate['status']}#{gate_status_suffix(gate)}" }
    else
      lines << "Gates: unreadable (#{view['problem']}; run validate-yaml.rb)"
    end
  end
  revisions = view["revisions"]
  lines << if revisions["count"].zero? then "Revisions: none"
           elsif revisions["latest"] then "Revisions: #{revisions['count']}, latest #{revisions['latest'].values_at('id', 'kind').join(' ')} @#{revisions['latest']['at']}"
           else "Revisions: #{revisions['count']}"
           end
  lines
end

def gate_status_suffix(gate)
  case gate["status"]
  when "pass", "na"
    return " \u2014 NOT resolved: #{gate['unresolved_reason']}" unless gate["resolved"]
    return "" unless gate["ran"].is_a?(Hash)

    " \u2014 ran: #{gate['ran']['by']} #{gate['ran']['ref'] || gate['ran']['url']}"
  when "pending"
    if gate["passable"]
      " \u2014 can pass now#{gate['requires_record'] ? ' (needs --ran-by and --ran-ref/--ran-url)' : ''}"
    elsif !gate["waits_on"].empty?
      " \u2014 waits on #{gate['waits_on'].join(', ')}"
    elsif gate["requires_authorization"]
      " \u2014 waits for a #{gate['requires_authorization']} grant#{gate['grant'] == 'unknown' ? ' (authorization ledger unreadable)' : ''}"
    else
      ""
    end
  else
    ""
  end
end

# The all-tasks part, e.g. "gates=pass:2,pending:2,ready:1"; nil without gates.
def gate_status_part(status, task_dir)
  return nil unless status.is_a?(Hash) && status.key?("completion_gates")

  view = CompletionGuard.gate_view(status, task_dir)
  return "gates=unreadable" unless view["readable"]

  counts = view["summary"]["by_status"].map { |state, count| "#{state}:#{count}" }
  "gates=#{(counts + ["ready:#{view['summary']['passable']}"]).join(',')}"
end
RUBY
rep!(s, "  puts \"Validation: \#{validation_status(validator, task_filter)}\"\n",
     "  gate_status_lines(status, File.join(runs_dir, task_filter)).each { |line| puts line }\n" \
     "  puts \"Validation: \#{validation_status(validator, task_filter)}\"\n")
rep!(s, "  puts parts.join(\" | \")\n",
     "  gates_part = gate_status_part(status, File.join(runs_dir, task_id))\n" \
     "  parts << gates_part if gates_part\n" \
     "  puts parts.join(\" | \")\n")
File.write(path, s)
```

Then run `bash -n run-agent.sh` (no output means OK). Confirm the added lines are ASCII: `git diff run-agent.sh | grep '^+' | LC_ALL=C grep -c '[^ -~	]'` must print `0`.

- [ ] **Step 4: Run the suite and the suites that read `status`**

Run: `bash tests/integration/gate-status.sh && bash tests/integration/partial-branches.sh`
Expected: each prints its PASS line.

- [ ] **Step 5: Prove the renderer bites**

In `run-agent.sh`, remove `#{gate['requires_record'] ? ' (needs --ran-by and --ran-ref/--ran-url)' : ''}`, then run `gate-status.sh`. Expect `[FAIL] C missing line '  d: pending — can pass now (needs --ran-by and --ran-ref/--ran-url)'`. Restore the line afterwards.

- [ ] **Step 6: Commit**

```bash
git add run-agent.sh tests/integration/gate-status.sh
git commit -m "feat(office): show gates and revisions in run-agent.sh status (#28 Phase 2D)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gates in `adapter-status.rb`

**Files:**
- Modify: `scripts/adapter-status.rb`
- Modify: `tests/integration/gate-status.sh` (section J)

**Interfaces:**
- Consumes: `CompletionGuard.gate_view`.
- Produces these JSON keys:
  - `completion_gates` (the derived list) and `gates_summary`, only when `status.yaml` has `completion_gates`;
  - `gates_readable: false` and `gates_problem`, only when the view is unreadable;
  - `revisions`, only when `status.yaml` has `revisions`.

- [ ] **Step 1: Write section J (failing)**

Insert before the PASS line:

````bash
# --- J: adapter JSON ---
# json <TASK_ID> <ruby expression over d> — evaluates against the adapter's JSON for the task.
json() { AI_OFFICE_NOW=$NOW ruby "$ADAPTER" "$1" | ruby -rjson -e 'd = JSON.parse(STDIN.read); r = eval(ARGV[0]); puts(r.is_a?(String) ? r : JSON.generate(r))' "$2"; }
D="$RUNS/TASK-1300"
cp "$D/status.yaml" "$RUNS/j-status.before"; cp "$D/meta.yaml" "$RUNS/j-meta.before"
assert_eq "$(json TASK-1300 'd["completion_gates"].map { |g| [g["name"], g["status"], g["passable"]] }')" \
  '[["product_contract","pass",false],["shared_lib_publication","pass",false],["implementation_verification","pending",true],["authenticated_staging","pending",false]]' "J completion_gates"
assert_eq "$(json TASK-1300 'd["completion_gates"].last["waits_on"]')" '["implementation_verification (pending)"]' "J waits_on"
assert_eq "$(json TASK-1300 'd["completion_gates"][1]["ran"]["by"]')" "operator" "J ran"
assert_eq "$(json TASK-1300 'd["gates_summary"]')" '{"total":4,"resolved":2,"passable":1,"by_status":{"pass":2,"pending":2}}' "J gates_summary"
assert_eq "$(json TASK-1300 'd.key?("revisions").to_s + " " + d.key?("gates_readable").to_s')" "false false" "J no revisions key, no readability keys when readable"
assert_eq "$(json TASK-1300 'd["next_command"]')" "./run-agent.sh TASK-1300 dev" "J next_command unchanged"
cmp -s "$D/status.yaml" "$RUNS/j-status.before" || fail "J the adapter query changed status.yaml"
cmp -s "$D/meta.yaml" "$RUNS/j-meta.before" || fail "J the adapter query changed meta.yaml"
cp "$RUNS/TASK-1102/authorization.yaml" "$RUNS/j-authz.before"
assert_eq "$(json TASK-1102 'd["completion_gates"].first.values_at("grant", "passable")')" '["available",true]' "J grant in the adapter"
cmp -s "$RUNS/TASK-1102/authorization.yaml" "$RUNS/j-authz.before" || fail "J the adapter query changed authorization.yaml"
assert_eq "$(json TASK-1105 'd.values_at("gates_readable", "gates_problem", "completion_gates")')" '[false,"completion_gates is not a map",[]]' "J unreadable"
assert_eq "$(json TASK-1109 'd["revisions"]["count"].to_s + " " + d["revisions"]["latest"]["id"]')" "1 rev-001" "J revisions"
assert_eq "$(json TASK-1100 'd.keys')" \
  '["task_id","phase","state","current_agent","iteration","blocked_on","waiting_for","terminal","blocked","next_command","pending_manual_output","last_synced_output","validation","recent_history"]' \
  "J a task without gates keeps today's key set"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-status.sh`
Expected: FAIL with `[FAIL] J completion_gates: expected '[["product_contract","pass",false],…]', got ''`.

- [ ] **Step 3: Patch the adapter**

Save as `2d-adapter-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2d-adapter-patch.rb scripts/adapter-status.rb`:

```ruby
path = ARGV[0]
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  s.sub!(old) { new } or abort "no match: #{old[0, 70].inspect}"
end
rep!(s, "require_relative \"next-agent-from-output\"\n", "require_relative \"next-agent-from-output\"\nrequire_relative \"completion-guard\"\n")
rep!(s, "result[\"branches\"] = status[\"branches\"] if status.key?(\"branches\")\n", <<'RUBY')
result["branches"] = status["branches"] if status.key?("branches")
# Phase 2D: the derived, read-only gate view (CompletionGuard.gate_view). Only
# for tasks that have gates or revisions, so every other task's JSON is unchanged.
if status.key?("completion_gates") || status.key?("revisions")
  gate_view = CompletionGuard.gate_view(status, task_dir)
  if status.key?("completion_gates")
    result["completion_gates"] = gate_view["gates"]
    result["gates_summary"] = gate_view["summary"]
    unless gate_view["readable"]
      result["gates_readable"] = false
      result["gates_problem"] = gate_view["problem"]
    end
  end
  result["revisions"] = gate_view["revisions"] if status.key?("revisions")
end
RUBY
File.write(path, s)
```

- [ ] **Step 4: Run the suite and the adapter suite**

Run: `bash tests/integration/gate-status.sh && bash tests/integration/adapter-status.sh`
Expected: each prints its PASS line.

- [ ] **Step 5: Prove the key guard bites**

Change the inner `  if status.key?("completion_gates")` (the line before `result["completion_gates"] = …`) to `  if true`, and the outer condition to `if true`. Run `gate-status.sh` and expect `[FAIL] J a task without gates keeps today's key set`. Then restore the file.

- [ ] **Step 6: Commit**

```bash
git add scripts/adapter-status.rb tests/integration/gate-status.sh
git commit -m "feat(office): gate view in adapter-status JSON (#28 Phase 2D)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs and full regression

**Files:**
- Modify: `docs/runtime-adapter-contract.md` (a paragraph directly before `**How it was tested end-to-end**:`)
- Modify: `docs/completion-gates.md` (a section directly before `## Compatibility`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: documentation only.

- [ ] **Step 1: Add the adapter paragraph**

Insert directly before the line that starts with `**How it was tested end-to-end**:` in `docs/runtime-adapter-contract.md`:

````markdown
**Gate view (Phase 2D, optional keys).** For a task whose `status.yaml` has
`completion_gates`, the JSON adds `completion_gates` and `gates_summary`; for
a task with `revisions`, it adds `revisions`. Every other task's JSON is
unchanged, key for key. The values come from the read-only
`CompletionGuard.gate_view`, which derives them from the same rules the
writers enforce:

```json
"completion_gates": [
  { "name": "implementation_verification", "status": "pending", "resolved": false,
    "waits_on": [], "requires_authorization": null, "grant": null,
    "requires_record": false, "ran": null, "passable": true, "unresolved_reason": null },
  { "name": "authenticated_staging", "status": "pending", "resolved": false,
    "waits_on": ["implementation_verification (pending)"], "requires_authorization": null,
    "grant": null, "requires_record": false, "ran": null, "passable": false,
    "unresolved_reason": null }
],
"gates_summary": { "total": 4, "resolved": 2, "passable": 1, "by_status": { "pass": 2, "pending": 2 } },
"revisions": { "count": 1, "latest": { "id": "rev-001", "kind": "plan_changed", "at": "2026-10-08T03:00:00Z" } }
```

- `completion_gates` here is a **list of derived entries** in declaration
  order, not the stored map. Read `status.yaml` for the raw record.
- `passable` means a `pass` now would not be refused for ordering or
  authorization. A required record is supplied with `--ran-*` at pass time.
- `grant` is `available`, `missing` or `unknown` (ledger unreadable) for a
  pending bound gate.
- When the stored gates are malformed, `completion_gates` is `[]` and
  `gates_readable: false` plus `gates_problem` are added.
- `next_command` is never affected.

````

- [ ] **Step 2: Add the status section**

Insert directly before the line `## Compatibility` in `docs/completion-gates.md`:

````markdown
## Seeing gates (Phase 2D)

`run-agent.sh status <TASK>` prints a `Gates:` block and a `Revisions:` line
for a task that has `completion_gates` or `revisions`:

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
  malformed.

`run-agent.sh status` (all tasks) appends `gates=pass:2,pending:2,ready:1`,
where `ready` counts the gates that can pass now. The adapter JSON carries the
same view (see [runtime-adapter-contract.md](runtime-adapter-contract.md)).
Tasks without gates or revisions print exactly what they printed before, and
`Next:` is unchanged. Nothing is written.

Limits: "can pass now" is a snapshot. A grant can expire or be revoked
before `pass` runs, and the writer stays the authority. It does not check
`actor`/`reason` or verify `ran`. The dashboard does not show gates yet. Spec:
[`superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md`](superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md).

````

- [ ] **Step 3: Full regression**

```bash
for t in gate-status gate-records gate-ordering plan-revisions completion-gates partial-branches authorization-ledger failure-recovery schema-validator-parity adapter-status; do bash "tests/integration/$t.sh" > "<scratchpad>/2d-$t.log" 2>&1 && echo "ok $t" || echo "FAIL $t"; done
```

Expected: ten `ok` lines. Then run `bash tests/integration/authorization-dispatch.sh` in the background (about 6 minutes) and confirm its final `[PASS]`. A failure in a pre-existing suite is a regression: fix the code, never the test.

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do ruby validate-yaml.rb "$t" >/dev/null && echo "ok $t" || echo "FAIL $t"; done
```

Expected: five `ok` lines. Optionally, render the real EAR-384 gates read-only with `AI_OFFICE_RUNS_DIR=/Users/earth/Documents/GitHub/ai-dev-office/runs bash run-agent.sh status TASK-EAR-384`.

- [ ] **Step 4: Commit**

```bash
git add docs/runtime-adapter-contract.md docs/completion-gates.md
git commit -m "docs(office): gate status view (#28 Phase 2D)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Where |
|---|---|
| Design 1: `gate_view` fields, the rules for `resolved` / `waits_on` / `grant` / `passable` / `unresolved_reason`, `revisions`, `now`, unreadable views, the ledger | T1; tests U, A, RF |
| Design 2: the single-task `Gates:` block, every line form, unreadable view, `Revisions:`, unchanged output without gates | T2; tests C, RF |
| Design 3: the all-tasks `gates=` part, `gates=unreadable`, unchanged lines | T2; tests L, RF |
| Design 4: adapter keys, unchanged key set, `next_command`, read-only | T3; test J |
| Design 5: docs | T4 |
| Design 6: the shared label (writer wording byte-identical) | T1 (`gate-ordering` / `gate-records` pin the wording) |
| Agreement of the view with the writer | test A |
