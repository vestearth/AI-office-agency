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

echo "[PASS] gate-status: gate status view (#28 Phase 2D)"
