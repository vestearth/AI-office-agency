#!/usr/bin/env bash
# Scheduled follow-up check: scripts/update-check-after.rb writes status.yaml
# `check_after` under the task lock; validate-yaml.rb checks its shape.
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
WRITER="$ROOT/scripts/update-check-after.rb"
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
phase: ${2:-assigned}
state: ${2:-assigned}
iteration: 1
current_agent: devops
ready: true
blocked_on: []
waiting_for: []
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

task TASK-VS-054
S="$RUNS/TASK-VS-054/status.yaml"

ruby "$WRITER" TASK-VS-054 set --at 2026-10-29T01:00:00Z --what "daily digest sent after the prod deploy" \
  --actor devops --reason "post-deploy check" >/dev/null
assert_eq "$(yq "$S" 'data["check_after"]')" '{"at":"2026-10-29T01:00:00Z","what":"daily digest sent after the prod deploy"}' "set writes check_after"
assert_eq "$(yq "$S" 'data["check_after"]["at"].class.name')" '"String"' "at stays a string, never a YAML timestamp"
assert_eq "$(yq "$S" 'data["history"].last.values_at("phase","agent","reason")')" '["check_after: 2026-10-29T01:00:00Z","devops","post-deploy check"]' "history row"
assert_eq "$(yq "$S" 'data["history"].last["phase"].include?("->")')" 'false' "a scheduled check is not a phase transition"
assert_eq "$(yq "$S" 'data.key?("updated_at")')" 'false' "updated_at untouched (scheduling a check is not progress)"
grep -q "check_after_updated" "$RUNS/TASK-VS-054/meta.yaml" || fail "meta event missing"
validate "$S" || fail "check_after status invalid: $(cat "$RUNS/validate.log")"

# A date alone means midnight in the office's time zone; set replaces the earlier check.
ruby "$WRITER" TASK-VS-054 set --at 2026-11-02 --what "transfers 5xx stays flat" --actor devops --reason "moved" >/dev/null
assert_eq "$(yq "$S" 'data["check_after"]')" '{"at":"2026-11-02","what":"transfers 5xx stays flat"}' "set replaces"
validate "$S" || fail "date-only check_after invalid: $(cat "$RUNS/validate.log")"

expect_refusal 2 "what required" TASK-VS-054 set --at 2026-11-02 --actor devops --reason r
expect_refusal 2 "at required" TASK-VS-054 set --what w --actor devops --reason r
expect_refusal 2 "reason required" TASK-VS-054 set --at 2026-11-02 --what w --actor devops
expect_refusal 2 "time without zone refused" TASK-VS-054 set --at 2026-11-02T08:00:00 --what w --actor devops --reason r
expect_refusal 2 "not a calendar date refused" TASK-VS-054 set --at 2026-02-30 --what w --actor devops --reason r
expect_refusal 2 "clear takes no --at" TASK-VS-054 clear --at 2026-11-02 --actor devops --reason r

ruby "$WRITER" TASK-VS-054 clear --actor devops --reason "checked: digest sent" >/dev/null
assert_eq "$(yq "$S" 'data.key?("check_after")')" 'false' "clear removes the key"
assert_eq "$(yq "$S" 'data["history"].last["phase"]')" '"check_after: cleared"' "clear history row"
expect_refusal 2 "clearing nothing refused" TASK-VS-054 clear --actor devops --reason r
validate "$S" || fail "status without check_after invalid: $(cat "$RUNS/validate.log")"

# A finished task has nothing left to check.
task TASK-VS-053 done
expect_refusal 2 "terminal task refused" TASK-VS-053 set --at 2026-11-02 --what w --actor devops --reason r
expect_refusal 3 "unknown task refused" TASK-VS-999 set --at 2026-11-02 --what w --actor devops --reason r

# Validator: shape errors.
for bad in '"2026-11-02"' '{"at":"2026-11-02"}' '{"what":"w"}' '{"at":"soon","what":"w"}' \
  '{"at":"2026-11-02T08:00:00","what":"w"}' '{"at":"2026-11-02","what":" "}' '{"at":"2026-11-02","what":"w","by":"x"}'; do
  task TASK-VS-500
  ruby -ryaml -rdate -rjson - "$RUNS/TASK-VS-500/status.yaml" "$bad" <<'RUBY'
s = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
s["check_after"] = JSON.parse(ARGV[1])
File.write(ARGV[0], YAML.dump(s))
RUBY
  if validate "$RUNS/TASK-VS-500/status.yaml"; then fail "validator accepted check_after=$bad"; fi
  grep -q "check_after" "$RUNS/validate.log" || fail "validator error for $bad does not name check_after"
done

SUITE_DONE=1
echo "[PASS] check-after: set/replace/clear, refusals, terminal freeze, validator shape"
