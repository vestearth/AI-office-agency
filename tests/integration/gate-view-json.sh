#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2F — the gate view as JSON, for the dashboard.
#
# scripts/gate-view-json.rb <task_dir> prints CompletionGuard.gate_view plus each
# gate's CLI text ("detail"), read-only, and always exits 0: a view it cannot
# build is readable=false with the problem, never an empty "all clear".
# Sections: G1 fields, G2 parity with the CLI text, G3 unreadable ledger,
# G4 unreadable view, G5 finished task, G6 garbage input, G7 read-only,
# G8 hand-written gates.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
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
VIEW_JSON="$ROOT/scripts/gate-view-json.rb"
TEXT="$ROOT/scripts/gate-status-text.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
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
# set_gate <status.yaml> <gate> <ruby hash literal> — hand-edit one gate record (stored-state cases).
set_gate() {
  ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time])
    (s["completion_gates"] ||= {})[ARGV[1]] = eval(ARGV[2]); File.write(p, YAML.dump(s))' "$1" "$2" "$3"
}
# run_json <dir> — runs the script; fails unless it exits 0 with one JSON object on stdout.
run_json() {
  local rc=0
  ruby "$VIEW_JSON" "$1" >"$RUNS/out.json" 2>"$RUNS/err.txt" || rc=$?
  assert_eq "$rc" "0" "exit code for $1 ($(cat "$RUNS/err.txt"))"
  ruby -rjson -e 'v = JSON.parse(File.read(ARGV[0])); exit(v.is_a?(Hash) ? 0 : 1)' "$RUNS/out.json" || fail "not a JSON object for $1: $(cat "$RUNS/out.json")"
}
# jv <dir> <ruby expression over j (the JSON) and g.(name)> — prints the result (JSON for non-strings).
jv() {
  run_json "$1"
  ruby -rjson - "$RUNS/out.json" "$2" <<'RUBY'
j = JSON.parse(File.read(ARGV[0]))
g = ->(name) { j["gates"].find { |x| x["name"] == name } }
r = eval(ARGV[1])
puts(r.is_a?(String) ? r : JSON.generate(r))
RUBY
}
# parity <dir> — every gate's "  name: status — detail" equals the CLI line, in order.
parity() {
  run_json "$1"
  ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0]))
    j["gates"].each { |x| puts "  #{x["name"]}: #{x["status"]}#{x["detail"].empty? ? "" : " #{[0x2014].pack("U")} #{x["detail"]}"}" }' "$RUNS/out.json" > "$RUNS/p-json.txt"
  ruby "$TEXT" "$1" | grep '^  ' > "$RUNS/p-cli.txt" || true
  diff -u "$RUNS/p-cli.txt" "$RUNS/p-json.txt" || fail "G2 parity for $1"
}
PASSED='"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []'

# --- G1: every field of the view, plus the CLI detail ---
D="$(task TASK-1501)"
gate TASK-1501 declare a --actor pm --reason a >/dev/null
gate TASK-1501 declare b --actor pm --reason b --after a >/dev/null
gate TASK-1501 declare c --actor pm --reason c --requires-authorization deploy_staging >/dev/null
gate TASK-1501 declare d --actor pm --reason d --requires-record >/dev/null
gate TASK-1501 declare e --actor pm --reason e >/dev/null
gate TASK-1501 pass e --actor dev-2 --reason merged --ran-by operator --ran-ref 05fae97f >/dev/null
set_gate "$D/status.yaml" f "{$PASSED, \"requires_record\" => true}"
gate TASK-1501 declare u --actor pm --reason u >/dev/null
gate TASK-1501 pass u --actor devops --reason deployed --ran-by operator --ran-url https://example.test/run/1 >/dev/null
assert_eq "$(jv "$D" 'j.keys.sort')" '["finished_phase","gates","problem","readable","summary"]' "G1 top-level keys"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem", "finished_phase")')" '[true,null,null]' "G1 readable"
assert_eq "$(jv "$D" 'j["gates"].map { |x| x["name"] }.join(",")')" "a,b,c,d,e,f,u" "G1 stored order"
assert_eq "$(jv "$D" 'g.("a").keys.sort')" '["detail","grant","name","passable","ran","requires_authorization","requires_record","resolved","status","unresolved_reason","waits_on"]' "G1 gate keys"
assert_eq "$(jv "$D" 'g.("a").values_at("status", "resolved", "passable", "waits_on", "detail")')" '["pending",false,true,[],"can pass now"]' "G1 passable"
assert_eq "$(jv "$D" 'g.("b").values_at("passable", "waits_on", "detail")')" '[false,["a (pending)"],"waits on a (pending)"]' "G1 waits on"
assert_eq "$(jv "$D" 'g.("c").values_at("requires_authorization", "grant", "passable", "detail")')" '["deploy_staging","missing",false,"waits for a deploy_staging grant"]' "G1 bound without a grant"
assert_eq "$(jv "$D" 'g.("d").values_at("requires_record", "detail")')" '[true,"can pass now (needs --ran-by and --ran-ref/--ran-url)"]' "G1 needs a record"
assert_eq "$(jv "$D" 'g.("e").values_at("resolved", "ran", "detail")')" '[true,{"by":"operator","ref":"05fae97f"},"ran: operator 05fae97f"]' "G1 recorded pass"
assert_eq "$(jv "$D" 'g.("f").values_at("resolved", "unresolved_reason", "detail")')" '[false,"missing ran record","NOT resolved: missing ran record"]' "G1 pass missing its record"
assert_eq "$(jv "$D" 'g.("u").values_at("ran", "detail")')" '[{"by":"operator","url":"https://example.test/run/1"},"ran: operator https://example.test/run/1"]' "G1 run url"
assert_eq "$(jv "$D" 'j["summary"]')" '{"total":7,"resolved":2,"passable":2,"by_status":{"pending":4,"pass":3}}' "G1 summary"

# --- G2: the detail is the CLI text, line for line ---
parity "$D"

# --- G3: an unreadable ledger is grant "unknown", and the view stays readable ---
D="$(task TASK-1503)"
gate TASK-1503 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
printf 'authorizations: [\n' > "$D/authorization.yaml"
assert_eq "$(jv "$D" '[j["readable"], g.("deploy")["grant"], g.("deploy")["detail"]]')" '[true,"unknown","waits for a deploy_staging grant (authorization ledger unreadable)"]' "G3 unreadable ledger"
parity "$D"

# --- G4: a view gate_view cannot build is readable=false, with no gates ---
D="$(task TASK-1504)"
printf 'completion_gates: oops\n' >> "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem", "finished_phase", "gates", "summary")')" '[false,"completion_gates is not a map",null,[],{"total":0,"resolved":0,"passable":0,"by_status":{}}]' "G4 non-map gates"

# --- G5: a finished task: nothing is passable, and the detail says why ---
D="$(task TASK-1505 aborted)"
set_gate "$D/status.yaml" smoke '{"status" => "pending", "actor" => "pm", "reason" => "s", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []}'
assert_eq "$(jv "$D" '[j["finished_phase"], g.("smoke")["passable"], g.("smoke")["detail"]]')" '["aborted",false,"task is aborted"]' "G5 finished task"
parity "$D"

# --- G6: garbage input still prints a readable=false object and exits 0 ---
assert_eq "$(jv "$RUNS/TASK-1599" 'j.values_at("readable", "problem", "gates")')" '[false,"gate view failed: Errno::ENOENT",[]]' "G6 missing task dir"
D="$(task TASK-1506)"
printf 'phase: [\n' > "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem")')" '[false,"gate view failed: Psych::SyntaxError"]' "G6 unparseable status.yaml"
printf 'just a string\n' > "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem")')" '[false,"status.yaml is not a map"]' "G6 non-map status"
assert_eq "$(jv "$D" 'j.keys.sort')" '["finished_phase","gates","problem","readable","summary"]' "G6 keeps every top-level key"
# Non-ASCII text survives without a locale (the dashboard may spawn ruby with LANG unset).
D="$(task TASK-1507)"
gate TASK-1507 declare smoke --actor pm --reason "ทดสอบ" >/dev/null
gate TASK-1507 pass smoke --actor devops --reason "ผ่าน" --ran-by "ผู้ทดสอบ" --ran-ref abc >/dev/null
env -u LANG -u LC_ALL -u LC_CTYPE ruby "$VIEW_JSON" "$D" > "$RUNS/thai.json"
assert_eq "$(ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0], encoding: "UTF-8")); print j["gates"][0]["ran"]["by"]' "$RUNS/thai.json")" "ผู้ทดสอบ" "G6 non-ASCII text with LANG unset"

# --- G8: hand-written gates (the TASK-EAR-385 shape: no actor, no updated_at) still read ---
D="$(task TASK-1508 in_review)"
set_gate "$D/status.yaml" persistence '{"status" => "pending", "reason" => "reviewer sign-off pending"}'
set_gate "$D/status.yaml" staging '{"status" => "pending", "reason" => "partial smoke"}'
assert_eq "$(jv "$D" '[j["readable"], j["gates"].map { |x| [x["name"], x["passable"], x["detail"]] }]')" '[true,[["persistence",true,"can pass now"],["staging",true,"can pass now"]]]' "G8 hand-written pending gates"
parity "$D"

# --- G7: read-only ---
D="$RUNS/TASK-1501"
before="$(find "$D" -type f -exec shasum {} + | sort)"
run_json "$D"
after="$(find "$D" -type f -exec shasum {} + | sort)"
assert_eq "$after" "$before" "G7 the task directory is unchanged"

SUITE_DONE=1
echo "[PASS] gate-view-json: the gate view as JSON (#28 Phase 2F)"
