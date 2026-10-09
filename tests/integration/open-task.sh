#!/usr/bin/env bash
set -euo pipefail

# Issue #55 — open a task with gates.
#
# `./run-agent.sh open <TASK_ID>` creates task.md, status.yaml and meta.yaml and
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake).

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

# --- N: namespace rules (scripts/task-namespace.rb) ---
REG="$RUNS/office.team.yaml"
# ns <task_id> <prefix> [registry] — prints the refusal message, or "ok".
ns() {
  ruby - "$ROOT" "$1" "$2" "${3:-$REG}" <<'RUBY'
require File.join(ARGV[0], "scripts", "task-namespace")
begin
  TaskNamespace.check_new_task!(ARGV[1], ARGV[2], ARGV[3])
  puts "ok"
rescue TaskNamespace::Refused => e
  puts e.message
end
RUBY
}
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n  GW: "Event gateway (reserved)"\n' > "$REG"
assert_eq "$(ns TASK-EA-001 EA)" "ok" "N own namespace"
assert_eq "$(ns TASK-EA-001 ea)" "ok" "N prefix is case-insensitive"
assert_eq "$(ns TASK-001 EA)" "[ERROR] new task id must use active namespace TASK-EA-NNN; run intake and use its returned id" "N unprefixed id"
assert_eq "$(ns TASK-BOB-001 EA)" "[ERROR] new task id must use active namespace TASK-EA-NNN; run intake and use its returned id" "N another user's namespace"
assert_eq "$(ns TASK-EA-001 '')" "[ERROR] set your Dashboard name before creating a task" "N no prefix while the registry is active"
assert_eq "$(ns TASK-ZZ-001 ZZ)" "[ERROR] prefix ZZ is not registered" "N unregistered prefix"
assert_eq "$(ns TASK-GW-001 GW)" "[ERROR] task prefix GW is reserved for the event gateway's minted TASK-GW-N ids - pick a personal prefix" "N GW prefix"
assert_eq "$(ns TASK-PKG-001 PKG)" "[ERROR] task prefix PKG is reserved for package tasks - pick a personal prefix" "N PKG prefix"
assert_eq "$(ns TASK-EA-001 'e a')" '[ERROR] task prefix "e a" must be letters/digits starting with a letter (e.g. EA, BOB)' "N prefix grammar"
assert_eq "$(ns TASK-001 '' "$RUNS/absent.yaml")" "ok" "N no registry file: solo mode"
printf 'prefixes: {}\n' > "$RUNS/empty.yaml"
assert_eq "$(ns TASK-001 '' "$RUNS/empty.yaml")" "ok" "N empty registry: any valid id"
assert_eq "$(ns TASK-ZZ-001 ZZ "$RUNS/empty.yaml")" "ok" "N empty registry: any prefix"
assert_eq "$(ns TASK-GW-7 '' "$RUNS/empty.yaml")" "[ERROR] TASK-GW-7 is in the reserved GW namespace (reserved for the event gateway's minted TASK-GW-N ids); open a task in your own namespace" "N a reserved id namespace, solo"
assert_eq "$(ns TASK-PKG-001 '' "$RUNS/empty.yaml")" "[ERROR] TASK-PKG-001 is in the reserved PKG namespace (reserved for package tasks); open a task in your own namespace" "N PKG id namespace, solo"
assert_eq "$(ns TASK-12 '' "$RUNS/empty.yaml")" "ok" "N a legacy id in solo mode"
printf 'prefixes: [\n' > "$RUNS/broken.yaml"
[[ "$(ns TASK-001 '' "$RUNS/broken.yaml")" == "[ERROR] office.team.yaml exists but cannot be parsed"* ]] || fail "N a broken registry fails closed: $(ns TASK-001 '' "$RUNS/broken.yaml")"
printf -- '- EA\n' > "$RUNS/list.yaml"
assert_eq "$(ns TASK-001 '' "$RUNS/list.yaml")" "[ERROR] office.team.yaml must be a map with a 'prefixes:' entry (got Array)" "N a registry that is not a map"
# Parity: the PM creation gate and intake in a sandboxed office give the same messages.
OFFICE="$RUNS/office"
mkdir -p "$OFFICE/runs" "$OFFICE/tasks" "$OFFICE/agents"
cp "$ROOT/run-agent.sh" "$OFFICE/"
cp -R "$ROOT/scripts" "$OFFICE/scripts"
printf 'office:\n  name: Sandbox\n' > "$OFFICE/office.config.yaml"
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n' > "$OFFICE/office.team.yaml"
parity_pm() { # <task_id> <prefix> — the PM gate's [ERROR] line must equal the module's message
  local out; out="$(cd "$OFFICE" && OFFICE_TASK_PREFIX="$2" AI_OFFICE_RUNS_DIR="$OFFICE/runs" ./run-agent.sh "$1" pm cursor 2>&1 || true)"
  assert_eq "$(grep -m1 '^\[ERROR\]' <<<"$out")" "$(ns "$1" "$2" "$OFFICE/office.team.yaml")" "N parity with the PM gate for $1 / '$2'"
}
parity_pm TASK-001 EA
parity_pm TASK-BOB-001 EA
parity_pm TASK-EA-001 ""
parity_intake() { # <prefix> — intake's first [ERROR] line must equal the module's message
  local out; out="$(cd "$OFFICE" && OFFICE_TASK_PREFIX="$1" AI_OFFICE_RUNS_DIR="$OFFICE/runs" ./run-agent.sh intake "x" 2>&1 || true)"
  assert_eq "$(grep -m1 '^\[ERROR\]' <<<"$out")" "$(ns TASK-001 "$1" "$OFFICE/office.team.yaml")" "N parity with intake for '$1'"
}
parity_intake GW
parity_intake PKG
parity_intake "e a"

echo "[PASS] open-task: open a task with gates (#55)"
