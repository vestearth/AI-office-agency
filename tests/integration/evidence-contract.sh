#!/usr/bin/env bash
# Execution evidence contract (issue #11).
#
# Covers the producer (scripts/record-evidence.sh) and the consumer
# (validate-yaml.rb): a recorded command carries a real sha256 + repo sha, a
# failing command is still recorded with its exit code, outputs may cite
# evidence ids, and fabricated / tampered / dangling evidence fails validation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECORD="$ROOT/scripts/record-evidence.sh"
VALIDATOR="$ROOT/validate-yaml.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-902"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"

cleanup() { rm -rf "$TMP_RUNS"; }
trap cleanup EXIT

fail() {
  echo "[FAIL] $1"
  exit 1
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"
}

expect_valid() {
  ruby "$VALIDATOR" "$TASK_DIR" >/dev/null 2>&1 || fail "$1"
}

# $1 = message, $2 = substring the failure must mention (optional)
expect_invalid() {
  local out
  out="$(ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" && fail "$1 (validation unexpectedly passed)"
  if [[ -n "${2:-}" ]] && ! grep -q "$2" <<<"$out"; then
    fail "$1 (expected the error to mention '$2', got: $out)"
  fi
}

write_status() {
  cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
YAML
}

# $1 = evidence_refs value (YAML inline list)
write_reviewer_output() {
  cat > "$TASK_DIR/reviewer-output.yaml" <<YAML
summary: "Reviewed and approved."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "all green"
evidence_refs: $1
claims:
  - claim: "the suite passes"
    evidence_refs: $1
YAML
}

field_of() {
  ruby - "$TASK_DIR/evidence.yaml" "$1" "$2" <<'RUBY'
require "yaml"
path, index, key = ARGV
doc = YAML.safe_load(File.read(path)) || {}
puts doc["evidence"][index.to_i][key].to_s
RUBY
}

write_status

# --- Case a: a passing command is recorded with a real hash and repo sha ---
EV1="$(cd "$ROOT" && "$RECORD" "$TASK" --type test -- echo evidence-ok)"
assert_eq "0" "$?" "passing command exits 0"
assert_eq "ev-001" "$EV1" "first id follows the ev-NNN grammar"
[[ -f "$TASK_DIR/evidence/ev-001.log" ]] || fail "log file was not written"
grep -q "evidence-ok" "$TASK_DIR/evidence/ev-001.log" || fail "log does not contain the command output"
assert_eq "0" "$(field_of 0 exit_code)" "passing command records exit_code 0"
assert_eq "test" "$(field_of 0 type)" "--type is recorded"

expected_sha="$(ruby -rdigest -e 'puts Digest::SHA256.file(ARGV[0]).hexdigest' "$TASK_DIR/evidence/ev-001.log")"
assert_eq "$expected_sha" "$(field_of 0 artifact_sha256)" "artifact_sha256 is the real digest"
expected_head="$(cd "$ROOT" && git rev-parse HEAD)"
assert_eq "$expected_head" "$(field_of 0 repo_sha)" "repo_sha is the real HEAD"

# --- Case b: a failing command is recorded and its exit code propagates ---
(cd "$ROOT" && "$RECORD" "$TASK" -- sh -c 'echo nope >&2; exit 7') >/dev/null
assert_eq "7" "$?" "wrapper exits with the command's exit code"
assert_eq "7" "$(field_of 1 exit_code)" "failing command records exit_code 7"
grep -q "nope" "$TASK_DIR/evidence/ev-002.log" || fail "stderr was not captured"

# --- Case c: output citing existing evidence validates ---
write_reviewer_output "[ev-001, ev-002]"
expect_valid "valid evidence_refs should pass validation"

# --- Case d: an unknown evidence id fails ---
write_reviewer_output "[ev-001, ev-404]"
expect_invalid "unknown evidence id should fail validation" "ev-404"

# --- Case e: a tampered artifact fails on the recomputed hash ---
write_reviewer_output "[ev-001]"
cp "$TASK_DIR/evidence/ev-001.log" "$TMP_RUNS/ev-001.log.bak"
echo "fabricated line" >> "$TASK_DIR/evidence/ev-001.log"
expect_invalid "tampered artifact should fail validation" "artifact_sha256 does not match"
cp "$TMP_RUNS/ev-001.log.bak" "$TASK_DIR/evidence/ev-001.log"
expect_valid "restored artifact should pass again"

# --- Case f: a malformed evidence.yaml fails ---
cp "$TASK_DIR/evidence.yaml" "$TMP_RUNS/evidence.yaml.bak"
printf 'evidence:\n  - id: not-an-ev-id\n    type: sorcery\n' > "$TASK_DIR/evidence.yaml"
expect_invalid "malformed evidence.yaml should fail validation" "must match ev-NNN"
printf 'evidence: [\n' > "$TASK_DIR/evidence.yaml"
expect_invalid "unparseable evidence.yaml should fail validation" "YAML syntax error"
cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"

# --- Case g: stale repo_sha only fails under EVIDENCE_STRICT_SHA=1 ---
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][0]["repo_sha"] = "0" * 40
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_valid "stale repo_sha must NOT fail by default"
strict_out="$(EVIDENCE_STRICT_SHA=1 ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" && fail "stale repo_sha should fail under EVIDENCE_STRICT_SHA=1"
grep -q "is stale" <<<"$strict_out" || fail "strict error should say stale, got: $strict_out"

# --- Backward compatibility: an output without evidence_refs still validates ---
cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"
cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Reviewed and approved."
artifacts: []
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
expect_valid "output without evidence_refs must keep validating"

echo "[PASS] evidence-contract: recording, citation, tampering and staleness rules hold"
