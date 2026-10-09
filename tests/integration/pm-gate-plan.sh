#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2E — gate-aware roles.
#
# PM declares gates in pm-output.yaml (completion_gates); syncing the PM output
# declares them in status.yaml through the writer's record construction,
# add-only, refusing a conflicting plan (exit 6, routed to validation_failed).
# Role contracts carry a Completion gates rule and the dispatched prompt shows a
# COMPLETION GATES block. Sections: U shared helpers, V the PM output field,
# S the sync, D the run-agent.sh dispatch (exit 6 routing, prompt block),
# R the role contracts.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$RUNS"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
OWN="$ROOT/scripts/task-ownership.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
SYNC="$ROOT/scripts/sync-status-from-output.rb"
RUN_AGENT="$ROOT/run-agent.sh"

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

# --- U: shared helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
G = CompletionGuard
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
T = "2026-10-08T01:00:00Z"
check "after change", G.gate_after_change("b", %w[a c], actor: "pm", reason: "r", at: T),
      [{ "phase" => "gate b: after += a,c", "agent" => "pm", "reason" => "r", "at" => T }, "gate=b after+=a,c actor=pm"]
check "record change", G.gate_requires_record_change("b", actor: "pm", reason: "r", at: T),
      [{ "phase" => "gate b: requires_record", "agent" => "pm", "reason" => "r", "at" => T }, "gate=b requires_record actor=pm"]
check "transition details", G.gate_transition_details("b", "absent", "pending", "pm"), "gate=b absent->pending actor=pm"

check "valid plan", G.plan_gate_errors([{ "name" => "a", "reason" => "r" }, { "name" => "b", "reason" => "r", "after" => ["a"], "requires_record" => true, "requires_authorization" => "deploy_staging" }]), []
check "plan not a list", G.plan_gate_errors({}), ["completion_gates must be a list of gate plans"]
check "entry not a map", G.plan_gate_errors(["a"]), ["completion_gates[0] must be a map"]
check "bad name", G.plan_gate_errors([{ "name" => "Bad", "reason" => "r" }]), ["completion_gates[0].name must match /\\A[a-z][a-z0-9_]*\\z/"]
check "no reason", G.plan_gate_errors([{ "name" => "a" }]), ["completion_gates[0].reason must be a non-empty string"]
check "unknown key", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "status" => "pass" }]), ["completion_gates[0] has unknown field(s): status"]
check "duplicate name", G.plan_gate_errors([{ "name" => "a", "reason" => "r" }, { "name" => "a", "reason" => "r" }]), ["completion_gates lists gate a twice"]
check "after empty", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => [] }]), ["completion_gates[0].after must be a non-empty list of gate names"]
check "after self", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => ["a"] }]), ["completion_gates[0].after names the gate itself"]
check "after twice", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => %w[b b] }]), ["completion_gates[0].after lists a gate twice"]
check "bad action", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "requires_authorization" => "deploy_prod" }]),
      ["completion_gates[0].requires_authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}"]
check "record not true", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "requires_record" => false }]), ["completion_gates[0].requires_record must be true"]
check "plan cycle", G.plan_gate_errors([{ "name" => "a", "reason" => "r", "after" => ["b"] }, { "name" => "b", "reason" => "r", "after" => ["a"] }]),
      ["completion_gates.a.after creates a cycle through b"]
check "after naming a stored gate is not a plan error", G.plan_gate_errors([{ "name" => "b", "reason" => "r", "after" => ["stored"] }]), []

stored = { "a" => { "status" => "pass", "actor" => "dev", "reason" => "done", "updated_at" => T, "evidence_refs" => [] } }
plan = [{ "name" => "a", "reason" => "r" }, { "name" => "b", "reason" => "build", "after" => ["a"], "requires_record" => true }]
gates, changes, conflict = G.reconcile_gate_plan(stored, plan, actor: "pm", at: T)
check "declare: conflict", conflict, nil
check "declare: new gate", gates["b"], { "status" => "pending", "actor" => "pm", "reason" => "build", "updated_at" => T, "evidence_refs" => [], "after" => ["a"], "requires_record" => true }
check "declare: stored untouched", gates["a"], stored["a"]
check "declare: rows", changes.map { |row, _| row["phase"] }, ["gate b: absent -> pending"]
check "declare: details", changes.map { |_, details| details }, ["gate=b absent->pending actor=pm"]
check "declare: input not mutated", stored.keys, ["a"]
_, changes, conflict = G.reconcile_gate_plan(gates, plan, actor: "pm", at: T)
check "same plan is a no-op", [changes, conflict], [[], nil]
grown = [{ "name" => "a", "reason" => "r" }, { "name" => "c", "reason" => "c" }, { "name" => "b", "reason" => "more", "after" => %w[a c], "requires_record" => true }]
g2, changes, conflict = G.reconcile_gate_plan(gates, grown, actor: "pm", at: T)
check "add: rows", [conflict, changes.map { |row, _| row["phase"] }], [nil, ["gate c: absent -> pending", "gate b: after += c"]]
check "add: after appended", g2["b"]["after"], %w[a c]
pending_plain = { "d" => { "status" => "pending", "actor" => "pm", "reason" => "d", "updated_at" => T, "evidence_refs" => [] } }
g3, changes, conflict = G.reconcile_gate_plan(pending_plain, [{ "name" => "d", "reason" => "needs a record", "requires_record" => true }], actor: "pm", at: T)
check "add record", [conflict, changes.map { |row, _| row["phase"] }, g3["d"]["requires_record"]], [nil, ["gate d: requires_record"], true]
def conflict_of(gates, plan)
  CompletionGuard.reconcile_gate_plan(gates, plan, actor: "pm", at: T)[2]
end
check "conflict: binding changed", conflict_of(gates, [{ "name" => "b", "reason" => "x", "after" => ["a"], "requires_record" => true, "requires_authorization" => "deploy_staging" }]),
      "gate b: the plan changes requires_authorization (nil -> \"deploy_staging\")"
check "conflict: after dropped", conflict_of(gates, [{ "name" => "b", "reason" => "x", "requires_record" => true }]), "gate b: the plan drops after a"
check "conflict: record dropped", conflict_of(gates, [{ "name" => "b", "reason" => "x", "after" => ["a"] }]), "gate b: the plan drops requires_record"
check "conflict: adding to a passed gate", conflict_of(gates, [{ "name" => "a", "reason" => "x", "requires_record" => true }]), "gate a: the plan adds to a gate that is pass"
check "conflict: unknown after", conflict_of(gates, [{ "name" => "e", "reason" => "x", "after" => ["zz"] }]), "completion_gates.e.after names zz, which is not a declared gate"
check "conflict: cycle across plan and status", conflict_of(gates, [{ "name" => "a", "reason" => "x" }, { "name" => "f", "reason" => "x", "after" => ["b"] }, { "name" => "b", "reason" => "x", "after" => %w[a f], "requires_record" => true }]),
      "completion_gates.b.after creates a cycle through f"
check "conflict: stored gate not a map", conflict_of({ "a" => "oops" }, [{ "name" => "a", "reason" => "x" }]), "gate a is not a map"
RUBY

# --- V: the completion_gates field in PM output ---
# pm_output <TASK_ID> [completion_gates YAML] — a minimal valid PM output, optionally with a gate plan.
pm_output() {
  local file="$RUNS/$1/pm-output.yaml"
  mkdir -p "$RUNS/$1"
  cat > "$file" <<YAML
task:
  id: $1
  title: Profile statistics
  type: feature
  priority: medium
scope:
  target_services: []
description: Profile statistics endpoint
acceptance_criteria:
  - criterion: statistics are returned
plan:
  approach: implement and verify
assignment:
  primary: dev
  parallel: false
  reason: single service
summary: Plan the profile statistics work
artifacts: []
blockers: []
next_action:
  agent: dev
  reason: ready for implementation
YAML
  if [[ -n "${2:-}" ]]; then printf '%s\n' "$2" >> "$file"; fi
}
mkdir -p "$RUNS/v"
pm_output TASK-1500
validate "$RUNS/TASK-1500/pm-output.yaml" || fail "V a PM output without completion_gates no longer validates: $(cat "$RUNS/validate.log")"
pm_output TASK-1501 'completion_gates:
  - name: product_contract
    reason: contract locked with the operator
  - name: shared_lib_publication
    reason: Game and gateway consume the published contract
    after: [product_contract]
    requires_record: true
  - name: deploy
    reason: production deploy
    after: [shared_lib_publication]
    requires_authorization: deploy_production'
validate "$RUNS/TASK-1501/pm-output.yaml" || fail "V a valid gate plan was rejected: $(cat "$RUNS/validate.log")"
v_bad() { # <label> <completion_gates YAML> <message fragment>
  pm_output TASK-1502 "$2"
  if validate "$RUNS/TASK-1502/pm-output.yaml"; then fail "V $1 validated"; fi
  grep -qF "$3" "$RUNS/validate.log" || fail "V $1 message: $(cat "$RUNS/validate.log")"
}
v_bad not-a-list 'completion_gates: {}' "pm-output.yaml.completion_gates must be a list of gate plans"
v_bad bad-name 'completion_gates:
  - name: Bad
    reason: r' "pm-output.yaml.completion_gates[0].name must match"
v_bad no-reason 'completion_gates:
  - name: a' "pm-output.yaml.completion_gates[0].reason must be a non-empty string"
v_bad duplicate 'completion_gates:
  - {name: a, reason: r}
  - {name: a, reason: r}' "pm-output.yaml.completion_gates lists gate a twice"
v_bad self-after 'completion_gates:
  - {name: a, reason: r, after: [a]}' "pm-output.yaml.completion_gates[0].after names the gate itself"
v_bad cycle 'completion_gates:
  - {name: a, reason: r, after: [b]}
  - {name: b, reason: r, after: [a]}' "pm-output.yaml.completion_gates.a.after creates a cycle through b"
v_bad bad-action 'completion_gates:
  - {name: a, reason: r, requires_authorization: deploy_prod}' "pm-output.yaml.completion_gates[0].requires_authorization must be one of"
v_bad record-false 'completion_gates:
  - {name: a, reason: r, requires_record: false}' "pm-output.yaml.completion_gates[0].requires_record must be true"
v_bad unknown-key 'completion_gates:
  - {name: a, reason: r, status: pass}' "pm-output.yaml.completion_gates[0] has unknown field(s): status"

# --- S: syncing a PM gate plan ---
T0=2026-10-08T01:00:00Z
EAR384_PLAN='completion_gates:
  - name: product_contract
    reason: contract locked with the operator
  - name: shared_lib_publication
    reason: Game and gateway consume the published contract
    after: [product_contract]
    requires_record: true
  - name: implementation_verification
    reason: Game and gateway verified against the published contract
    after: [shared_lib_publication]
  - name: authenticated_staging
    reason: authenticated smoke on staging
    after: [implementation_verification]
    requires_authorization: deploy_staging'
# sync_pm <TASK_ID> — sync the task's pm-output.yaml as the PM, at T0; prints nothing, returns the exit code.
sync_pm() { AI_OFFICE_NOW=$T0 ruby "$SYNC" "$1" pm "$RUNS/$1/status.yaml" "$RUNS/$1/pm-output.yaml" 2026-10-08 in_review >"$RUNS/sync.log" 2>&1; }
gates_dump() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); print YAML.dump(s["completion_gates"])' "$1"; }
history_phases() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); puts Array(s["history"]).map { |h| h["phase"] }' "$1"; }
# EAR-384 shape: the whole plan lands in one sync, with the normal PM transition.
D="$(task TASK-1600 pending)"
pm_output TASK-1600 "$EAR384_PLAN"
sync_pm TASK-1600 || fail "S first sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "S the PM transition still happens"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.actor)" "pm" "S declared by pm"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.after)" "product_contract" "S after"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.requires_record)" "true" "S requires_record"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.requires_authorization)" "deploy_staging" "S binding"
assert_eq "$(history_phases "$D/status.yaml" | tr '\n' '|')" \
  "gate product_contract: absent -> pending|gate shared_lib_publication: absent -> pending|gate implementation_verification: absent -> pending|gate authenticated_staging: absent -> pending|pending -> assigned|" "S history rows"
assert_eq "$(grep -c 'type: completion_gate_updated' "$D/meta.yaml")" "4" "S one meta event per declared gate"
validate "$D/status.yaml" || fail "S synced status invalid: $(cat "$RUNS/validate.log")"
grep -qxF "  implementation_verification: pending — waits on shared_lib_publication (pending)" <<<"$(bash "$RUN_AGENT" status TASK-1600)" || fail "S status does not show the planned wait"
# The same gates as the writer would make, command by command.
D2="$(task TASK-1601 pending)"
AI_OFFICE_NOW=$T0 gate TASK-1601 declare product_contract --actor pm --reason "contract locked with the operator" >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare shared_lib_publication --actor pm --reason "Game and gateway consume the published contract" --after product_contract --requires-record >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare implementation_verification --actor pm --reason "Game and gateway verified against the published contract" --after shared_lib_publication >/dev/null
AI_OFFICE_NOW=$T0 gate TASK-1601 declare authenticated_staging --actor pm --reason "authenticated smoke on staging" --after implementation_verification --requires-authorization deploy_staging >/dev/null
assert_eq "$(gates_dump "$D/status.yaml")" "$(gates_dump "$D2/status.yaml")" "S the sync builds exactly the writer's gate records"
# A repeat of the same output is a no-op; a re-plan with the same gates changes no gate.
cp "$D/status.yaml" "$RUNS/s-before.yaml"
sync_pm TASK-1600 || fail "S repeat sync failed"
cmp -s "$D/status.yaml" "$RUNS/s-before.yaml" || fail "S repeating the same output changed status.yaml"
printf 'summary: Re-planned without gate changes\n' > "$RUNS/s-summary.yaml"
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["summary"] = "Re-planned"; File.write(p, YAML.dump(s))' "$D/pm-output.yaml"
before_gates="$(gates_dump "$D/status.yaml")"
sync_pm TASK-1600 || fail "S re-plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(gates_dump "$D/status.yaml")" "$before_gates" "S an unchanged plan changes no gate"
assert_eq "$(history_phases "$D/status.yaml" | grep -c '^gate ')" "4" "S an unchanged plan adds no gate history"
# A grown plan: a new gate, an added after, an added requires_record on a pending gate.
D="$(task TASK-1602 pending)"
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}
  - {name: b, reason: b, after: [a]}'
sync_pm TASK-1602 || fail "S grow setup failed: $(cat "$RUNS/sync.log")"
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}
  - {name: c, reason: c}
  - {name: b, reason: "b waits on c too", after: [a, c], requires_record: true}'
sync_pm TASK-1602 || fail "S grow sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a,c" "S after appended"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "S requires_record added"
assert_eq "$(history_phases "$D/status.yaml" | grep '^gate ' | tr '\n' '|')" \
  "gate a: absent -> pending|gate b: absent -> pending|gate c: absent -> pending|gate b: after += c|gate b: requires_record|" "S grow rows"
# A gate the plan does not list is kept.
pm_output TASK-1602 'completion_gates:
  - {name: a, reason: a}'
sync_pm TASK-1602 || fail "S partial plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.status)" "pending" "S an unlisted gate is kept"
# Conflicts: exit 6, status.yaml and meta.yaml untouched.
D="$(task TASK-1603 pending)"
gate TASK-1603 declare a --actor pm --reason a >/dev/null
gate TASK-1603 declare b --actor pm --reason b --after a --requires-record >/dev/null
gate TASK-1603 declare p --actor pm --reason p >/dev/null
gate TASK-1603 pass p --actor reviewer --reason done >/dev/null
s_conflict() { # <label> <completion_gates YAML> <message fragment>
  pm_output TASK-1603 "$2"
  cp "$RUNS/TASK-1603/status.yaml" "$RUNS/c-status.before"; cp "$RUNS/TASK-1603/meta.yaml" "$RUNS/c-meta.before"
  rc=0; sync_pm TASK-1603 || rc=$?
  assert_eq "$rc" "6" "S conflict $1 exit ($(cat "$RUNS/sync.log"))"
  grep -qF "$3" "$RUNS/sync.log" || fail "S conflict $1 message: $(cat "$RUNS/sync.log")"
  cmp -s "$RUNS/TASK-1603/status.yaml" "$RUNS/c-status.before" || fail "S conflict $1 wrote status.yaml"
  cmp -s "$RUNS/TASK-1603/meta.yaml" "$RUNS/c-meta.before" || fail "S conflict $1 wrote meta.yaml"
}
s_conflict binding 'completion_gates:
  - {name: b, reason: x, after: [a], requires_record: true, requires_authorization: deploy_staging}' "gate b: the plan changes requires_authorization"
s_conflict after-dropped 'completion_gates:
  - {name: b, reason: x, requires_record: true}' "gate b: the plan drops after a"
s_conflict record-dropped 'completion_gates:
  - {name: b, reason: x, after: [a]}' "gate b: the plan drops requires_record"
s_conflict passed 'completion_gates:
  - {name: p, reason: x, requires_record: true}' "gate p: the plan adds to a gate that is pass"
s_conflict unknown-after 'completion_gates:
  - {name: e, reason: x, after: [zz]}' "completion_gates.e.after names zz, which is not a declared gate"
s_conflict cycle 'completion_gates:
  - {name: f, reason: x, after: [b]}
  - {name: a, reason: x, after: [f]}' "creates a cycle through"
# A malformed plan reaching the sync directly is malformed output (exit 3).
pm_output TASK-1603 'completion_gates: {}'
rc=0; sync_pm TASK-1603 || rc=$?
assert_eq "$rc" "3" "S malformed plan exit"
# Review Focus: an empty plan is valid and declares nothing.
D="$(task TASK-1610 pending)"
pm_output TASK-1610 'completion_gates: []'
validate "$D/pm-output.yaml" || fail "RF empty plan rejected: $(cat "$RUNS/validate.log")"
sync_pm TASK-1610 || fail "RF empty plan sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "RF an empty plan declares nothing"
# Review Focus: `after` may name a gate listed later in the same plan.
D="$(task TASK-1611 pending)"
pm_output TASK-1611 'completion_gates:
  - {name: b, reason: b, after: [c]}
  - {name: c, reason: c}'
sync_pm TASK-1611 || fail "RF forward reference sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "c" "RF forward reference"
# Review Focus: re-syncing an unchanged plan after a gate passed is not a conflict.
gate TASK-1611 pass c --actor dev --reason done >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["summary"] = "after c passed"; File.write(p, YAML.dump(s))' "$D/pm-output.yaml"
sync_pm TASK-1611 || fail "RF re-sync after a pass failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.status)" "pass" "RF the passed gate is untouched"
# Review Focus: a non-PM output carrying completion_gates is ignored.
D="$(task TASK-1612)"
cat > "$D/dev-output.yaml" <<'YAML'
summary: implemented
artifacts: []
blockers: []
next_action:
  agent: reviewer
  reason: ready for review
completion_gates:
  - {name: sneaky, reason: not the PM}
YAML
AI_OFFICE_NOW=$T0 ruby "$SYNC" TASK-1612 dev "$D/status.yaml" "$D/dev-output.yaml" 2026-10-08 in_review >"$RUNS/sync.log" 2>&1 || fail "RF dev sync failed: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates)" "" "RF a dev output cannot declare gates"
# Review Focus: after a refused plan, a corrected plan applies.
D="$(task TASK-1613 pending)"
gate TASK-1613 declare b --actor pm --reason b --requires-record >/dev/null
pm_output TASK-1613 'completion_gates:
  - {name: b, reason: x}'
rc=0; sync_pm TASK-1613 || rc=$?
assert_eq "$rc" "6" "RF setup: the first plan conflicts"
pm_output TASK-1613 'completion_gates:
  - {name: b, reason: x, requires_record: true}
  - {name: c, reason: c, after: [b]}'
sync_pm TASK-1613 || fail "RF the corrected plan did not apply: $(cat "$RUNS/sync.log")"
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "b" "RF corrected plan applied"

# --- D: run-agent.sh routes a conflicting gate plan (exit 6) to validation_failed ---
# A stub codex "runs" the PM by copying a prepared output into place, so the
# driver syncs it exactly as it would a real run.
STUB_BIN="$RUNS/stub-bin"; mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/codex" <<'SH'
#!/usr/bin/env bash
cp "$STUB_OUTPUT_SRC" "$STUB_OUTPUT_DST"
SH
chmod +x "$STUB_BIN/codex"
# dispatch_pm <TASK_ID> <prepared pm-output> — dispatch the PM through the stub; output in $RUNS/dispatch.log.
dispatch_pm() {
  STUB_OUTPUT_SRC="$2" STUB_OUTPUT_DST="$RUNS/$1/pm-output.yaml" PATH="$STUB_BIN:/usr/bin:/bin" \
    bash "$RUN_AGENT" "$1" pm codex >"$RUNS/dispatch.log" 2>&1
}
D="$(task TASK-1700 pending)"
gate TASK-1700 declare b --actor pm --reason b --requires-record >/dev/null
pm_output TASK-1799 'completion_gates:
  - {name: b, reason: x}'
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["task"]["id"] = "TASK-1700"; File.write(p, YAML.dump(s))' "$RUNS/TASK-1799/pm-output.yaml"
cp "$RUNS/TASK-1799/pm-output.yaml" "$RUNS/d-plan.yaml"; rm -rf "$RUNS/TASK-1799"
dispatch_pm TASK-1700 "$RUNS/d-plan.yaml" || fail "D dispatch failed: $(tail -5 "$RUNS/dispatch.log")"
grep -q "gate b: the plan drops requires_record" "$RUNS/dispatch.log" || fail "D the conflict is not reported: $(cat "$RUNS/dispatch.log")"
assert_eq "$(field "$D/status.yaml" phase)" "validation_failed" "D a conflicting gate plan routes to validation_failed"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "D the stored gate is untouched"
grep -q "reason=gate_plan_conflict" "$D/meta.yaml" || fail "D validation_failed meta event"
grep -qF "gate plan conflicts with status.yaml: gate b: the plan drops requires_record" "$D/status.yaml" || fail "D the conflict message is not in the status.yaml history reason"
grep -qF 'conflict="gate b: the plan drops requires_record"' "$D/meta.yaml" || fail "D the conflict message is not in the validation_failed meta event"

# --- P: the COMPLETION GATES block in the dispatched prompt ---
# The interactive cursor runner (absent from PATH) writes the assembled prompt to
# .cursor-prompt.md and stops, so a dispatch here only assembles and records.
dispatch_prompt() { # <TASK_ID> — dispatch dev through cursor; the prompt lands in runs/<TASK>/.cursor-prompt.md
  PATH="/usr/bin:/bin" bash "$RUN_AGENT" "$1" dev cursor >"$RUNS/prompt-dispatch.log" 2>&1 || fail "P dispatch failed: $(tail -5 "$RUNS/prompt-dispatch.log")"
}
# A task with gates: the block follows STATUS and carries the status-view lines.
D="$(task TASK-1800)"
for g in product_contract shared_lib_publication implementation_verification authenticated_staging; do gate TASK-1800 declare "$g" --actor pm --reason intake >/dev/null; done
gate TASK-1800 depend implementation_verification --after shared_lib_publication --actor pm --reason order >/dev/null
gate TASK-1800 depend authenticated_staging --after implementation_verification --actor pm --reason order >/dev/null
gate TASK-1800 pass product_contract --actor dev-2 --reason locked >/dev/null
gate TASK-1800 pass shared_lib_publication --actor dev-2 --reason merged --ran-by operator --ran-ref 05fae97f >/dev/null
dispatch_prompt TASK-1800
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); i = p.index("\n--- COMPLETION GATES ---\n", p.index("\n--- STATUS ---\n") || 0) or abort "no block"; i += 1; j = p.index("--- OUTPUT PERSISTENCE REQUIREMENT ---"); print p[i...j]' "$D/.cursor-prompt.md" > "$RUNS/p-block.txt" \
  || fail "P the prompt has no COMPLETION GATES block"
cat > "$RUNS/p-expected.txt" <<'TXT'
--- COMPLETION GATES ---
Gates: 2/4 resolved
  product_contract: pass
  shared_lib_publication: pass — ran: operator 05fae97f
  implementation_verification: pending — can pass now
  authenticated_staging: pending — waits on implementation_verification (pending)
Revisions: none

TXT
diff -u "$RUNS/p-expected.txt" "$RUNS/p-block.txt" || fail "P COMPLETION GATES block"
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); abort "order" unless p.index("\n--- STATUS ---\n") < p.index("\n--- COMPLETION GATES ---\n")' "$D/.cursor-prompt.md" || fail "P block must follow STATUS"
# A task without gates: everything after the role contract is byte-identical to the pre-2E prompt.
mkdir -p "$RUNS/TASK-1400"
printf 'task_id: TASK-1400\nphase: assigned\nstate: assigned\niteration: 1\ncurrent_agent: dev\nready: true\nblocked_on: []\nwaiting_for: []\nassignment:\n  primary: dev\n  parallel: false\nupdated_at: "2026-10-01"\nhistory: []\n' > "$RUNS/TASK-1400/status.yaml"
printf '# TASK-1400\n\nDocs-only probe task.\n' > "$RUNS/TASK-1400/task.md"
dispatch_prompt TASK-1400
ruby -e 'p = File.read(ARGV[0], encoding: "UTF-8"); i = p.index("--- AI CONTEXT INDEX ---") or abort "x"; print p[i..-1].gsub(ARGV[1], "<RUNS>").gsub(ARGV[2], "<OFFICE>")' "$RUNS/TASK-1400/.cursor-prompt.md" "$RUNS" "$ROOT" > "$RUNS/n-prompt.txt"
cat > "$RUNS/n-prompt-expected.txt" <<'TXT'
--- AI CONTEXT INDEX ---
provider: socraticode
status: skipped
freshness: unknown
confidence: low
fallback: repo_search
queries:
  - "dev TASK-1400"
note: "Context lookup skipped because this task is not code-impacting."

--- TASK ---
# TASK-1400

Docs-only probe task.
--- STATUS ---
task_id: TASK-1400
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
updated_at: "2026-10-01"
history: []

--- OUTPUT PERSISTENCE REQUIREMENT ---
Before you finish, write the complete, valid YAML output to this exact path:
<RUNS>/TASK-1400/dev-output.yaml
Overwrite the prior artifact for this role if one exists. Do not merely print the
YAML or verdict in your terminal response: the orchestrator reads the file above
for its handoff. After writing it, validate it with:
ruby "<OFFICE>/validate-yaml.rb" "<RUNS>/TASK-1400/dev-output.yaml"

Produce your output following the Output Contract in your role definition.
TXT
diff -u "$RUNS/n-prompt-expected.txt" "$RUNS/n-prompt.txt" || fail "P a task without gates changed its prompt"
# The renderer as a script: nothing for a gateless task, "Gates: unavailable" when the task cannot be rendered.
assert_eq "$(ruby "$ROOT/scripts/gate-status-text.rb" "$RUNS/TASK-1400")" "" "P no output for a task without gates"
mkdir -p "$RUNS/TASK-1801"; printf 'task_id: [\n' > "$RUNS/TASK-1801/status.yaml"
assert_eq "$(ruby "$ROOT/scripts/gate-status-text.rb" "$RUNS/TASK-1801")" "Gates: unavailable" "P an unrenderable task"

# --- R: every role contract carries the Completion gates rule ---
for role in pm dev dev-2 devops reviewer; do
  f="$ROOT/agents/$role.md"
  section="$(ruby -e 's = File.read(ARGV[0], encoding: "UTF-8"); i = s.index("### Completion gates") or exit 1; j = s.index("## Exit Criteria", i) or exit 1; print s[i...j]' "$f")" \
    || fail "R agents/$role.md has no Completion gates rule before Exit Criteria"
  grep -qF "scripts/update-completion-gate.rb" <<<"$section" || fail "R agents/$role.md does not name the gate writer"
  grep -qF "docs/completion-gates.md" <<<"$section" || fail "R agents/$role.md does not link the gate docs"
  grep -qiF "never hand-edit" <<<"$section" || fail "R agents/$role.md does not forbid hand edits"
done
grep -qF -- "--ran-by" "$ROOT/agents/dev.md" || fail "R dev.md does not show --ran-*"
grep -qF -- "--ran-by" "$ROOT/agents/dev-2.md" || fail "R dev-2.md does not show --ran-*"
grep -qF -- "--authorization authz-NNN" "$ROOT/agents/devops.md" || fail "R devops.md does not show --authorization"
grep -qF "COMPLETION GATES" "$ROOT/agents/reviewer.md" || fail "R reviewer.md does not point at the prompt block"
grep -qF 'the verdict is still `approved`' "$ROOT/agents/reviewer.md" || fail "R reviewer.md does not say how to approve while other roles still own open gates"
grep -qF "only for a gate bound to an action" "$ROOT/agents/devops.md" || fail "R devops.md presents --authorization as unconditional"
ruby -ryaml -e 's = File.read(ARGV[0], encoding: "UTF-8"); i = s.index("## Output Contract"); j = s.index("## SocratiCode"); y = s[i...j][/```yaml\n(.*?)```/m, 1] or abort "no yaml"; abort "no completion_gates in the contract example" unless y.include?("completion_gates:")' "$ROOT/agents/pm.md" \
  || fail "R pm.md Output Contract example lacks completion_gates"

SUITE_DONE=1
echo "[PASS] pm-gate-plan: gate-aware roles (#28 Phase 2E)"
