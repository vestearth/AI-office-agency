#!/usr/bin/env bash
# Knowledge provenance and stale-evidence invalidation (issue #15).
#
# Covers the producer (scripts/knowledge-capture.rb, scripts/mark-evidence-stale.rb),
# the reporter (scripts/knowledge-freshness.rb) and the consumer (validate-yaml.rb):
# a capture output may carry task/run/evidence provenance; provenance is optional
# everywhere and its absence reads as `unknown`; an explicit operator mark is the
# ONLY thing that degrades evidence; a capture citing degraded evidence cannot
# call itself `current`; and degraded knowledge stays on disk and discoverable.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$ROOT/validate-yaml.rb"
RECORD="$ROOT/scripts/record-evidence.sh"
MARK="$ROOT/scripts/mark-evidence-stale.rb"
FRESHNESS="$ROOT/scripts/knowledge-freshness.rb"
CAPTURE="$ROOT/scripts/knowledge-capture.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-903"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"

cleanup() { rm -rf "$TMP_RUNS"; }
trap cleanup EXIT

fail() {
  echo "[FAIL] $1"
  exit 1
}

expect_valid() {
  local out
  out="$(ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" || fail "$1 (validation failed: $out)"
}

# $1 = message, $2 = substring the failure must mention (optional)
expect_invalid() {
  local out
  out="$(ruby "$VALIDATOR" "$TASK_DIR" 2>&1)" && fail "$1 (validation unexpectedly passed)"
  if [[ -n "${2:-}" ]] && ! grep -q "$2" <<<"$out"; then
    fail "$1 (expected the error to mention '$2', got: $out)"
  fi
}

cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: done
state: done
iteration: 1
current_agent: done
YAML

# $1 = the provenance block (may be empty), written into a capture output.
write_capture() {
  cat > "$TASK_DIR/knowledge-capture-output.yaml" <<YAML
task_id: $TASK
capture_type: lesson
target_repo: knowledge-base
target_note: "Knowledge Base/40 Lessons/Example.md"
summary: "A reusable lesson."
sources:
  - "ai-dev-office/runs/$TASK/status.yaml"
recommended_action: create_note
requires_human_review: true
note_patch: |
  # Example
${1:-}
YAML
}

echo "== Scenario 0: baseline — a capture output with NO provenance still validates =="
write_capture ""
expect_valid "capture output without provenance must keep validating (provenance is optional)"
ruby "$FRESHNESS" "$TASK" | grep -q "declared=unknown" \
  || fail "a capture with no provenance must be reported as unknown, not rejected"

echo "== Scenario 1: real evidence + a run record, then provenance citing them =="
mkdir -p "$TASK_DIR/run-records"
RUN_ID="run-20260815T101500Z-$TASK-dev-k3f9a2"
cat > "$TASK_DIR/run-records/$RUN_ID.yaml" <<YAML
run_id: $RUN_ID
task_id: $TASK
role: dev
client: codex
harness_version: "0.0.0"
instruction_sha: null
repo_sha: null
model_requested: null
model_observed: null
skill_version: null
mcp_profile: null
started_at: "2026-08-15T10:15:00Z"
completed_at: "2026-08-15T10:16:00Z"
outcome:
  status: completed
  validation: passed
  error: null
YAML
expect_valid "run record must validate"

AI_DEV_OFFICE_RUN_ID="$RUN_ID" bash "$RECORD" "$TASK" --type test -- true >/dev/null 2>&1 \
  || fail "recording evidence failed"
grep -q "id: ev-001" "$TASK_DIR/evidence.yaml" || fail "expected ev-001 to be recorded"
expect_valid "recorded evidence must validate"

echo "== Scenario 2: freshness 'current' with unmarked evidence validates =="
write_capture "provenance:
  freshness: current
  verified_at: \"2026-08-15\"
  task_id: $TASK
  run_id: $RUN_ID
  evidence_refs: [ev-001]
  repo_origin: SparqLab/missions
  repo_sha: unknown
  confidence: high"
expect_valid "a current capture citing unmarked evidence must validate"
ruby "$FRESHNESS" "$TASK" | grep -q "declared=current  effective=current" \
  || fail "unmarked evidence must leave effective freshness at current"
ruby "$FRESHNESS" --degraded | grep -q "Nothing to report" \
  || fail "nothing should be degraded before any mark exists"

echo "== Scenario 2b: provenance.task_id must agree with the output's task_id =="
write_capture "provenance:
  freshness: current
  task_id: TASK-904"
expect_invalid "a mismatched provenance.task_id must fail" "must equal"

echo "== Scenario 2c: a dangling evidence ref fails, exactly as elsewhere =="
write_capture "provenance:
  freshness: unknown
  evidence_refs: [ev-999]"
expect_invalid "a dangling provenance evidence ref must fail" "unknown evidence id 'ev-999'"

echo "== Scenario 2d: confidence needs a check behind it =="
write_capture "provenance:
  freshness: current
  confidence: high"
expect_invalid "confidence without verified_at + run_id/evidence_refs must fail" "confidence requires verified_at"

echo "== Scenario 2e: an unknown provenance field is refused (no silent typos) =="
write_capture "provenance:
  freshness: current
  repo: /Users/someone/local/path"
expect_invalid "an unknown provenance key must fail" "is not a provenance field"

echo "== Scenario 3: the deterministic trigger — an explicit operator mark =="
write_capture "provenance:
  freshness: current
  verified_at: \"2026-08-15\"
  task_id: $TASK
  run_id: $RUN_ID
  evidence_refs: [ev-001]
  repo_origin: SparqLab/missions
  repo_sha: unknown
  confidence: high"
expect_valid "precondition: the capture is valid before anything is marked"

# Nothing but this invocation can degrade evidence: no clock, no HEAD compare.
ruby "$MARK" "$TASK" ev-001 --reason "migration 051 replaced the schema this run verified" --by "operator:test" \
  >/dev/null 2>&1 || fail "marking evidence stale failed"
[[ -f "$TASK_DIR/evidence-freshness.yaml" ]] || fail "expected an evidence-freshness.yaml ledger"
grep -q "state: maybe_stale" "$TASK_DIR/evidence-freshness.yaml" \
  || fail "--state must default to the conservative maybe_stale"

expect_invalid "a capture claiming 'current' over marked evidence must fail" "cites evidence marked in"
[[ -f "$TASK_DIR/knowledge-capture-output.yaml" ]] || fail "the capture output must NOT be deleted"
grep -q "A reusable lesson." "$TASK_DIR/knowledge-capture-output.yaml" \
  || fail "the capture output must NOT be rewritten or hidden"

echo "== Scenario 3b: the evidence record itself is untouched and still validates =="
grep -q "id: ev-001" "$TASK_DIR/evidence.yaml" || fail "marking must not remove the evidence record"
ruby "$VALIDATOR" "$TASK_DIR/evidence.yaml" >/dev/null 2>&1 \
  || fail "evidence.yaml must still validate after a mark"
ruby "$VALIDATOR" "$TASK_DIR/evidence-freshness.yaml" >/dev/null 2>&1 \
  || fail "evidence-freshness.yaml must validate on its own"

echo "== Scenario 4: declaring maybe_stale clears the violation, knowledge stays =="
write_capture "provenance:
  freshness: maybe_stale
  verified_at: \"2026-08-15\"
  task_id: $TASK
  run_id: $RUN_ID
  evidence_refs: [ev-001]"
expect_valid "a capture that honestly declares maybe_stale must validate"
ruby "$FRESHNESS" "$TASK" | grep -q "effective=maybe_stale" \
  || fail "effective freshness must be maybe_stale"

echo "== Scenario 5: stale — a re-check confirmed the behaviour changed =="
ruby "$MARK" "$TASK" ev-001 --state stale --reason "re-checked: the endpoint now returns 404" --by "operator:test" \
  >/dev/null 2>&1 || fail "marking stale failed"
expect_valid "a maybe_stale capture over stale evidence still validates (only 'current' is refused)"
ruby "$FRESHNESS" "$TASK" | grep -q "declared=maybe_stale  effective=stale" \
  || fail "the most severe of declared and marked must win (stale)"
ruby "$FRESHNESS" --degraded | grep -q "NEEDS REVALIDATION" \
  || fail "degraded knowledge must be surfaced by --degraded"
ruby "$FRESHNESS" --degraded | grep -q "$TASK" \
  || fail "the degraded report must name the task so the knowledge stays discoverable"

echo "== Scenario 6: invalid — the claim was wrong when written =="
ruby "$MARK" "$TASK" ev-001 --state invalid --reason "the command never exercised the path it claimed" --by "operator:test" \
  >/dev/null 2>&1 || fail "marking invalid failed"
ruby "$FRESHNESS" "$TASK" | grep -q "effective=invalid" \
  || fail "the last mark must win (append-only, later judgment supersedes)"
write_capture "provenance:
  freshness: current
  verified_at: \"2026-08-15\"
  task_id: $TASK
  evidence_refs: [ev-001]"
expect_invalid "'current' over invalid evidence must fail" "ev-001 (invalid)"
write_capture "provenance:
  freshness: invalid
  task_id: $TASK
  evidence_refs: [ev-001]"
expect_valid "an honestly-declared invalid capture must validate and stay on record"

echo "== Scenario 7: historical is exempt — a note about the past never goes stale =="
write_capture "provenance:
  freshness: historical
  task_id: $TASK
  evidence_refs: [ev-001]"
expect_valid "historical provenance must not be degraded by marks"
ruby "$FRESHNESS" "$TASK" | grep -q "effective=historical" \
  || fail "historical must stay historical"

echo "== Scenario 8: marks are guarded — no dangling ids, no unexplained marks =="
ruby "$MARK" "$TASK" ev-999 --reason "typo" >/dev/null 2>&1 \
  && fail "marking a non-existent evidence id must fail (ids are task-scoped)"
ruby "$MARK" "$TASK" ev-001 >/dev/null 2>&1 \
  && fail "a mark with no --reason must fail (it would not be reviewable)"
ruby "$MARK" "$TASK" ev-001 --state current --reason "x" >/dev/null 2>&1 \
  && fail "there is no 'current' mark — re-verification writes a NEW evidence record"

echo "== Scenario 9: a hand-edited ledger with a dangling mark fails validation =="
cp "$TASK_DIR/evidence-freshness.yaml" "$TMP_RUNS/ledger.bak"
ruby -ryaml -e '
  doc = YAML.load_file(ARGV[0])
  doc["marks"] << {"evidence_id" => "ev-777", "state" => "stale", "marked_at" => "2026-08-15T00:00:00Z",
                   "marked_by" => "hand", "reason" => "fabricated", "run_id" => nil}
  File.write(ARGV[0], YAML.dump(doc))
' "$TASK_DIR/evidence-freshness.yaml"
expect_invalid "a dangling mark must fail" "unknown evidence id 'ev-777'"
ruby -ryaml -e '
  doc = YAML.load_file(ARGV[0])
  doc["marks"] = doc["marks"][0..-2]
  doc["marks"][0]["reason"] = ""
  File.write(ARGV[0], YAML.dump(doc))
' "$TASK_DIR/evidence-freshness.yaml"
expect_invalid "a mark with an empty reason must fail" "must say why"
cp "$TMP_RUNS/ledger.bak" "$TASK_DIR/evidence-freshness.yaml"
expect_valid "restoring the ledger must restore validity"

echo "== Scenario 10: capture stays suggest-only — no autonomous writer =="
grep -Fq "requires_human_review must be true (capture output is suggest-only)" "$ROOT/validate-yaml.rb" \
  || fail "the suggest-only invariant must stay enforced"
write_capture "provenance:
  freshness: unknown"
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["requires_human_review"] = false
  File.write(ARGV[0], YAML.dump(data))
' "$TASK_DIR/knowledge-capture-output.yaml"
expect_invalid "a capture output may never opt out of human review" "requires_human_review"
write_capture "provenance:
  freshness: unknown"
expect_valid "restoring requires_human_review must restore validity"

echo "== Scenario 11: the producer seeds provenance and promotable frontmatter =="
SKELETON="$(ruby "$CAPTURE" "$TASK" --skeleton)"
grep -Fq "provenance:" <<<"$SKELETON" || fail "the skeleton must offer a provenance block"
grep -Fq "freshness: unknown" <<<"$SKELETON" || fail "the skeleton must default freshness to unknown, never current"
grep -Fq "evidence_refs: [ev-001]" <<<"$SKELETON" || fail "the skeleton must pre-fill real evidence ids"
grep -Fq "run_id: \"$RUN_ID\"" <<<"$SKELETON" || fail "the skeleton must pre-fill the recorded run id"
# The note_patch carries the same block as YAML frontmatter, so provenance
# survives promotion into the vault with no transformation.
ruby -ryaml -e '
  data = YAML.safe_load(STDIN.read)
  patch = data.fetch("note_patch")
  abort "note_patch must open with YAML frontmatter" unless patch.start_with?("---\n")
  fm = patch.split("---\n")[1]
  abort "frontmatter must carry task_id" unless fm.include?("task_id: ")
  abort "frontmatter must carry evidence_refs" unless fm.include?("evidence_refs: [ev-001]")
  abort "frontmatter must carry the run id" unless fm.include?("run_id: ")
  abort "frontmatter must not claim current" if fm.include?("freshness: current")
' <<<"$SKELETON" || fail "the promoted note must retain provenance in its frontmatter"
# The brief warns the operator off `current` when evidence is already marked.
ruby "$CAPTURE" "$TASK" | grep -Fq "DO NOT declare \`current\`" \
  || fail "the brief must surface existing marks to the operator"

echo "== Scenario 12: no HEAD comparison is introduced anywhere =="
# repo_sha stays provenance, not liveness: EVIDENCE_STRICT_SHA=1 remains the only
# sha-vs-HEAD check, and it is scoped to evidence.yaml, not to this feature.
ruby "$MARK" "$TASK" --list >/dev/null 2>&1 || fail "--list must work"
write_capture "provenance:
  freshness: maybe_stale
  task_id: $TASK
  repo_sha: 8f295531c0a7f1e0d4b2a9c8e5f30b71d6a4c2e9"
expect_valid "a provenance repo_sha that matches no HEAD anywhere must still validate"

echo "Knowledge provenance contract smoke passed"
