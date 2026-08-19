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

# The driver honours AI_OFFICE_RUNS_DIR too, so no fixture is written into the
# real runs/ — nothing to leak if this test is killed.
ROUTE_TASK="TASK-913"
ROUTE_DIR="$TMP_RUNS/$ROUTE_TASK"
BIN="$(mktemp -d)"

cleanup() { rm -rf "$TMP_RUNS" "$BIN"; }
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
  tests: $4
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

echo "== required: an approval needs every required check to PASS =="
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" skipped "risk_level: high"
expect_invalid "a skipped compile at high risk must fail under required" "to pass before approval"
# B: `fail` used to disable the evidence demand entirely (the `pass`-gated
# branch never fired) and was not `skipped`, so an approval sailed through.
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" fail "risk_level: high"
expect_invalid "approving over a failing build must fail under required" "to pass before approval"
# The evidence demand must hang off the APPROVAL, not off a `pass` claim: with
# nothing claiming `pass`, an uncited approval is still a gap.
write_reviewer_output approved internal/auth/token.go "[]" fail "risk_level: high"
b_gate="$(ruby "$GATE" "$TASK" 2>&1)" && fail "an uncited approval over a failing build must block"
grep -q "an approval at risk high cites no evidence_refs" <<<"$b_gate" \
  || fail "the evidence demand must follow the approval, not a 'pass' claim; got: $b_gate"
expect_invalid "an uncited approval over a failing build must fail validation" "cites no evidence_refs"

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

# The floor is a GAP like any other, so warn_only really means "nothing blocks".
write_reviewer_output approved internal/auth/token.go "[$EV1, $EV2]" pass "risk_level: low"
OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$VALIDATOR" "$TASK_DIR" >"$TMP_RUNS/floor.out" 2>"$TMP_RUNS/floor.err"
assert_eq "0" "$?" "a downgraded risk_level must NOT block under warn_only"
assert_eq "Validation passed: $TASK_DIR" "$(cat "$TMP_RUNS/floor.out")" "warn_only stdout is unchanged for the floor case"
assert_eq "" "$(cat "$TMP_RUNS/floor.err")" "warn_only writes nothing to stderr for the floor case"
floor_gate="$(OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$GATE" "$TASK" 2>&1)"
grep -q "is below the deterministic classification" <<<"$floor_gate" \
  || fail "the floor gap must still be RECORDED by the gate under warn_only, got: $floor_gate"

echo "== F1: the gate classifies from the DEV artifacts, not the reviewer's claim =="
# The reviewer omits every path it was given. Classifying from its own
# artifacts[] scored this `low` and required nothing; the union scores it high.
cat > "$TASK_DIR/dev-output.yaml" <<'YAML'
summary: "Changed the wallet debit path and the auth token check."
artifacts:
  - path: services/wallet/debit.go
    action: modified
  - path: internal/auth/token.go
    action: modified
next_action:
  agent: reviewer
  reason: "Ready for review."
blockers: []
YAML
cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Looks fine."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "green"
YAML
omission_gate="$(ruby "$GATE" "$TASK" 2>&1)" && fail "an empty artifacts[] on a wallet+auth change must not pass under required"
grep -q "risk_level=high" <<<"$omission_gate" || fail "the gate must classify from the dev artifacts, got: $omission_gate"
grep -qE "labels=.*auth" <<<"$omission_gate" || fail "the gate must report the dev-declared labels, got: $omission_gate"
expect_invalid "an unbacked pass on an omitted high-risk path must block under required" "no evidence_refs"
expect_invalid "the omitted dev-declared paths must be reported" "omits 2 path"
ruby "$GATE" --upstream-paths "$TASK_DIR" | grep -q "services/wallet/debit.go" \
  || fail "the shared resolver must expose the dev-declared paths"
OFFICE_EVIDENCE_POLICY_MODE=warn_only ruby "$VALIDATOR" "$TASK_DIR" >/dev/null 2>&1 \
  || fail "the same case must only be recorded, never blocked, under warn_only"
rm -f "$TASK_DIR/dev-output.yaml"

echo "== every upstream role is ground truth, not just dev =="
# Reducing UPSTREAM_OUTPUTS to dev-output.yaml alone must not pass this suite.
approve_blind() {
  cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Looks fine."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "green"
YAML
}
for upstream in dev dev-2 debugger devops free-roam; do
  rm -f "$TASK_DIR"/*-output.yaml
  cat > "$TASK_DIR/$upstream-output.yaml" <<'YAML'
summary: "Touched the wallet debit path."
artifacts:
  - path: services/wallet/debit.go
next_action:
  agent: reviewer
  reason: "Ready."
blockers: []
YAML
  approve_blind
  role_gate="$(ruby "$GATE" "$TASK" 2>&1)" && fail "$upstream-output.yaml must be ground truth for the gate"
  grep -q "risk_level=high" <<<"$role_gate" || fail "$upstream artifacts must drive the risk level, got: $role_gate"
  expect_invalid "an approval blind to $upstream's paths must block under required" "omits 1 path"
done
rm -f "$TASK_DIR"/dev-2-output.yaml "$TASK_DIR"/debugger-output.yaml \
      "$TASK_DIR"/devops-output.yaml "$TASK_DIR"/free-roam-output.yaml

echo "== absent, unreadable and path-less upstream data fail CLOSED =="
# Blocker 2: deleting the ground-truth file used to restore the original
# exploit. The driver-written history says dev ran, so its absence is a gap.
cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 2
current_agent: reviewer
history:
  - phase: "assigned -> in_review"
    agent: dev
    reason: "Implementation complete."
YAML
rm -f "$TASK_DIR/dev-output.yaml"
approve_blind
expect_invalid "a deleted dev-output.yaml must not classify the change away" "dev ran on this task but dev-output.yaml is missing"
deleted_gate="$(ruby "$GATE" "$TASK" 2>&1)" && fail "a deleted upstream output must block"
grep -q "gaps=" <<<"$deleted_gate" || fail "the gate must report the missing-output gap, got: $deleted_gate"

printf 'artifacts: [\n' > "$TASK_DIR/dev-output.yaml"
expect_invalid "an unparseable dev-output.yaml must fail closed" "could not be parsed"

# Parsed but genuinely empty is NOT the same as unreadable: an upstream role may
# honestly have changed nothing.
cat > "$TASK_DIR/dev-output.yaml" <<'YAML'
summary: "Investigation only; nothing changed."
artifacts: []
next_action:
  agent: reviewer
  reason: "Ready."
blockers: []
YAML
write_reviewer_output approved docs/notes.md "[]" pass "risk_level: low"
expect_valid "a parsed-but-empty upstream output must not be treated as unreadable"

# An approval where nothing anywhere names a path cannot be classified at all.
approve_blind
expect_invalid "an approval with no path anywhere must not pass silently" "cannot determine what was reviewed"

# Finding 4: an upstream artifact with no usable path is an unnamed change.
cat > "$TASK_DIR/dev-output.yaml" <<'YAML'
summary: "Changed something."
artifacts:
  - path:
  - action: modified
next_action:
  agent: reviewer
  reason: "Ready."
blockers: []
YAML
expect_invalid "an upstream artifact with no path must fail closed" "no usable path"
rm -f "$TASK_DIR/dev-output.yaml"
cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
YAML

echo "== the gate binds the ROUTING decision, not the verdict label =="
# The office routes on next_action.agent; review_verdict is only a fallback. A
# non-approved verdict pointed at `done` must arm the gate exactly like an
# approval, or the two fields disagreeing is a free pass.
route_to_done_output() {  # $1 = review_verdict, $2 = next_action.agent, $3 = to_phase
  cat > "$TASK_DIR/reviewer-output.yaml" <<YAML
summary: "Reviewed."
artifacts:
  - path: internal/auth/token.go
next_action:
  agent: $2
  reason: "Routing."
blockers: []
review_verdict: $1
build_check:
  compile: pass
  tests: pass
  details: "green"
transition:
  from_phase: in_review
  to_phase: $3
YAML
}
route_to_done_output escalate done done
expect_invalid "a non-approved verdict routed to done must be gated" "cites no evidence_refs"
route_to_done_output changes_requested done done
expect_invalid "changes_requested routed to done must be gated" "cites no evidence_refs"
# transition alone is enough to reach done, so it arms the gate on its own.
route_to_done_output escalate free-roam done
expect_invalid "a transition to done must be gated even when next_action is not done" "cites no evidence_refs"
# Control: the same output genuinely routed away from done is not gated.
route_to_done_output escalate free-roam escalated
expect_valid "a verdict that does not route to done must not be gated"

echo "== F5: a case-differing sibling must not suppress the unreviewed-path gap =="
cat > "$TASK_DIR/dev-output.yaml" <<'YAML'
summary: "Two files that differ only in case."
artifacts:
  - path: src/Wallet.go
  - path: src/wallet.go
next_action:
  agent: reviewer
  reason: "Ready."
blockers: []
YAML
cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Reviewed one of them."
artifacts:
  - path: src/wallet.go
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "green"
YAML
case_gate="$(ruby "$GATE" "$TASK" 2>&1)" && fail "a case-differing sibling must still be reported unreviewed"
grep -q "omits 1 path(s)" <<<"$case_gate" || fail "src/Wallet.go must still count as unreviewed, got: $case_gate"
grep -q "src/Wallet.go" <<<"$case_gate" || fail "the unreviewed path must be named, got: $case_gate"
rm -f "$TASK_DIR/dev-output.yaml"

# The env override maps onto reviewer.evidence_policy.mode and would pin BOTH
# loop iterations to `required`, making the warn_only half vacuous — which is
# how a config-error mutant survived this block once. Drop it so the mode the
# loop claims is the mode it runs; restored right after the loop.
unset OFFICE_EVIDENCE_POLICY_MODE
echo "== F4: a malformed reviewer config fails CLOSED, in every mode =="
BROKEN_OFFICE="$TMP_RUNS/broken-office"
mkdir -p "$BROKEN_OFFICE"
# $1 = the reviewer key to misspell, $2 = the mode to claim
broken_config_result() {
  ruby - "$ROOT" "$BROKEN_OFFICE" "$TASK_DIR" "$1" "$2" <<'RUBY'
require "yaml"
root, office, task_dir, typo_key, mode = ARGV
require File.join(root, "scripts", "review-gate")
require File.join(root, "scripts", "resolve-office-config")

config = YAML.safe_load(File.read(File.join(root, "office.config.yaml")))
config["reviewer"]["evidence_policy"]["mode"] = mode
config["reviewer"]["#{typo_key}z"] = config["reviewer"].delete(typo_key)
File.write(File.join(office, "office.config.yaml"), YAML.dump(config))

data = YAML.safe_load(File.read(File.join(task_dir, "reviewer-output.yaml")))
result = ReviewGate.evaluate(OfficeConfigResolver.new(office).merged_config, task_dir, data)
puts "blocking=#{result['blocking']}"
result["config_errors"].each { |e| puts "error: #{e}" }
RUBY
}

for broken_key in risk_rules risk_depth; do
  for claimed_mode in required warn_only; do
    broken_out="$(broken_config_result "$broken_key" "$claimed_mode")"
    grep -q "blocking=true" <<<"$broken_out" \
      || fail "a $broken_key typo must fail closed under $claimed_mode, got: $broken_out"
    grep -q "error: reviewer.$broken_key is missing" <<<"$broken_out" \
      || fail "a $broken_key typo must be reported by name, got: $broken_out"

    # F8: the CLI is the lane the driver uses; its EXIT CODE must fail closed
    # too, not only the validator's separate error path.
    CLI_OFFICE="$TMP_RUNS/cli-office"
    rm -rf "$CLI_OFFICE"
    mkdir -p "$CLI_OFFICE/scripts"
    # A real copy, not a symlink: __dir__ resolves symlinks and would point the
    # CLI back at the healthy office.
    cp "$ROOT/scripts/review-gate.rb" "$ROOT/scripts/classify-risk.rb" \
       "$ROOT/scripts/resolve-office-config.rb" "$CLI_OFFICE/scripts/"
    cp "$BROKEN_OFFICE/office.config.yaml" "$CLI_OFFICE/office.config.yaml"
    cli_out="$(AI_OFFICE_RUNS_DIR="$TMP_RUNS" ruby "$CLI_OFFICE/scripts/review-gate.rb" "$TASK" 2>&1)"
    cli_rc=$?
    assert_eq "1" "$cli_rc" "the gate CLI must exit 1 on a $broken_key typo under $claimed_mode"
    grep -q "config_errors=" <<<"$cli_out" || fail "the CLI must report the config errors, got: $cli_out"
  done
done

# Restore what the F4 loop dropped: every section below asserts `required`.
export OFFICE_EVIDENCE_POLICY_MODE=required
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
  # #16: each route_case call is an independent scenario reusing $ROUTE_TASK's
  # fixture dir (status.yaml is already reset above). meta.yaml is append-only
  # history, not scenario state, so without this reset it accumulates across
  # all 4 calls and, combined with the later F1/B/C/split scenarios below that
  # reuse the same task dir, can cross the execution-budget checkpoint's
  # no_new_evidence threshold purely from test-harness task-id reuse — a false
  # positive on the SUITE's structure, not on anything the classifier should
  # actually be flagging (a real single task never resets phase back to
  # in_review after every dispatch the way this test intentionally does).
  rm -f "$ROUTE_DIR/meta.yaml"
  # `required` on purpose: a low-risk change must route identically in both modes.
  OFFICE_EVIDENCE_POLICY_MODE=required \
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

echo "== F1 end-to-end: an omitted high-risk path cannot reach done under required =="
cat > "$ROUTE_DIR/status.yaml" <<YAML
task_id: $ROUTE_TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
history: []
YAML
cat > "$ROUTE_DIR/dev-output.yaml" <<'YAML'
summary: "Changed the wallet debit path and the auth token check."
artifacts:
  - path: services/wallet/debit.go
    action: modified
  - path: internal/auth/token.go
    action: modified
next_action:
  agent: reviewer
  reason: "Ready for review."
blockers: []
YAML
rm -f "$ROUTE_DIR/reviewer-output.yaml"
rm -f "$ROUTE_DIR/meta.yaml"  # #16: independent scenario reusing $ROUTE_TASK — see route_case's comment above.
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
cat > "$REVIEWER_OUTPUT_PATH" <<'YAML'
summary: "Looks fine."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "green"
transition:
  from_phase: in_review
  to_phase: done
YAML
exit 0
SH
chmod +x "$BIN/codex"
OFFICE_EVIDENCE_POLICY_MODE=required \
  REVIEWER_OUTPUT_PATH="$ROUTE_DIR/reviewer-output.yaml" \
  OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false \
  PATH="$BIN:$PATH" "$RUN_AGENT" "$ROUTE_TASK" reviewer codex >"$TMP_RUNS/route-omit.log" 2>&1
omit_phase="$(ruby -ryaml -e 'puts (YAML.safe_load(File.read(ARGV[0])) || {})["phase"].to_s' "$ROUTE_DIR/status.yaml")"
[[ "$omit_phase" != "done" ]] || fail "an unbacked approval on an omitted wallet+auth change reached done"
assert_eq "validation_failed" "$omit_phase" "the driver must halt the omitted-path approval"
grep -q "risk_level=high" "$TMP_RUNS/route-omit.log" || fail "the driver must enforce the dev-declared risk level"
grep -q "reviewer_evidence_policy" "$ROUTE_DIR/meta.yaml" || fail "the blocking reason must be in the run history"
grep -q "blocking=true" "$ROUTE_DIR/meta.yaml" || fail "meta.yaml must record that the gate blocked"

echo "== B/C end-to-end: build_check and a deleted upstream file cannot open the gate =="
# $1 = scenario label, $2 = extra shell the stub runs before writing its output,
# $3 = build_check value the reviewer claims, $4 = expected final phase
# (default validation_failed — the review-gate's own gap detection), $5 =
# a string that must appear in meta.yaml recording why the exploit was
# blocked (default "blocking=true", the review-gate's own event).
#
# Scenario C (issue #22, tests/integration/task-input-integrity.sh) is file
# tampering — deleting dev-output.yaml — which task_input_integrity now
# catches BEFORE the driver ever reaches enforce-output-contract/the review
# gate, so it never sees "validation_failed" or "blocking=true" at all: the
# dispatch aborts outright and status.yaml stays exactly as it was before the
# call. That is a STRONGER guarantee than the old validation_failed route
# (the exploit no longer even reaches the gate it used to slip through), so C
# passes its own expected phase/marker below instead of the defaults.
drive_exploit() {
  local expected_phase="${4:-validation_failed}"
  local expected_marker="${5:-blocking=true}"
  cat > "$ROUTE_DIR/status.yaml" <<YAML
task_id: $ROUTE_TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
history:
  - phase: "assigned -> in_review"
    agent: dev
    reason: "Implementation complete."
YAML
  cat > "$ROUTE_DIR/dev-output.yaml" <<'YAML'
summary: "Changed the wallet debit path and the auth token check."
artifacts:
  - path: services/wallet/debit.go
  - path: internal/auth/token.go
next_action:
  agent: reviewer
  reason: "Ready for review."
blockers: []
YAML
  rm -f "$ROUTE_DIR/reviewer-output.yaml"
  rm -f "$ROUTE_DIR/meta.yaml"  # #16: independent scenario reusing $ROUTE_TASK — see route_case's comment above.
  cat > "$BIN/codex" <<SH
#!/usr/bin/env bash
$2
cat > "\$REVIEWER_OUTPUT_PATH" <<'YAML'
summary: "Approved."
artifacts:
  - path: services/wallet/debit.go
  - path: internal/auth/token.go
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
risk_level: high
build_check:
  compile: $3
  tests: $3
  details: "reported"
transition:
  from_phase: in_review
  to_phase: done
YAML
exit 0
SH
  chmod +x "$BIN/codex"
  OFFICE_EVIDENCE_POLICY_MODE=required \
    REVIEWER_OUTPUT_PATH="$ROUTE_DIR/reviewer-output.yaml" \
    OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false \
    PATH="$BIN:$PATH" "$RUN_AGENT" "$ROUTE_TASK" reviewer codex >"$TMP_RUNS/$1.log" 2>&1

  local phase
  phase="$(ruby -ryaml -e 'puts (YAML.safe_load(File.read(ARGV[0])) || {})["phase"].to_s' "$ROUTE_DIR/status.yaml")"
  [[ "$phase" != "done" ]] || fail "$1 reached done: the gate did not bind"
  assert_eq "$expected_phase" "$phase" "$1 must halt at $expected_phase"
  grep -q "$expected_marker" "$ROUTE_DIR/meta.yaml" || fail "$1: the block was not recorded in the run history (expected '$expected_marker')"
}

# B: honest paths, `fail` build, approved anyway — the evidence demand used to
# be gated on a `pass` claim, so declaring failure disabled it.
drive_exploit "B-approved-with-build-fail" "" fail
grep -q "risk_level=high" "$TMP_RUNS/B-approved-with-build-fail.log" || fail "B: risk level was not enforced"

# C: the reviewer deletes the ground-truth file before writing its verdict.
# Issue #22 (task_input_integrity) intercepts this earlier than the review
# gate does: status.yaml is untouched at its pre-dispatch phase (in_review),
# and the block is recorded as a task_input_integrity_violation, not a
# reviewer_evidence_policy gap — see the comment on drive_exploit above.
drive_exploit "C-reviewer-deletes-dev-output" 'rm -f "$(dirname "$REVIEWER_OUTPUT_PATH")/dev-output.yaml"' pass \
  in_review task_input_integrity_violation
grep -q "tampered" "$ROUTE_DIR/task-input-integrity.yaml" || fail "C: task-input-integrity.yaml must record the deletion as tampered"
# The pre-#22 assertion here checked for a "dev-output.yaml is missing"
# message from the REVIEW GATE's own reporting — that code path no longer
# runs for this scenario at all (task_input_integrity intercepts first, see
# the comment above), so that exact string can never appear again. Replaced
# with an assertion of equal strength against the NEW ground truth: the
# specific file and kind must be named in task-input-integrity.yaml, not just
# the word "tampered" anywhere in it.
grep -q "path: dev-output.yaml" "$ROUTE_DIR/task-input-integrity.yaml" || fail "C: task-input-integrity.yaml must name dev-output.yaml specifically"
grep -q "kind: deleted" "$ROUTE_DIR/task-input-integrity.yaml" || fail "C: task-input-integrity.yaml must record the mismatch kind as deleted"
grep -q "task_input_integrity_violation" "$ROUTE_DIR/meta.yaml" || fail "C: the violation must be reported in meta.yaml"

echo "== E2E: a verdict/routing split cannot walk the task to done =="
# review_verdict says escalate, next_action says done. The driver routes on
# next_action, so watching only the verdict left the gate reporting gaps while
# the task completed.
cat > "$ROUTE_DIR/status.yaml" <<YAML
task_id: $ROUTE_TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
history:
  - phase: "assigned -> in_review"
    agent: dev
    reason: "Implementation complete."
YAML
cat > "$ROUTE_DIR/dev-output.yaml" <<'YAML'
summary: "Changed the auth token check."
artifacts:
  - path: internal/auth/token.go
next_action:
  agent: reviewer
  reason: "Ready for review."
blockers: []
YAML
rm -f "$ROUTE_DIR/reviewer-output.yaml"
rm -f "$ROUTE_DIR/meta.yaml"  # #16: independent scenario reusing $ROUTE_TASK — see route_case's comment above.
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
cat > "$REVIEWER_OUTPUT_PATH" <<'YAML'
summary: "Escalating, but routing to done."
artifacts:
  - path: internal/auth/token.go
next_action:
  agent: done
  reason: "Done."
blockers: []
review_verdict: escalate
risk_level: high
build_check:
  compile: pass
  tests: pass
  details: "green"
transition:
  from_phase: in_review
  to_phase: done
YAML
exit 0
SH
chmod +x "$BIN/codex"
OFFICE_EVIDENCE_POLICY_MODE=required \
  REVIEWER_OUTPUT_PATH="$ROUTE_DIR/reviewer-output.yaml" \
  OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false \
  PATH="$BIN:$PATH" "$RUN_AGENT" "$ROUTE_TASK" reviewer codex >"$TMP_RUNS/route-split.log" 2>&1
split_phase="$(ruby -ryaml -e 'puts (YAML.safe_load(File.read(ARGV[0])) || {})["phase"].to_s' "$ROUTE_DIR/status.yaml")"
[[ "$split_phase" != "done" ]] || fail "escalate + next_action.agent=done reached done: the gate watched the wrong field"
assert_eq "validation_failed" "$split_phase" "a verdict/routing split must halt at validation_failed"
grep -q "blocking=true" "$ROUTE_DIR/meta.yaml" || fail "the verdict/routing split block was not recorded"

echo "[PASS] reviewer-evidence-risk: risk depth is deterministic, evidence gates approval under required, warn_only only records"
