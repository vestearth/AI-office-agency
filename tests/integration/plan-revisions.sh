#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2A — plan revision record.
#
# A change of plan or scope is recorded as an append-only `revisions` entry in
# status.yaml by scripts/revise-task-plan.rb, which in the same write declares
# the gates and branches the change implies or records why there are none.
# Sections: W shared record construction (existing writers pinned byte for
# byte), V stored-state validation, R replay shapes, X refusals, I idempotency
# and ids, C concurrency/fence/corrupt state, G golden equivalence with the
# existing writers, S team sync and revert safety.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
BRANCH="$ROOT/scripts/update-task-branch.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
REVISE="$ROOT/scripts/revise-task-plan.rb"
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
puts value.nil? ? "" : value
RUBY
}
# task <TASK_ID> [phase] — a minimal governed task (updated_at present, so key order is fixed).
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
normalize() {
  sed -E "s/'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'/'<TS>'/g; s/'[0-9]{4}-[0-9]{2}-[0-9]{2}'/'<DATE>'/g" "$1"
}

# --- W: shared record construction; the existing writers' bytes are pinned ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] W #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
check "gate_record declare, no reason",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "", updated_at: "T", requires_authorization: "live_load"),
      { "status" => "pending", "actor" => "pm", "updated_at" => "T", "evidence_refs" => [], "requires_authorization" => "live_load" }
check "gate_record bound pass key order",
      CompletionGuard.gate_record(status: "pass", actor: "rv", reason: "ran", updated_at: "T", evidence_refs: ["ev-001"],
                                  requires_authorization: "live_load", authorization_refs: ["authz-001"], authorization_through: "authz-002").keys,
      %w[status actor reason updated_at evidence_refs requires_authorization authorization_refs authorization_through]
check "gate_history_row default reason",
      CompletionGuard.gate_history_row("g", "absent", "pending", actor: "someone", reason: nil, at: "T"),
      { "phase" => "gate g: absent -> pending", "agent" => "orchestrator", "reason" => "completion gate declared", "at" => "T" }
check "branch_record blocked",
      CompletionGuard.branch_record(state: "blocked", actor: "pm", reason: "r", updated_at: "T", waiting_for: ["op: x"]),
      { "state" => "blocked", "actor" => "pm", "reason" => "r", "updated_at" => "T", "waiting_for" => ["op: x"] }
check "branch_record ready drops waiting_for",
      CompletionGuard.branch_record(state: "ready", actor: "pm", reason: "r", updated_at: "T", waiting_for: ["ignored"]),
      { "state" => "ready", "actor" => "pm", "reason" => "r", "updated_at" => "T" }
check "branch_history_row",
      CompletionGuard.branch_history_row("w", from: "declared", to: "ready", old_phase: "assigned", new_phase: "assigned", actor: "pm", reason: "r", at: "T"),
      { "phase" => "assigned -> assigned", "agent" => "pm", "reason" => "Branch w: declared -> ready; r", "at" => "T" }
check "branch_state_error clean", CompletionGuard.branch_state_error({ "waiting_for" => [] }), nil
check "branch_state_error non-map", CompletionGuard.branch_state_error({ "branches" => [] }), "status.yaml branches must be a map"
check "branch_state_error malformed",
      CompletionGuard.branch_state_error({ "branches" => { "w" => { "state" => "ready" } } }), "malformed existing branch \"w\""
check "branch_state_error waiting_for", CompletionGuard.branch_state_error({ "waiting_for" => "x" }), "status.yaml waiting_for must be a list"
check "branch_state_error blocked_on", CompletionGuard.branch_state_error({ "blocked_on" => "x" }), "status.yaml blocked_on must be a list"
check "branch_state_error reasons", CompletionGuard.branch_state_error({ "waiting_for" => [""] }), "status.yaml waiting_for must contain reasons"
RUBY

# Byte pin: this exact sequence through the EXISTING writers must keep producing
# exactly this file (timestamps normalized). Generated from main 2f3ecfe2.
mkdir -p "$RUNS/TASK-PIN-001"
cat > "$RUNS/TASK-PIN-001/status.yaml" <<'YAML'
task_id: TASK-PIN-001
phase: assigned
state: assigned
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
history: []
YAML
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$GATE" TASK-PIN-001 declare source_merged --actor pm --reason "merge to main" >/dev/null
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$GATE" TASK-PIN-001 declare production_backfill --actor pm --requires-authorization production_backfill >/dev/null
AI_OFFICE_NOW=2026-10-08T01:00:00Z ruby "$AUTHZ" TASK-PIN-001 grant --action production_backfill --scope backfill --actor op --via chat --reason ok >/dev/null
AI_OFFICE_NOW=2026-10-08T01:05:00Z ruby "$GATE" TASK-PIN-001 pass production_backfill --actor reviewer --reason ran --authorization authz-001 >/dev/null
AI_OFFICE_NOW=2026-10-08T01:05:00Z ruby "$GATE" TASK-PIN-001 na source_merged --actor reviewer --reason "no code" >/dev/null
ruby "$BRANCH" TASK-PIN-001 declare wave_1 --actor pm --reason executable >/dev/null
ruby "$BRANCH" TASK-PIN-001 declare wave_2 --actor pm --reason "policy pending" --state blocked --waiting-for "operator: policy A/B/C" >/dev/null
ruby "$BRANCH" TASK-PIN-001 done wave_1 --actor dev --reason "wave 1 shipped" >/dev/null
cat > "$RUNS/pin.expected" <<'YAML'
---
task_id: TASK-PIN-001
phase: blocked
state: blocked
iteration: 1
current_agent: dev
ready: false
blocked_on: []
waiting_for:
- 'branch:wave_2 operator: policy A/B/C'
assignment:
  primary: dev
  parallel: false
history:
- phase: 'gate source_merged: absent -> pending'
  agent: pm
  reason: merge to main
  at: '<TS>'
- phase: 'gate production_backfill: absent -> pending'
  agent: pm
  reason: completion gate declared
  at: '<TS>'
- phase: 'gate production_backfill: pending -> pass'
  agent: reviewer
  reason: ran
  at: '<TS>'
- phase: 'gate source_merged: pending -> na'
  agent: reviewer
  reason: no code
  at: '<TS>'
- phase: assigned -> assigned
  agent: pm
  reason: 'Branch wave_1: declared -> ready; executable'
  at: '<TS>'
- phase: assigned -> assigned
  agent: pm
  reason: 'Branch wave_2: declared -> blocked; policy pending'
  at: '<TS>'
- phase: assigned -> blocked
  agent: dev
  reason: 'Branch wave_1: ready -> done; wave 1 shipped'
  at: '<TS>'
completion_gates:
  source_merged:
    status: na
    actor: reviewer
    reason: no code
    updated_at: '<TS>'
    evidence_refs: []
  production_backfill:
    status: pass
    actor: reviewer
    reason: ran
    updated_at: '<TS>'
    evidence_refs: []
    requires_authorization: production_backfill
    authorization_refs:
    - authz-001
    authorization_through: authz-001
updated_at: '<DATE>'
branches:
  wave_1:
    state: done
    actor: dev
    reason: wave 1 shipped
    updated_at: '<TS>'
  wave_2:
    state: blocked
    actor: pm
    reason: policy pending
    updated_at: '<TS>'
    waiting_for:
    - 'operator: policy A/B/C'
YAML
normalize "$RUNS/TASK-PIN-001/status.yaml" > "$RUNS/pin.actual"
diff -u "$RUNS/pin.expected" "$RUNS/pin.actual" || fail "W: the existing gate/branch writers' status.yaml bytes changed"

# --- V: stored-state rules for `revisions` (library + validator) ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "plan-revisions")
GATES = { "production_backfill" => { "status" => "pending", "actor" => "dev", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [] } }
BRANCHES = { "wave_1" => { "state" => "ready", "actor" => "pm", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" } }
def rev(id, extra = {})
  { "id" => id, "at" => "2026-10-08T01:00:00Z", "kind" => "plan_changed", "actor" => "dev", "reason" => "r", "no_new_gates" => "same path" }.merge(extra)
end
def eff(id, gates, branches)
  rev(id).reject { |key, _| key == "no_new_gates" }.merge("effects" => { "gates_declared" => gates, "branches_declared" => branches })
end
def errs(revisions)
  PlanRevisions.stored_errors({ "completion_gates" => GATES, "branches" => BRANCHES, "revisions" => revisions }, "s")
end
def ok(label, revisions)
  e = errs(revisions)
  abort "[FAIL] V #{label}: unexpected #{e.inspect}" unless e.empty?
end
def bad(label, revisions, fragment)
  e = errs(revisions)
  abort "[FAIL] V #{label}: expected an error containing #{fragment.inspect}, got #{e.inspect}" unless e.any? { |m| m.include?(fragment) }
end

abort "[FAIL] V absent key must be no errors" unless PlanRevisions.stored_errors({ "phase" => "assigned" }, "s").empty?
ok "assertion", [rev("rev-001")]
ok "effects", [eff("rev-001", ["production_backfill"], []), eff("rev-002", [], ["wave_1"])]
ok "numeric order past 999", [rev("rev-999"), rev("rev-1000"), rev("rev-1001")]
bad "not a list", { "x" => 1 }, "s.revisions must be a list"
bad "entry not a map", ["rev-001"], "s.revisions[0] must be a map"
bad "unknown key", [rev("rev-001", "note" => "x")], "s.revisions[0] has unknown field(s): note"
bad "bad id", [rev("rev-01")], "s.revisions[0].id must match rev-NNN"
bad "decreasing id", [rev("rev-002"), rev("rev-001")], "s.revisions[1].id rev-001 must be greater than"
bad "zero-padded duplicate", [rev("rev-001"), rev("rev-0001")], "s.revisions[1].id rev-0001 must be greater than"
bad "bad at", [rev("rev-001", "at" => "2026-10-08 01:00:00")], "s.revisions[0].at must be a UTC timestamp"
bad "bad kind", [rev("rev-001", "kind" => "scope_grew")], "s.revisions[0].kind must be one of"
bad "empty actor", [rev("rev-001", "actor" => " ")], "s.revisions[0].actor must be a non-empty string"
bad "missing reason", [rev("rev-001").reject { |k, _| k == "reason" }], "s.revisions[0].reason must be a non-empty string"
bad "both", [eff("rev-001", ["production_backfill"], []).merge("no_new_gates" => "x")], "exactly one of effects or no_new_gates"
bad "neither", [rev("rev-001").reject { |k, _| k == "no_new_gates" }], "exactly one of effects or no_new_gates"
bad "empty assertion", [rev("rev-001", "no_new_gates" => "")], "s.revisions[0].no_new_gates must be a non-empty string"
bad "effects not a map", [rev("rev-001").reject { |k, _| k == "no_new_gates" }.merge("effects" => [])], "s.revisions[0].effects must be a map with gates_declared and branches_declared"
bad "effects missing list", [rev("rev-001").reject { |k, _| k == "no_new_gates" }.merge("effects" => { "gates_declared" => [] })], "must be a map with gates_declared and branches_declared"
bad "effects both empty", [eff("rev-001", [], [])], "must declare at least one gate or branch"
bad "bad gate name", [eff("rev-001", ["Bad-Name"], [])], "s.revisions[0].effects.gates_declared must be a list of names"
bad "repeated name", [eff("rev-001", ["production_backfill", "production_backfill"], [])], "gates_declared lists a name twice"
bad "gate removed by hand", [eff("rev-001", ["gone_gate"], [])], "gates_declared names gone_gate, which is not in completion_gates"
bad "branch removed by hand", [eff("rev-001", [], ["gone_branch"])], "branches_declared names gone_branch, which is not in branches"

abort "[FAIL] V next_id empty" unless PlanRevisions.next_id([]) == "rev-001"
abort "[FAIL] V next_id 999" unless PlanRevisions.next_id([rev("rev-999")]) == "rev-1000"
abort "[FAIL] V next_id uses max, not last" unless PlanRevisions.next_id([rev("rev-1000"), rev("rev-999")]) == "rev-1001"
abort "[FAIL] V id_number" unless PlanRevisions.id_number("rev-0042") == 42 && PlanRevisions.id_number("REV-001").nil? && PlanRevisions.id_number(7).nil?
c = PlanRevisions.content(kind: "scope_expanded", actor: "dev", reason: "r", gates: ["g"], branches: [], no_new_gates: nil)
abort "[FAIL] V content effects" unless c == { "kind" => "scope_expanded", "actor" => "dev", "reason" => "r", "effects" => { "gates_declared" => ["g"], "branches_declared" => [] } }
e = PlanRevisions.build_entry(id: "rev-001", at: "2026-10-08T01:00:00Z", content: c)
abort "[FAIL] V build_entry key order: #{e.keys.inspect}" unless e.keys == %w[id at kind actor reason effects]
abort "[FAIL] V same_content? positive" unless PlanRevisions.same_content?(e, c)
abort "[FAIL] V same_content? negative" if PlanRevisions.same_content?(e, c.merge("reason" => "other"))
abort "[FAIL] V same_content? nil entry" if PlanRevisions.same_content?(nil, c)
RUBY

# The validator enforces the same rules on a stored status.yaml.
D="$(task TASK-901)"
cat >> "$D/status.yaml" <<'YAML'
revisions:
- id: rev-001
  at: '2026-10-08T01:00:00Z'
  kind: scope_grew
  actor: dev
  reason: r
  no_new_gates: same path
YAML
rc=0; ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || rc=$?
[[ "$rc" != "0" ]] || fail "V: the validator accepted an unknown revision kind"
grep -q "revisions\[0\].kind must be one of" "$RUNS/validate.log" || fail "V: validator message missing: $(cat "$RUNS/validate.log")"
ruby -e 'p = ARGV[0]; File.write(p, File.read(p).sub("kind: scope_grew", "kind: plan_changed"))' "$D/status.yaml"
ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || fail "V: a valid revision was rejected: $(cat "$RUNS/validate.log")"
D="$(task TASK-902)"
ruby "$VALIDATOR" "$D/status.yaml" >"$RUNS/validate.log" 2>&1 || fail "V: a task without revisions no longer validates: $(cat "$RUNS/validate.log")"

revise() { ruby "$REVISE" "$@"; }
force_done() { ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-08 done done reviewer "accept" >"$RUNS/force.log" 2>&1; }
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }
# last_revised <task dir> — details of the last plan_revised meta event (YAML.dump may fold long lines, so never grep it).
last_revised() {
  ruby -ryaml -rdate -e 'm = YAML.safe_load(File.read(File.join(ARGV[0], "meta.yaml")), permitted_classes: [Date, Time]) || {}
    e = Array(m["events"]).select { |x| x["type"] == "plan_revised" }.last; puts e ? e["details"] : ""' "$1"
}
# expect_refusal <exit> <label> <TASK_ID> <revise args...> — exit code matches and nothing is written.
expect_refusal() {
  local code="$1" label="$2" task_id="$3"; shift 3
  local status="$RUNS/$task_id/status.yaml"
  [[ -f "$status" ]] && cp "$status" "$RUNS/before.yaml"
  rc=0; ruby "$REVISE" "$task_id" "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "$code" "X $label exit ($(cat "$RUNS/refusal.log"))"
  if [[ -f "$status" ]]; then cmp -s "$status" "$RUNS/before.yaml" || fail "X $label wrote status.yaml"; fi
}

# --- R: replay shapes from the five VerifySlip runs ---
# VS-010: a small fix in review grows into a production backfill.
D="$(task TASK-910 review)"
out="$(revise TASK-910 scope_expanded --actor dev --reason "operator chose to backfill rows written with the old timezone" --gate production_backfill:production_backfill)"
assert_eq "$out" "plan revision rev-001: scope_expanded (task review)" "R VS-010 output"
assert_eq "$(field "$D/status.yaml" completion_gates.production_backfill.status)" "pending" "R VS-010 gate pending"
assert_eq "$(field "$D/status.yaml" completion_gates.production_backfill.requires_authorization)" "production_backfill" "R VS-010 gate bound"
assert_eq "$(field "$D/status.yaml" revisions.0.effects.gates_declared.0)" "production_backfill" "R VS-010 revision names the gate"
assert_eq "$(field "$D/status.yaml" revisions.0.id)" "rev-001" "R VS-010 id"
validate "$D/status.yaml" || fail "R VS-010 invalid: $(cat "$RUNS/validate.log")"
assert_eq "$(last_revised "$D")" "revision=rev-001 kind=scope_expanded gates=production_backfill branches= task_phase=review" "R VS-010 plan_revised meta event"
if force_done TASK-910; then fail "R VS-010 a revision's gate did not block done"; fi
grep -q "production_backfill" "$RUNS/force.log" || fail "R VS-010 refusal does not name the gate"
ruby "$AUTHZ" TASK-910 grant --action production_backfill --scope "timezone backfill" --actor operator --via chat --reason approved >/dev/null
ruby "$GATE" TASK-910 pass production_backfill --actor reviewer --reason "backfill ran" --authorization authz-001 >/dev/null
force_done TASK-910 || fail "R VS-010 done refused after the bound gate passed: $(cat "$RUNS/force.log")"

# VS-004: one task splits into an executable wave and a decision-blocked wave.
D="$(task TASK-912)"
revise TASK-912 plan_changed --actor pm --reason "wave 2 waits on the fairness policy" \
  --branch wave_1:ready --branch "wave_2:blocked:operator: fairness policy A/B/C" >/dev/null
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "R VS-004 ready sibling keeps task assigned"
assert_eq "$(field "$D/status.yaml" branches.wave_2.waiting_for.0)" "operator: fairness policy A/B/C" "R VS-004 colon in waiting text kept whole"
assert_eq "$(field "$D/status.yaml" waiting_for.0)" "branch:wave_2 operator: fairness policy A/B/C" "R VS-004 projection applied"
validate "$D/status.yaml" || fail "R VS-004 invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-912; then fail "R VS-004 an unresolved branch allowed done"; fi
grep -q "branch:wave_1" "$RUNS/force.log" || fail "R VS-004 refusal does not name the branch"

# Only a blocked branch: the task moves to blocked exactly as the 1C writer would.
D="$(task TASK-913)"
revise TASK-913 scope_expanded --actor pm --reason "hold for the operator" --branch "hold:blocked:operator decision" >/dev/null
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "R blocked-only branch blocks task"
assert_eq "$(field "$D/status.yaml" ready)" "false" "R blocked-only branch clears ready"
assert_eq "$(field "$D/status.yaml" history.0.phase)" "assigned -> blocked" "R branch history row shows the phase move"
assert_eq "$(field "$D/status.yaml" history.1.phase)" "plan revision rev-001: scope_expanded" "R revision history row last"
validate "$D/status.yaml" || fail "R blocked-only invalid: $(cat "$RUNS/validate.log")"

# VS-006: a second root cause on the same files — no new gate, said explicitly.
D="$(task TASK-914 review)"
revise TASK-914 plan_changed --actor dev --reason "second root cause found in staging" --no-new-gates "same files and the same deploy path" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "R VS-006 no gate created"
assert_eq "$(field "$D/status.yaml" branches)" "" "R VS-006 no branch created"
assert_eq "$(field "$D/status.yaml" revisions.0.no_new_gates)" "same files and the same deploy path" "R VS-006 assertion stored"
assert_eq "$(last_revised "$D")" "revision=rev-001 kind=plan_changed no_new_gates task_phase=review" "R VS-006 meta details"
validate "$D/status.yaml" || fail "R VS-006 invalid: $(cat "$RUNS/validate.log")"

# VS-003: two consecutive revisions.
D="$(task TASK-915 review)"
revise TASK-915 scope_expanded --actor operator --reason "bank budget raised 700 -> 1200" --gate live_load:live_load >/dev/null
revise TASK-915 plan_changed --actor dev --reason "lock contention, not the bank limit" --no-new-gates "the live_load gate already covers it" >/dev/null
assert_eq "$(field "$D/status.yaml" revisions.0.id) $(field "$D/status.yaml" revisions.1.id)" "rev-001 rev-002" "R VS-003 ids"
validate "$D/status.yaml" || fail "R VS-003 invalid: $(cat "$RUNS/validate.log")"

# --- X: refusals write nothing ---
D="$(task TASK-920)"
ruby "$GATE" TASK-920 declare existing_gate --actor pm --reason r >/dev/null
ruby "$BRANCH" TASK-920 declare existing_branch --actor pm --reason r >/dev/null
expect_refusal 2 "bare revision" TASK-920 scope_expanded --actor a --reason r
expect_refusal 2 "effects and assertion" TASK-920 scope_expanded --actor a --reason r --gate x --no-new-gates why
expect_refusal 2 "empty assertion" TASK-920 plan_changed --actor a --reason r --no-new-gates ""
expect_refusal 2 "missing actor" TASK-920 plan_changed --reason r --no-new-gates why
expect_refusal 2 "unknown kind" TASK-920 scope_grew --actor a --reason r --no-new-gates why
expect_refusal 2 "unknown flag" TASK-920 plan_changed --actor a --reason r --no-new-gates why --force yes
expect_refusal 2 "unknown action" TASK-920 scope_expanded --actor a --reason r --gate x:deploy_prod
expect_refusal 2 "malformed gate name" TASK-920 scope_expanded --actor a --reason r --gate Bad-Name
expect_refusal 2 "empty gate action" TASK-920 scope_expanded --actor a --reason r --gate "x:"
expect_refusal 2 "gate spec with two colons" TASK-920 scope_expanded --actor a --reason r --gate "x:live_load:y"
expect_refusal 2 "blocked branch without text" TASK-920 scope_expanded --actor a --reason r --branch x:blocked
expect_refusal 2 "blocked branch with empty text" TASK-920 scope_expanded --actor a --reason r --branch "x:blocked: "
expect_refusal 2 "ready branch with text" TASK-920 scope_expanded --actor a --reason r --branch "x:ready:oops"
expect_refusal 2 "unknown branch state" TASK-920 scope_expanded --actor a --reason r --branch x:done
expect_refusal 2 "malformed branch name" TASK-920 scope_expanded --actor a --reason r --branch Bad:ready
expect_refusal 2 "gate twice in one call" TASK-920 scope_expanded --actor a --reason r --gate x --gate x
expect_refusal 2 "branch twice in one call" TASK-920 scope_expanded --actor a --reason r --branch x:ready --branch x:ready
expect_refusal 2 "atomic: later gate already declared" TASK-920 scope_expanded --actor a --reason r --gate fresh_gate --gate existing_gate
assert_eq "$(field "$RUNS/TASK-920/status.yaml" completion_gates.fresh_gate)" "" "X atomic refusal created no first gate"
expect_refusal 2 "existing branch" TASK-920 scope_expanded --actor a --reason r --branch existing_branch:ready
D="$(task TASK-921 done)"
expect_refusal 2 "done task" TASK-921 plan_changed --actor a --reason r --no-new-gates why
D="$(task TASK-922 aborted)"
expect_refusal 2 "aborted task" TASK-922 plan_changed --actor a --reason r --no-new-gates why
expect_refusal 3 "missing task" TASK-929 plan_changed --actor a --reason r --no-new-gates why
[[ ! -f "$RUNS/TASK-920/meta.yaml" ]] || assert_eq "$(last_revised "$RUNS/TASK-920")" "" "X a refusal appended a plan_revised event"

# --- I: idempotency and ids ---
D="$(task TASK-930)"
revise TASK-930 scope_expanded --actor dev --reason "grew" --gate g1 >/dev/null
cp "$D/status.yaml" "$RUNS/before.yaml"
out="$(revise TASK-930 scope_expanded --actor dev --reason "grew" --gate g1)"
assert_eq "$out" "plan revision rev-001 already recorded" "I identical repeat is a no-op"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "I identical repeat changed status.yaml"
D="$(task TASK-932)"
revise TASK-932 plan_changed --actor dev --reason r1 --no-new-gates n >/dev/null
revise TASK-932 plan_changed --actor dev --reason r2 --no-new-gates n >/dev/null
out="$(revise TASK-932 plan_changed --actor dev --reason r1 --no-new-gates n)"
assert_eq "$out" "plan revision rev-003: plan_changed (task assigned)" "I repeat of an earlier, non-last revision is recorded"
D="$(task TASK-931)"
revise TASK-931 scope_expanded --actor dev --reason "grew" --gate g:production_backfill >/dev/null
expect_refusal 2 "same revision, different binding" TASK-931 scope_expanded --actor dev --reason "grew" --gate g
D="$(task TASK-933)"
revise TASK-933 scope_expanded --actor dev --reason "grew" --gate g >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].delete("g"); File.write(p, YAML.dump(s))' "$D/status.yaml"
if validate "$D/status.yaml"; then fail "I a hand-removed revision gate validated"; fi
grep -q "gates_declared names g, which is not in completion_gates" "$RUNS/validate.log" || fail "I validator message: $(cat "$RUNS/validate.log")"
expect_refusal 3 "writer refuses to build on a broken record" TASK-933 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-934)"
cat >> "$D/status.yaml" <<'YAML'
revisions:
- {id: rev-998, at: '2026-10-08T01:00:00Z', kind: plan_changed, actor: dev, reason: a, no_new_gates: n}
- {id: rev-999, at: '2026-10-08T01:00:00Z', kind: plan_changed, actor: dev, reason: b, no_new_gates: n}
YAML
assert_eq "$(revise TASK-934 plan_changed --actor dev --reason c --no-new-gates n)" "plan revision rev-1000: plan_changed (task assigned)" "I id crosses 999"
assert_eq "$(revise TASK-934 plan_changed --actor dev --reason d --no-new-gates n)" "plan revision rev-1001: plan_changed (task assigned)" "I and keeps growing"
validate "$D/status.yaml" || fail "I ids past 999 invalid: $(cat "$RUNS/validate.log")"

# --- C: concurrency, ownership fence, unreadable state ---
D="$(task TASK-940)"
for i in 1 2 3 4 5 6; do revise TASK-940 plan_changed --actor dev --reason "parallel $i" --no-new-gates n >/dev/null & done
wait
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY' || fail "C concurrent writers lost or duplicated a revision"
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time])
ids = s["revisions"].map { |r| r["id"] }
reasons = s["revisions"].map { |r| r["reason"] }.sort
abort "ids #{ids.inspect}" unless ids == %w[rev-001 rev-002 rev-003 rev-004 rev-005 rev-006]
abort "reasons #{reasons.inspect}" unless reasons == (1..6).map { |i| "parallel #{i}" }
abort "history" unless s["history"].count { |h| h["phase"].start_with?("plan revision ") } == 6
RUBY
D="$(task TASK-941)"
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-941 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$REVISE" TASK-941 plan_changed --actor dev --reason r --no-new-gates n >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced writer wrote status.yaml"
D="$(task TASK-942)"; printf 'task_id: TASK-942\nphase: [\n' > "$D/status.yaml"
expect_refusal 3 "corrupt status.yaml" TASK-942 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-943)"; printf 'revisions: not a list\n' >> "$D/status.yaml"
expect_refusal 3 "revisions not a list" TASK-943 plan_changed --actor dev --reason r --no-new-gates n
D="$(task TASK-944)"; printf 'completion_gates: []\n' >> "$D/status.yaml"
expect_refusal 3 "completion_gates not a map" TASK-944 scope_expanded --actor dev --reason r --gate g
D="$(task TASK-945)"; printf 'branches: []\n' >> "$D/status.yaml"
expect_refusal 3 "branches not a map" TASK-945 scope_expanded --actor dev --reason r --branch w:ready

# --- G: a revision builds exactly what the existing writers would ---
task TASK-950 >/dev/null
task TASK-951 >/dev/null
revise TASK-950 scope_expanded --actor pm --reason grew --gate prod_deploy:deploy_production --gate smoke \
  --branch wave_1:ready --branch "wave_2:blocked:ops: window" >/dev/null
ruby "$GATE" TASK-951 declare prod_deploy --actor pm --reason grew --requires-authorization deploy_production >/dev/null
ruby "$GATE" TASK-951 declare smoke --actor pm --reason grew >/dev/null
ruby "$BRANCH" TASK-951 declare wave_1 --actor pm --reason grew >/dev/null
ruby "$BRANCH" TASK-951 declare wave_2 --actor pm --reason grew --state blocked --waiting-for "ops: window" >/dev/null
strip_revision() {
  ruby -ryaml -rdate - "$1" <<'RUBY'
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time])
s.delete("revisions")
s["task_id"] = "TASK-X"
s["history"] = s["history"].reject { |h| h["phase"].start_with?("plan revision ") }
puts YAML.dump(s)
RUBY
}
strip_revision "$RUNS/TASK-950/status.yaml" > "$RUNS/g.rev"; normalize "$RUNS/g.rev" > "$RUNS/g.rev.n"
strip_revision "$RUNS/TASK-951/status.yaml" > "$RUNS/g.seq"; normalize "$RUNS/g.seq" > "$RUNS/g.seq.n"
diff -u "$RUNS/g.seq.n" "$RUNS/g.rev.n" || fail "G the revision writer's gates/branches/history differ from the existing writers'"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-910"
cp "$RUNS/TASK-910/status.yaml" "$RUNS/TASK-910/task.md" "$RUNS/TASK-910/authorization.yaml" "$RUNS/sync/TASK-910/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-910/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy (status, task, authorization) does not validate: $(cat "$RUNS/validate.log")"
D="$(task TASK-911 review)"
revise TASK-911 scope_expanded --actor dev --reason "grew" --gate production_backfill:production_backfill --branch wave_1:ready >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s.delete("revisions"); File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without revisions (as after a revert) invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-911; then fail "S after a revert the revision's gate no longer blocks done"; fi

echo "[PASS] plan-revisions: plan revision record (#28 Phase 2A)"
