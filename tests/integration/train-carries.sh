#!/usr/bin/env bash
# Release-train membership: scripts/update-train-carries.rb writes status.yaml
# `carries` under the task lock; validate-yaml.rb checks its shape.
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
WRITER="$ROOT/scripts/update-train-carries.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

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
current_agent: devops
ready: false
blocked_on: []
waiting_for: ["operator approval to run prod"]
assignment:
  primary: devops
  parallel: false
history: []
YAML
}
expect_refusal() {
  local code="$1" what="$2"; shift 2
  set +e; ruby "$WRITER" "$@" >/dev/null 2>"$RUNS/err.log"; local rc=$?; set -e
  assert_eq "$rc" "$code" "$what (stderr: $(cat "$RUNS/err.log"))"
}
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }

task TASK-EAR-402; task TASK-EAR-389 done; task TASK-EAR-390 done
S="$RUNS/TASK-EAR-402/status.yaml"

ruby "$WRITER" TASK-EAR-402 add TASK-EAR-389 TASK-EAR-390 --actor devops --reason "operator added both" >/dev/null
assert_eq "$(yq "$S" 'data["carries"]')" '["TASK-EAR-389","TASK-EAR-390"]' "add writes carries in order"
assert_eq "$(yq "$S" 'data["history"].last.values_at("phase","agent","reason")')" '["carries: +TASK-EAR-389 +TASK-EAR-390","devops","operator added both"]' "history row"
assert_eq "$(yq "$S" 'data["history"].last["phase"].include?("->")')" 'false' "membership is not a phase transition"
assert_eq "$(yq "$S" 'data.key?("updated_at")')" 'false' "updated_at untouched (membership is not progress)"
grep -q "train_carries_updated" "$RUNS/TASK-EAR-402/meta.yaml" || fail "meta event missing"
validate "$S" || fail "carries status invalid: $(cat "$RUNS/validate.log")"

expect_refusal 2 "re-adding is refused" TASK-EAR-402 add TASK-EAR-389 --actor devops --reason r
expect_refusal 2 "unknown task refused" TASK-EAR-402 add TASK-EAR-999 --actor devops --reason r
expect_refusal 2 "self refused" TASK-EAR-402 add TASK-EAR-402 --actor devops --reason r
expect_refusal 2 "reason required" TASK-EAR-402 add TASK-EAR-390 --actor devops
expect_refusal 2 "removing a non-member refused" TASK-EAR-402 remove TASK-EAR-391 --actor devops --reason r

ruby "$WRITER" TASK-EAR-402 remove TASK-EAR-389 --actor devops --reason "pulled" >/dev/null
assert_eq "$(yq "$S" 'data["carries"]')" '["TASK-EAR-390"]' "remove keeps the rest"
ruby "$WRITER" TASK-EAR-402 remove TASK-EAR-390 --actor devops --reason "pulled" >/dev/null
assert_eq "$(yq "$S" 'data.key?("carries")')" 'false' "empty membership removes the key"
validate "$S" || fail "status without carries invalid: $(cat "$RUNS/validate.log")"

# A finished train is history: membership is frozen.
task TASK-EAR-363 done
expect_refusal 2 "terminal train refused" TASK-EAR-363 add TASK-EAR-389 --actor devops --reason r

# Validator: shape errors.
for bad in '[]' '["TASK-EAR-389","TASK-EAR-389"]' '["TASK-EAR-402"]' '["EAR-1"]'; do
  task TASK-EAR-500
  ruby -ryaml -rdate -rjson - "$RUNS/TASK-EAR-500/status.yaml" "$bad" <<'RUBY'
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
s["carries"] = JSON.parse(ARGV[1]).map { |id| id == "TASK-EAR-402" ? "TASK-EAR-500" : id }
File.write(ARGV[0], YAML.dump(s))
RUBY
  if validate "$RUNS/TASK-EAR-500/status.yaml"; then fail "validator accepted carries=$bad"; fi
  grep -q "carries" "$RUNS/validate.log" || fail "validator error for $bad does not name carries"
done

SUITE_DONE=1
echo "[PASS] train-carries: add/remove, refusals, terminal freeze, validator shape"
