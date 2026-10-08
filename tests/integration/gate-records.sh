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
