#!/usr/bin/env bash
set -euo pipefail

# Issue #55 — open a task with gates.
#
# `./run-agent.sh open <TASK_ID>` creates task.md, status.yaml and meta.yaml and
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rc=$?; rm -rf "$RUNS"; exit $rc' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW AI_OFFICE_GATE_PRESETS AI_OFFICE_OPEN_FAIL_AT

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# presets_rb <ruby expression over P (GatePresets)> — prints the result (JSON for non-strings).
presets_rb() {
  ruby -rjson - "$ROOT" "$1" <<'RUBY'
require File.join(ARGV[0], "scripts", "gate-presets")
P = GatePresets
r = begin
  eval(ARGV[1])
rescue GatePresets::Error => e
  "Error: #{e.message}"
rescue GatePresets::PlanError => e
  "PlanError: #{e.message}"
end
puts(r.is_a?(String) ? r : JSON.generate(r))
RUBY
}

# --- P: presets ---
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH).keys')" '["staging","production","backfill"]' "P shipped presets"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["staging"].map { |g| g["name"] }')" '["implementation_verification","deploy_staging","staging_acceptance"]' "P staging gates"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["production"].map { |g| g["name"] }')" '["implementation_verification","deploy_staging","staging_acceptance","deploy_production","production_acceptance"]' "P production includes the staging chain"
assert_eq "$(presets_rb 'g = P.load(P::DEFAULT_PATH)["staging"][1]; [g["after"], g["requires_authorization"], g["requires_record"]]')" '[["implementation_verification"],"deploy_staging",true]' "P deploy_staging is ordered, bound and needs a record"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["backfill"]')" '[{"name":"production_backfill","reason":"the production backfill or correction ran and its result was checked","requires_authorization":"production_backfill","requires_record":true}]' "P backfill"
# Composition: merge by name; identical duplicates merge; presets first, then custom gates.
all="P.load(P::DEFAULT_PATH)"
assert_eq "$(presets_rb "P.compose($all, %w[staging production], []).map { |g| g['name'] }")" '["implementation_verification","deploy_staging","staging_acceptance","deploy_production","production_acceptance"]' "P staging + production merge"
assert_eq "$(presets_rb "P.compose($all, %w[backfill staging], [['docs', 'docs updated']]).map { |g| g['name'] }")" '["production_backfill","implementation_verification","deploy_staging","staging_acceptance","docs"]' "P backfill + staging + custom, in order"
assert_eq "$(presets_rb "P.compose($all, %w[staging], [['deploy_staging', 'by hand']])")" "PlanError: gate deploy_staging is defined differently by --gate deploy_staging and an earlier preset or gate" "P a conflicting definition is refused"
assert_eq "$(presets_rb "P.compose($all, %w[nightly], [])")" "PlanError: unknown preset 'nightly' (known: staging, production, backfill)" "P unknown preset"
assert_eq "$(presets_rb "P.compose($all, [], [['Bad-Name', 'x']])")" 'PlanError: completion_gates[0].name must match /\A[a-z][a-z0-9_]*\z/' "P a bad custom gate name"
assert_eq "$(presets_rb "P.compose($all, [], [['smoke', '   ']])")" "PlanError: completion_gates[0].reason must be a non-empty string" "P a blank custom reason"
assert_eq "$(presets_rb "P.compose($all, [], [])")" "PlanError: no gates to declare" "P an empty plan"
# Normalization: names and reasons are stripped, as the gate writer strips --reason.
assert_eq "$(presets_rb "P.compose($all, [], [[' smoke ', '  staging smoke  ']])")" '[{"name":"smoke","reason":"staging smoke"}]' "P custom gates are stripped"
printf 'p:\n  - {name: " a ", reason: "  x  ", requires_authorization: " deploy_staging "}\n' > "$RUNS/strip.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/strip.yaml')")" '{"p":[{"name":"a","reason":"x","requires_authorization":"deploy_staging"}]}' "P preset entries are stripped"
# A broken presets file is an Error (exit 3 at open), never a partial set.
printf 'staging: [\n' > "$RUNS/bad.yaml"
[[ "$(presets_rb "P.load('$RUNS/bad.yaml')")" == "Error: presets file $RUNS/bad.yaml cannot be parsed"* ]] || fail "P unparseable presets file: $(presets_rb "P.load('$RUNS/bad.yaml')")"
printf 'staging:\n  - {name: a, reason: "  "}\n' > "$RUNS/blank.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/blank.yaml')")" "Error: preset staging: completion_gates[0].reason must be a non-empty string" "P a blank preset reason"
printf 'staging:\n  - {name: b, reason: x, after: [a]}\n' > "$RUNS/dangling.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/dangling.yaml')")" "Error: preset staging: gate b waits on a, which is not in the preset" "P a dangling after"
printf -- '- staging\n' > "$RUNS/list.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/list.yaml')")" "Error: presets file $RUNS/list.yaml must be a map of preset name to a list of gates" "P not a map"
[[ "$(presets_rb "P.load('$RUNS/missing.yaml')")" == "Error: presets file $RUNS/missing.yaml cannot be read"* ]] || fail "P missing presets file"
# The path hook: honoured only against a non-live runs directory.
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "$RUNS/strip.yaml" "P the hook in a temp runs dir"
assert_eq "$(presets_rb 'P.path')" "$ROOT/tasks/templates/gate-presets.yaml" "P the default path"
assert_eq "$(AI_OFFICE_RUNS_DIR="$ROOT/runs" AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "PlanError: AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory" "P the hook against the live runs"

echo "[PASS] open-task: open a task with gates (#55)"
