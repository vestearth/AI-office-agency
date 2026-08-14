#!/usr/bin/env bash
# Independent, evidence-first, risk-based review (issue #12).
#
# Covers the deterministic risk classifier, the depth it selects, and the
# evidence policy in BOTH modes: warn_only (default — records the gap, never
# blocks) and required (an unbacked or split-state `pass` makes `approved`
# unreachable). Also pins that the four existing verdicts still route as before.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECORD="$ROOT/scripts/record-evidence.sh"
VALIDATOR="$ROOT/validate-yaml.rb"
GATE="$ROOT/scripts/review-gate.rb"
CLASSIFY="$ROOT/scripts/classify-risk.rb"
RUN_AGENT="$ROOT/run-agent.sh"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-912"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"

# Evidence is recorded from a throwaway CLEAN repo: a record taken against the
# checkout this test runs in would be working_tree_dirty and fail its own gate.
WORK_REPO="$TMP_RUNS/work-repo"
mkdir -p "$WORK_REPO"
(
  cd "$WORK_REPO"
  git init -q .
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
) >/dev/null
WORK_SHA="$(cd "$WORK_REPO" && git rev-parse HEAD)"

ROUTE_TASK="TASK-RE$$"
ROUTE_DIR="$ROOT/runs/$ROUTE_TASK"
BIN="$(mktemp -d)"

cleanup() { rm -rf "$TMP_RUNS" "$ROUTE_DIR" "$BIN"; }
trap cleanup EXIT

fail() {
  echo "[FAIL] $1"
  exit 1
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"
}

expect_valid() {
  local out
  out="$(ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" || fail "$1 (got: $out)"
}

# $1 = message, $2 = substring the failure must mention
expect_invalid() {
  local out
  out="$(ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" && fail "$1 (validation unexpectedly passed)"
  grep -q "$2" <<<"$out" || fail "$1 (expected the error to mention '$2', got: $out)"
}

cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
YAML

# $1 = verdict, $2 = artifact path, $3 = evidence_refs inline list,
# $4 = compile value, $5 = extra top-level YAML (may be empty)
write_reviewer_output() {
  local next
  case "$1" in
    approved) next="done" ;;
    changes_requested) next="debugger" ;;
    escalate) next="free-roam" ;;
    *) next="devops" ;;
  esac
  cat > "$TASK_DIR/reviewer-output.yaml" <<YAML
summary: "Reviewed."
artifacts:
  - path: $2
next_action:
  agent: $next
  reason: "Verdict $1."
blockers: []
review_verdict: $1
build_check:
  compile: $4
  tests: pass
  details: "recorded"
evidence_refs: $3
${5:-}
YAML
}

echo "== Risk rules are deterministic and low risk pays nothing =="
assert_eq "high" "$(ruby "$CLASSIFY" "$ROOT" internal/auth/token.go)" "an auth path classifies high"
assert_eq "high" "$(ruby "$CLASSIFY" "$ROOT" .github/workflows/ci.yml)" "a CI workflow classifies high"
assert_eq "high" "$(ruby "$CLASSIFY" "$ROOT" db/migrations/007_add_column.sql)" "a migration classifies high"
assert_eq "high" "$(ruby "$CLASSIFY" "$ROOT" services/wallet/debit.go)" "a wallet path classifies high"
assert_eq "medium" "$(ruby "$CLASSIFY" "$ROOT" go.mod)" "a dependency manifest classifies medium"
assert_eq "low" "$(ruby "$CLASSIFY" "$ROOT" docs/notes.md README.md)" "docs classify low"
assert_eq "high" "$(ruby "$CLASSIFY" "$ROOT" docs/notes.md internal/auth/token.go)" "the highest match wins"
ruby "$CLASSIFY" "$ROOT" --explain docs/notes.md | grep -q "require_evidence=false" \
  || fail "a low-risk change must not require evidence"
ruby "$CLASSIFY" "$ROOT" --explain internal/auth/token.go | grep -q "required_checks=compile,tests" \
  || fail "a high-risk change must require compile and tests"

echo "== required: approval WITH valid evidence passes =="
EV1="$(cd "$WORK_REPO" && "$RECORD" "$TASK" --type build -- true)"
EV2="$(cd "$WORK_REPO" && "$RECORD" "$TASK" --type test -- true)"
assert_eq "ev-001" "$EV1" "first evidence id"
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" pass "risk_level: high"
export OFFICE_EVIDENCE_POLICY_MODE=required
expect_valid "approved with in-sync evidence must validate under required"

echo "== required: approval with NO evidence is blocked =="
write_reviewer_output approved internal/auth/token.go "[]" pass "risk_level: high"
expect_invalid "approved without evidence must fail under required" "no evidence_refs"

echo "== warn_only: the same output is recorded, not blocked =="
OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$VALIDATOR" "$TASK_DIR" >"$TMP_RUNS/warn.out" 2>"$TMP_RUNS/warn.err"
assert_eq "0" "$?" "warn_only must not block approval"
assert_eq "Validation passed: $TASK_DIR" "$(cat "$TMP_RUNS/warn.out")" "warn_only stdout is unchanged"
assert_eq "" "$(cat "$TMP_RUNS/warn.err")" "warn_only writes nothing to stderr (byte-identical output for old runs)"

gate_out="$(OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$GATE" "$TASK" 2>&1)"
assert_eq "0" "$?" "the gate is non-blocking under warn_only"
grep -q "mode=warn_only" <<<"$gate_out" || fail "gate must report the mode, got: $gate_out"
grep -q "risk_level=high" <<<"$gate_out" || fail "gate must report the risk level, got: $gate_out"
grep -q "gaps=1" <<<"$gate_out" || fail "gate must still RECORD the gap under warn_only, got: $gate_out"

blocking_out="$(ruby "$GATE" "$TASK" 2>&1)" && fail "the gate must be blocking under required"
grep -q "mode=required" <<<"$blocking_out" || fail "gate must report required, got: $blocking_out"

echo "== required: evidence that does not describe one reviewed state is blocked =="
cp "$TASK_DIR/evidence.yaml" "$TMP_RUNS/evidence.yaml.bak"
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" pass "risk_level: high"
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][1]["repo_sha"] = "b" * 40
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "evidence split across two commits must fail under required" "spans 2 commits"
OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$VALIDATOR" "$TASK_DIR" >/dev/null 2>&1 \
  || fail "split-state evidence must NOT block under warn_only"

cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][0]["working_tree_dirty"] = true
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "evidence from a dirty tree must fail under required" "dirty working tree"

cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][0]["repo_sha"] = "unknown"
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "evidence with no sha must fail under required" "no repo_sha"
cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"

# The recorded sha is real, so the reviewed state is the work repo's HEAD.
assert_eq "$WORK_SHA" "$(ruby -ryaml -e 'puts YAML.safe_load(File.read(ARGV[0]))["evidence"][0]["repo_sha"]' "$TASK_DIR/evidence.yaml")" \
  "cited evidence carries the real reviewed-state sha"

echo "== required: a high-risk change may not skip a required check =="
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" skipped "risk_level: high"
expect_invalid "a skipped compile at high risk must fail under required" "not 'skipped'"

echo "== required: a LOW-risk change pays none of that cost =="
write_reviewer_output approved docs/notes.md "[]" pass "risk_level: low"
expect_valid "a low-risk approval without evidence must still validate under required"
write_reviewer_output approved docs/notes.md "[]" skipped "risk_level: low"
expect_valid "a low-risk approval may skip compile"

echo "== a self-reported risk_level may be raised, never lowered =="
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" pass "risk_level: low"
expect_invalid "downgrading the computed risk level must fail" "is below the deterministic classification"
write_reviewer_output approved docs/notes.md "[]" pass "risk_level: high"
expect_valid "raising the risk level above the computed one is allowed"

echo "== the four verdicts still validate, and only approved is gated =="
for verdict in changes_requested escalate infra_failure; do
  write_reviewer_output "$verdict" internal/auth/token.go "[]" pass "risk_level: high"
  expect_valid "$verdict must not be blocked by the evidence policy"
done
write_reviewer_output approved internal/auth/token.go "[]" pass "risk_level: high"
expect_invalid "only approved is gated" "no evidence_refs"

echo "== backward compatibility: a pre-issue-12 reviewer output is untouched =="
cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Reviewed and approved."
artifacts:
  - path: internal/auth/token.go
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "all green"
YAML
OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$VALIDATOR" "$TASK_DIR" >/dev/null 2>&1 \
  || fail "an output with no risk_level/evidence_refs must keep validating"
unset OFFICE_EVIDENCE_POLICY_MODE

echo "== the four verdicts still route correctly through the driver =="
mkdir -p "$ROUTE_DIR"
cat > "$ROUTE_DIR/task.md" <<'MD'
# Reviewer routing regression test
MD
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
cat > "$REVIEWER_OUTPUT_PATH" <<YAML
summary: "Routing check."
artifacts:
  - path: docs/notes.md
next_action:
  agent: $NEXT_AGENT
  reason: "Routing $VERDICT."
blockers: []
review_verdict: $VERDICT
risk_level: low
independent_review:
  preliminary_assessment: "Read the diff before the dev rationale."
  rationale_reviewed_after: true
  assessment_changed: false
build_check:
  compile: pass
  tests: pass
  details: "routing"
transition:
  from_phase: in_review
  to_phase: $TO_PHASE
YAML
exit 0
SH
chmod +x "$BIN/codex"

route_case() {
  local verdict="$1" next_agent="$2" to_phase="$3"
  cat > "$ROUTE_DIR/status.yaml" <<YAML
task_id: $ROUTE_TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
history: []
YAML
  rm -f "$ROUTE_DIR/reviewer-output.yaml"
  # `required` on purpose: a low-risk change must route identically in both modes.
  AI_OFFICE_RUNS_DIR="$ROOT/runs" OFFICE_EVIDENCE_POLICY_MODE=required \
    VERDICT="$verdict" NEXT_AGENT="$next_agent" TO_PHASE="$to_phase" \
    REVIEWER_OUTPUT_PATH="$ROUTE_DIR/reviewer-output.yaml" \
    OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false \
    PATH="$BIN:$PATH" "$RUN_AGENT" "$ROUTE_TASK" reviewer codex \
    >"$TMP_RUNS/route-$verdict.log" 2>&1 || fail "driver run failed for $verdict (see $TMP_RUNS/route-$verdict.log)"

  local phase
  phase="$(ruby -ryaml -e 'puts (YAML.safe_load(File.read(ARGV[0])) || {})["phase"].to_s' "$ROUTE_DIR/status.yaml")"
  assert_eq "$to_phase" "$phase" "$verdict must route to $to_phase"
  grep -q "reviewer_evidence_policy" "$ROUTE_DIR/meta.yaml" || fail "the gate outcome was not recorded in meta.yaml"
  grep -q "risk_level=low" "$TMP_RUNS/route-$verdict.log" || fail "the driver did not report the computed risk level"
}

route_case approved done done
route_case changes_requested debugger debugging
route_case escalate free-roam escalated
route_case infra_failure devops devops_needed

echo "[PASS] reviewer-evidence-risk: risk depth is deterministic, evidence gates approval under required, warn_only only records"
