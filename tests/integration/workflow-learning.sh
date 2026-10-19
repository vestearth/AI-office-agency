#!/usr/bin/env bash
# Issue #58 (workflow learning), step 0: defect_class on debugger/reviewer
# outputs, and the read-only post-run collector (scripts/learning-collector.rb).
#
# The collector must count only structured rework signals (a transition INTO
# debugging, a classified failure) — never `in_review -> in_review`, which is
# mostly progress notes — and must never write anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COLLECTOR="$ROOT/scripts/learning-collector.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
TMP_DIR="$(mktemp -d)"
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$TMP_DIR"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT
fail() { echo "[FAIL] $*" >&2; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }

RUNS="$TMP_DIR/runs"
REVIEWS="$TMP_DIR/knowledge-reviews"
mkdir -p "$RUNS" "$REVIEWS/closeouts"
export AI_OFFICE_RUNS_DIR="$RUNS" AI_OFFICE_REVIEWS_DIR="$REVIEWS"

# status <task> <phase> <updated_at> <history phase>... — a minimal status.yaml.
status() {
  local task="$1" phase="$2" updated="$3"; shift 3
  mkdir -p "$RUNS/$task"
  {
    printf 'task_id: %s\nphase: %s\nstate: %s\niteration: 2\nupdated_at: "%s"\nhistory:\n' "$task" "$phase" "$phase" "$updated"
    for h in "$@"; do printf -- '- phase: "%s"\n  agent: dev\n  reason: x\n' "$h"; done
  } > "$RUNS/$task/status.yaml"
}

echo "== Fixture =="
status TASK-EAR-1 done 2026-10-10 "assigned -> in_review" "in_review -> debugging" "debugging -> in_review" "in_review -> done"
cat > "$RUNS/TASK-EAR-1/debugger-output.yaml" <<'YAML'
diagnosis:
  root_cause: a read failure was turned into an empty result
  defect_class: silent_fallback
  confidence: high
  affected_files:
    - path: Games-Labs-User/internal/adapter.go
      lines: "10-20"
YAML
printf 'review_verdict: approved\n' > "$RUNS/TASK-EAR-1/reviewer-output.yaml"
# Three progress notes on in_review must not count as rework.
status TASK-EAR-2 done 2026-10-11 "assigned -> in_review" "in_review -> in_review" "in_review -> in_review" "in_review -> in_review" "in_review -> done"
printf 'review_verdict: changes_requested\ndefect_class: silent_fallback\n' > "$RUNS/TASK-EAR-2/reviewer-output.yaml"
status TASK-VS-3 in_review 2026-09-01 "assigned -> in_review" "in_review -> debugging" "debugging -> in_review" "in_review -> debugging"
# An absolute path under the workspace root counts as its repository, not "Users".
cat > "$RUNS/TASK-VS-3/debugger-output.yaml" <<YAML
diagnosis:
  root_cause: unclassified diagnosis
  confidence: medium
  affected_files:
    - path: $(dirname "$ROOT")/slip-api/internal/x.go
      lines: 1
YAML
printf 'review_verdict: changes_requested\n' > "$RUNS/TASK-VS-3/reviewer-output.yaml"
mkdir -p "$RUNS/not-a-task"
printf 'task_id: TASK-EAR-2\nscope: s\n' > "$REVIEWS/closeouts/20261011T000000Z-s.yaml"

before="$(cd "$TMP_DIR" && find . -type f -exec shasum {} + | sort)"

echo "== Scenario 1: JSON counts structured signals only =="
json="$(ruby "$COLLECTOR" --json)"
j() { ruby -rjson -e 'v = JSON.parse(STDIN.read).dig(*ARGV.map { |k| k =~ /\A\d+\z/ ? k.to_i : k }); print(v.is_a?(String) ? v : JSON.generate(v))' "$@" <<<"$json"; }
assert_eq "$(j totals runs)" "3" "runs (non-task dirs ignored)"
assert_eq "$(j totals done)" "2" "done runs"
assert_eq "$(j by_prefix EAR runs_with_debugging)" "1" "EAR: only the run that entered debugging"
assert_eq "$(j by_prefix EAR debugging_cycles)" "1" "EAR: in_review -> in_review is not rework"
assert_eq "$(j by_prefix VS debugging_cycles)" "2" "VS: two entries into debugging"
assert_eq "$(j defect_classes silent_fallback tasks)" '["TASK-EAR-1","TASK-EAR-2"]' "class from debugger and reviewer, by task"
assert_eq "$(j recurring)" '["silent_fallback"]' "a class seen in 2+ distinct tasks is recurring"
assert_eq "$(j unclassified debugger)" '["TASK-VS-3"]' "debugger output without a class"
assert_eq "$(j unclassified reviewer_changes_requested)" '["TASK-VS-3"]' "changes_requested without a class"
assert_eq "$(j debugger_repos)" '{"Games-Labs-User":1,"slip-api":1}' "repos from affected_files"
assert_eq "$(j closeout done)" "2" "closeout: done runs"
assert_eq "$(j closeout missing)" '["TASK-EAR-1"]' "closeout: done run without a record or capture"

echo "== Scenario 2: --since filters on updated_at =="
assert_eq "$(ruby "$COLLECTOR" --json --since 2026-10-01 | ruby -rjson -e 'print JSON.parse(STDIN.read)["totals"]["runs"]')" "2" "--since drops the September run"
rc=0; ruby "$COLLECTOR" --since yesterday >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "2" "a malformed --since is a usage error"

echo "== Scenario 3: markdown report names the recurring class =="
md="$(ruby "$COLLECTOR")"
grep -qF "# Workflow learning report" <<<"$md" || fail "markdown heading: $md"
grep -qF "silent_fallback" <<<"$md" || fail "markdown lacks the recurring class"

echo "== Scenario 4: the collector never writes =="
after="$(cd "$TMP_DIR" && find . -type f -exec shasum {} + | sort)"
assert_eq "$after" "$before" "files under runs/ and knowledge-reviews/ are unchanged"

echo "== Scenario 5: validator accepts a known defect_class and rejects others =="
cp -R "$ROOT/runs/TASK-EAR-109" "$TMP_DIR/TASK-EAR-109"
V="$TMP_DIR/TASK-EAR-109"
ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0])); d["diagnosis"]["defect_class"] = ARGV[1]; File.write(ARGV[0], YAML.dump(d))' "$V/debugger-output.yaml" silent_fallback
ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0])); d["defect_class"] = ARGV[1]; File.write(ARGV[0], YAML.dump(d))' "$V/reviewer-output.yaml" missing_tests
ruby "$VALIDATOR" "$V" >"$TMP_DIR/v.log" 2>&1 || fail "known classes must validate: $(cat "$TMP_DIR/v.log")"
ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0])); d["diagnosis"]["defect_class"] = "bad_luck"; File.write(ARGV[0], YAML.dump(d))' "$V/debugger-output.yaml"
if ruby "$VALIDATOR" "$V" >"$TMP_DIR/v.log" 2>&1; then fail "an unknown debugger defect_class validated"; fi
grep -qF "diagnosis.defect_class" "$TMP_DIR/v.log" || fail "debugger error names the field: $(cat "$TMP_DIR/v.log")"
ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0])); d["diagnosis"].delete("defect_class"); File.write(ARGV[0], YAML.dump(d))' "$V/debugger-output.yaml"
ruby -ryaml -e 'd = YAML.safe_load(File.read(ARGV[0])); d["defect_class"] = "bad_luck"; File.write(ARGV[0], YAML.dump(d))' "$V/reviewer-output.yaml"
if ruby "$VALIDATOR" "$V" >"$TMP_DIR/v.log" 2>&1; then fail "an unknown reviewer defect_class validated"; fi
grep -qF ".defect_class" "$TMP_DIR/v.log" || fail "reviewer error names the field: $(cat "$TMP_DIR/v.log")"

echo "== Scenario 6: the collector and the validator share one enum =="
validator_enum="$(ruby -e 'src = File.read(ARGV[0], encoding: "UTF-8"); m = src.match(/^DEFECT_CLASSES\s*=\s*%w\[([^\]]*)\]/m) or abort("DEFECT_CLASSES missing"); print m[1].split.sort.join(",")' "$VALIDATOR")"
collector_enum="$(ruby "$COLLECTOR" --json | ruby -rjson -e 'print JSON.parse(STDIN.read)["classes"].sort.join(",")')"
assert_eq "$collector_enum" "$validator_enum" "collector reports the validator's classes"

SUITE_DONE=1
echo "[PASS] workflow-learning: defect_class and read-only collector (#58)"
