#!/usr/bin/env bash
# Structured waits: scripts/update-waits-on.rb writes status.yaml `waits_on`
# under the task lock; validate-yaml.rb checks it; the unblock reconcile clears
# it together with waiting_for.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
# bash 3.2 can enter the EXIT trap with $?=0 after a set -u abort: completion is
# proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=
finish() {
  local rc=$?
  rm -rf "$RUNS"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
WRITER="$ROOT/scripts/update-waits-on.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
UNBLOCK="$ROOT/scripts/reconcile-blocked-status.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
yq() {
  ruby -ryaml -rdate -rjson - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
puts eval(ARGV[1]).to_json # rubocop:disable Security/Eval -- test helper over a temp file
RUBY
}
task() {
  local dir="$RUNS/$1"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: ${2:-blocked}
state: ${2:-blocked}
iteration: 1
current_agent: pm
ready: false
blocked_on: [${3:-}]
waiting_for: ["operator: approve running prod"]
assignment:
  primary: dev
  parallel: false
history: []
YAML
}
expect_refusal() {
  local what="$1"; shift
  set +e; ruby "$WRITER" "$@" >/dev/null 2>"$RUNS/err.log"; local rc=$?; set -e
  assert_eq "$rc" "2" "$what (stderr: $(cat "$RUNS/err.log"))"
}
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }

task TASK-EAR-402; task TASK-EAR-391
S="$RUNS/TASK-EAR-391/status.yaml"
ruby "$WRITER" TASK-EAR-391 add prod_run --ref TASK-EAR-402 --actor pm --reason "needs the Missions prod train" >/dev/null
ruby "$WRITER" TASK-EAR-391 add operator_decision --actor pm --reason "claim census scope" >/dev/null
assert_eq "$(yq "$S" 'data["waits_on"]')" '[{"kind":"prod_run","ref":"TASK-EAR-402"},{"kind":"operator_decision"}]' "add records kind and ref"
assert_eq "$(yq "$S" 'data["waiting_for"]')" '["operator: approve running prod"]' "prose waiting_for untouched"
assert_eq "$(yq "$S" '[data["phase"], data["ready"]]')" '["blocked",false]' "phase and ready untouched"
assert_eq "$(yq "$S" 'data.key?("updated_at")')" 'false' "updated_at untouched (a wait is not progress; the idle clock reads it)"
assert_eq "$(yq "$S" 'data["history"].last["phase"]')" '"waits_on: +operator_decision"' "history row, not a transition"
grep -q "waits_on_updated" "$RUNS/TASK-EAR-391/meta.yaml" || fail "meta event missing"
validate "$S" || fail "waits_on status invalid: $(cat "$RUNS/validate.log")"

expect_refusal "unknown kind" TASK-EAR-391 add coffee --actor pm --reason r
expect_refusal "duplicate kind/ref" TASK-EAR-391 add prod_run --ref TASK-EAR-402 --actor pm --reason r
expect_refusal "self ref" TASK-EAR-391 add prod_run --ref TASK-EAR-391 --actor pm --reason r
expect_refusal "missing ref task" TASK-EAR-391 add qa --ref TASK-EAR-999 --actor pm --reason r
expect_refusal "remove absent" TASK-EAR-391 remove qa --actor pm --reason r
expect_refusal "reason required" TASK-EAR-391 add qa --actor pm

ruby "$WRITER" TASK-EAR-391 remove operator_decision --actor pm --reason "decided" >/dev/null
assert_eq "$(yq "$S" 'data["waits_on"]')" '[{"kind":"prod_run","ref":"TASK-EAR-402"}]' "remove keeps the rest"

task TASK-EAR-363 done
expect_refusal "terminal task frozen" TASK-EAR-363 add qa --actor pm --reason r

# The unblock reconcile clears waits_on with waiting_for.
task TASK-EAR-500 done; task TASK-EAR-501 blocked '"TASK-EAR-500"'
ruby "$WRITER" TASK-EAR-501 add prod_run --actor pm --reason "upstream release" >/dev/null
ruby "$UNBLOCK" TASK-EAR-501 "$RUNS/TASK-EAR-501/status.yaml" "$RUNS" 2026-10-15 done in_review true true true >/dev/null
assert_eq "$(yq "$RUNS/TASK-EAR-501/status.yaml" '[data["phase"], data["waiting_for"], data.key?("waits_on")]')" '["assigned",[],false]' "unblock clears waits_on"

# Validator shape errors.
for bad in '[]' '[{"kind":"coffee"}]' '[{"kind":"qa","who":"x"}]' '[{"kind":"qa","ref":"EAR-1"}]' '[{"kind":"qa"},{"kind":"qa"}]' '["qa"]'; do
  task TASK-EAR-600
  ruby -ryaml -rdate -rjson - "$RUNS/TASK-EAR-600/status.yaml" "$bad" <<'RUBY'
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
s["waits_on"] = JSON.parse(ARGV[1])
File.write(ARGV[0], YAML.dump(s))
RUBY
  if validate "$RUNS/TASK-EAR-600/status.yaml"; then fail "validator accepted waits_on=$bad"; fi
  grep -q "waits_on" "$RUNS/validate.log" || fail "validator error for $bad does not name waits_on"
done

SUITE_DONE=1
echo "[PASS] waits-on: add/remove, refusals, terminal freeze, unblock clears, validator shape"
