#!/usr/bin/env bash
set -euo pipefail

# Issue #55 — open a task with gates.
#
# `./run-agent.sh open <TASK_ID>` creates task.md, status.yaml and meta.yaml and
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake), O open (O1-O13), RF Review Focus,
# D docs.

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

# --- O: open ---
GATE="$ROOT/scripts/update-completion-gate.rb"
T0=2026-10-09T01:00:00Z
export OFFICE_TASK_PREFIX=EAR
# opn <args...> — runs the opener; stdout+stderr in $RUNS/open.log; prints the exit code.
opn() { local rc=0; ruby "$ROOT/scripts/open-task.rb" "$@" >"$RUNS/open.log" 2>&1 || rc=$?; echo "$rc"; }
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) do |node, key|
  if node.is_a?(Array) && key.match?(/\A\d+\z/) then node[key.to_i]
  elsif node.is_a?(Hash) then node[key]
  end
end
puts value.nil? ? "" : (value.is_a?(Array) ? value.join(",") : value)
RUBY
}
# gate_bytes <task_dir> — completion_gates and every gate history row (rows after the first), as YAML.
gate_bytes() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0] + "/status.yaml"), permitted_classes: [Date, Time]); print YAML.dump([s["completion_gates"], s["history"].select { |h| h["phase"].to_s.start_with?("gate ") }])' "$1"; }
gate_events() { ruby -ryaml -e 'm = YAML.safe_load(File.read(ARGV[0] + "/meta.yaml")); print m["events"].select { |e| e["type"] == "completion_gate_updated" }.map { |e| [e["agent"], e["details"]].join(" ") }.join("\n")' "$1"; }
# reference <TASK_ID> <ruby list of [name, flags...]> — the same gates declared one by one by the writer.
reference() {
  local dir="$RUNS/$1"; mkdir -p "$dir"
  printf 'task_id: %s\nphase: assigned\nstate: assigned\niteration: 0\ncurrent_agent: dev\nupdated_at: "2026-10-09"\nhistory: []\n' "$1" > "$dir/status.yaml"
  ruby -e 'eval(ARGV[1]).each { |args| system("ruby", ARGV[2], ARGV[0], "declare", *args, "--actor", "pm", out: File::NULL) or abort("writer failed: #{args.inspect}") }' "$1" "$2" "$GATE"
}
preset_writer_args() { # <preset> — the writer flags for each gate of a shipped preset
  ruby -ryaml -e 'puts YAML.safe_load(File.read(ARGV[0]))[ARGV[1]].map { |g| [g["name"], "--reason", g["reason"]] + (g["requires_authorization"] ? ["--requires-authorization", g["requires_authorization"]] : []) + (g["after"] ? ["--after", g["after"].join(",")] : []) + (g["requires_record"] ? ["--requires-record"] : []) }.inspect' "$ROOT/tasks/templates/gate-presets.yaml" "$1"
}

# O1: a preset opens a governed task whose gates are byte-identical to the writer's.
assert_eq "$(AI_OFFICE_NOW=$T0 opn TASK-EAR-901 --title "Staging change" --agent dev --preset staging)" "0" "O1 open ($(cat "$RUNS/open.log"))"
D="$RUNS/TASK-EAR-901"
assert_eq "$(head -1 "$D/task.md")" "# TASK-EAR-901: Staging change" "O1 task.md heading"
assert_eq "$(field "$D/status.yaml" task_label)|$(field "$D/status.yaml" phase)|$(field "$D/status.yaml" state)|$(field "$D/status.yaml" iteration)|$(field "$D/status.yaml" current_agent)|$(field "$D/status.yaml" ready)|$(field "$D/status.yaml" assignment.primary)" "Staging change|assigned|assigned|0|dev|true|dev" "O1 status fields"
assert_eq "$(field "$D/status.yaml" history.0.phase)|$(field "$D/status.yaml" history.0.agent)|$(field "$D/status.yaml" history.0.reason)" "created -> assigned|pm|opened with completion gates: implementation_verification, deploy_staging, staging_acceptance" "O1 created row"
AI_OFFICE_NOW=$T0 reference TASK-EAR-902 "$(preset_writer_args staging)"
assert_eq "$(gate_bytes "$D")" "$(gate_bytes "$RUNS/TASK-EAR-902")" "O1 gate records and history rows are the writer's bytes"
assert_eq "$(gate_events "$D")" "$(gate_events "$RUNS/TASK-EAR-902")" "O1 completion_gate_updated events are the writer's"
assert_eq "$(ruby -ryaml -e 'm = YAML.safe_load(File.read(ARGV[0])); e = m["events"].first; print [e["type"], e["agent"], e["details"]].join(" | ")' "$D/meta.yaml")" "task_opened | pm | gates=implementation_verification,deploy_staging,staging_acceptance" "O1 task_opened event"
ruby "$ROOT/validate-yaml.rb" "$D" >"$RUNS/validate.log" 2>&1 || fail "O1 validate-yaml: $(cat "$RUNS/validate.log")"
grep -qxF "Gates: 0/3 resolved" <<<"$(bash "$ROOT/run-agent.sh" status TASK-EAR-901)" || fail "O1 status Gates block: $(bash "$ROOT/run-agent.sh" status TASK-EAR-901)"
assert_eq "$(ruby "$ROOT/scripts/gate-view-json.rb" "$D" | ruby -rjson -e 'print JSON.parse(STDIN.read)["readable"]')" "true" "O1 gate view readable"
# A custom reason with surrounding spaces is stored stripped, as the writer stores --reason.
assert_eq "$(AI_OFFICE_NOW=$T0 opn TASK-EAR-903 --title x --gate "smoke:  staging smoke  ")" "0" "O1 custom gate ($(cat "$RUNS/open.log"))"
AI_OFFICE_NOW=$T0 reference TASK-EAR-904 '[["smoke", "--reason", "  staging smoke  "]]'
assert_eq "$(gate_bytes "$RUNS/TASK-EAR-903")" "$(gate_bytes "$RUNS/TASK-EAR-904")" "O1 stripped custom reason matches the writer"

# O2: composition.
assert_eq "$(opn TASK-EAR-905 --title x --preset production)" "0" "O2 production"
assert_eq "$(field "$RUNS/TASK-EAR-905/status.yaml" completion_gates.deploy_production.after)" "staging_acceptance" "O2 production follows the staging chain"
assert_eq "$(opn TASK-EAR-906 --title x --preset staging --preset production --preset backfill)" "0" "O2 staging + production + backfill"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0]))["completion_gates"].keys.join(",")' "$RUNS/TASK-EAR-906/status.yaml")" "implementation_verification,deploy_staging,staging_acceptance,deploy_production,production_acceptance,production_backfill" "O2 merged order"

# O3: custom gates after presets; a conflicting definition is refused and nothing is written.
assert_eq "$(opn TASK-EAR-907 --title x --preset backfill --gate "docs:docs updated")" "0" "O3 preset + custom"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0]))["completion_gates"].keys.join(",")' "$RUNS/TASK-EAR-907/status.yaml")" "production_backfill,docs" "O3 order"
assert_eq "$(opn TASK-EAR-908 --title x --preset staging --gate "deploy_staging:by hand")" "2" "O3 conflict"
grep -qF "defined differently" "$RUNS/open.log" || fail "O3 conflict message: $(cat "$RUNS/open.log")"
[[ ! -e "$RUNS/TASK-EAR-908" ]] || fail "O3 a refused open wrote the task"

# O4: --no-gates records its reason; it cannot be combined.
assert_eq "$(opn TASK-EAR-909 --title "Docs fix" --no-gates "  docs only  ")" "0" "O4 no gates"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0])).key?("completion_gates")' "$RUNS/TASK-EAR-909/status.yaml")" "false" "O4 no completion_gates key"
assert_eq "$(field "$RUNS/TASK-EAR-909/status.yaml" history.0.reason)|$(field "$RUNS/TASK-EAR-909/status.yaml" phase)" "opened without completion gates: docs only|pending" "O4 reason recorded, default pm is pending"
grep -qF "details: gates=none reason=docs only" "$RUNS/TASK-EAR-909/meta.yaml" || fail "O4 task_opened details: $(cat "$RUNS/TASK-EAR-909/meta.yaml")"
assert_eq "$(opn TASK-EAR-910 --title x --no-gates "docs" --preset staging)" "2" "O4 --no-gates with --preset"
assert_eq "$(opn TASK-EAR-910 --title x --no-gates "   ")" "2" "O4 a blank --no-gates reason"

# O5: a gate decision and a title are required.
assert_eq "$(opn TASK-EAR-910 --title x)" "2" "O5 no gate decision"
grep -qF -- "--no-gates" "$RUNS/open.log" || fail "O5 guidance: $(cat "$RUNS/open.log")"
assert_eq "$(opn TASK-EAR-910 --preset staging)" "2" "O5 no title"
assert_eq "$(opn TASK-EAR-910 --title "   " --preset staging)" "2" "O5 a blank title"
assert_eq "$(opn TASK-EAR-910 --title x --preset staging --colour red)" "2" "O5 an unknown flag"
assert_eq "$(opn task-ear-910 --title x --preset staging)" "2" "O5 a malformed id"
[[ ! -e "$RUNS/TASK-EAR-910" ]] || fail "O5 a refused open wrote the task"

# O6: namespace (the live registry lists EAR, KAS, VS and the reserved GW).
assert_eq "$(OFFICE_TASK_PREFIX=VS opn TASK-EAR-911 --title x --no-gates y)" "1" "O6 someone else's namespace"
assert_eq "$(OFFICE_TASK_PREFIX=ZZ opn TASK-ZZ-001 --title x --no-gates y)" "1" "O6 an unregistered prefix"
assert_eq "$(OFFICE_TASK_PREFIX=GW opn TASK-GW-001 --title x --no-gates y)" "1" "O6 the reserved GW prefix"
assert_eq "$(opn TASK-GW-12 --title x --no-gates y)" "1" "O6 a reserved id namespace"
grep -qF "reserved GW namespace" "$RUNS/open.log" || fail "O6 reserved message: $(cat "$RUNS/open.log")"
# An empty registry (solo mode), in a sandboxed office.
SOLO="$RUNS/solo"
mkdir -p "$SOLO/runs"
cp "$ROOT/run-agent.sh" "$ROOT/validate-yaml.rb" "$SOLO/"
cp -R "$ROOT/scripts" "$ROOT/tasks" "$SOLO/"
printf 'office:\n  name: Sandbox\n' > "$SOLO/office.config.yaml"
printf 'prefixes: {}\n' > "$SOLO/office.team.yaml"
rc=0; OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-001 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O6 solo mode opens any valid id ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/TASK-001/status.yaml" ]] || fail "O6 solo task not written"

# O7: an existing task is never touched.
before="$(find "$RUNS/TASK-EAR-901" -type f -exec shasum {} + | sort)"
assert_eq "$(opn TASK-EAR-901 --title other --no-gates y)" "4" "O7 existing task"
assert_eq "$(find "$RUNS/TASK-EAR-901" -type f -exec shasum {} + | sort)" "$before" "O7 existing files unchanged"

# O8: a broken presets file is exit 3; the hook against live runs is exit 2.
printf 'staging: [\n' > "$RUNS/bad-presets.yaml"
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/bad-presets.yaml" opn TASK-EAR-912 --title x --preset staging)" "3" "O8 unparseable presets"
printf 'staging:\n  - {name: a, reason: "  "}\n' > "$RUNS/blank-presets.yaml"
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/blank-presets.yaml" opn TASK-EAR-912 --title x --preset staging)" "3" "O8 a blank preset reason"
[[ ! -e "$RUNS/TASK-EAR-912" ]] || fail "O8 a refused open wrote the task"
rc=0; AI_OFFICE_RUNS_DIR="$SOLO/runs" AI_OFFICE_GATE_PRESETS="$RUNS/bad-presets.yaml" OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-002 --title x --preset staging >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O8 the presets hook against the live runs"
[[ ! -e "$SOLO/runs/TASK-002" ]] || fail "O8 the live-runs refusal wrote the task"

# O9: Thai text with no locale is stored as UTF-8, never !binary.
rc=0; env -u LANG -u LC_ALL -u LC_CTYPE ruby "$ROOT/scripts/open-task.rb" TASK-EAR-913 --title "ทดสอบเปิดงาน" --gate "smoke:ตรวจบน staging" >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O9 Thai open ($(cat "$RUNS/open.log"))"
! grep -q '!binary' "$RUNS/TASK-EAR-913/status.yaml" || fail "O9 status.yaml stored !binary"
assert_eq "$(field "$RUNS/TASK-EAR-913/status.yaml" task_label)|$(field "$RUNS/TASK-EAR-913/status.yaml" completion_gates.smoke.reason)" "ทดสอบเปิดงาน|ตรวจบน staging" "O9 Thai text"

# O10: assignable roles only.
assert_eq "$(opn TASK-EAR-914 --title x --agent done --no-gates y)" "2" "O10 --agent done"
assert_eq "$(opn TASK-EAR-914 --title x --agent boss --no-gates y)" "2" "O10 an unknown agent"
assert_eq "$(opn TASK-EAR-914 --title x --actor orchestrator --no-gates y)" "2" "O10 an actor that is not an assignable role"
assert_eq "$(opn TASK-EAR-914 --title x --agent devops --actor dev --no-gates y)" "0" "O10 devops"
assert_eq "$(field "$RUNS/TASK-EAR-914/status.yaml" phase)|$(field "$RUNS/TASK-EAR-914/status.yaml" history.0.agent)" "assigned|dev" "O10 phase and actor"

# O11: two concurrent opens of one id: exactly one succeeds.
for i in 1 2 3 4 5 6; do
  ( rc=0; ruby "$ROOT/scripts/open-task.rb" TASK-EAR-920 --title "race $i" --no-gates y >/dev/null 2>&1 || rc=$?; echo "$rc" > "$RUNS/race-$i" ) &
done
wait
assert_eq "$(cat "$RUNS"/race-* | sort | tr '\n' ' ')" "0 4 4 4 4 4 " "O11 one winner, the rest exit 4"
ruby "$ROOT/validate-yaml.rb" "$RUNS/TASK-EAR-920" >"$RUNS/validate.log" 2>&1 || fail "O11 the winner's task is valid: $(cat "$RUNS/validate.log")"

# O12: run-agent.sh open passes the exit status through; intake shows the open line.
rc=0; bash "$ROOT/run-agent.sh" open TASK-EAR-921 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O12 run-agent.sh open ($(cat "$RUNS/open.log"))"
rc=0; bash "$ROOT/run-agent.sh" open TASK-EAR-922 --title x >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O12 run-agent.sh open passes exit 2 through"
grep -qF 'Or open it as a conductor: ./run-agent.sh open TASK-EAR-' <<<"$(bash "$ROOT/run-agent.sh" intake "Fix the wallet callback")" || fail "O12 intake open line: $(bash "$ROOT/run-agent.sh" intake "Fix the wallet callback")"

# O13: any write failure after mkdir rolls the open back (exit 5, no directory left).
for step in task_md status meta; do
  assert_eq "$(AI_OFFICE_OPEN_FAIL_AT=$step opn TASK-EAR-930 --title x --preset staging)" "5" "O13 failure at $step"
  [[ ! -e "$RUNS/TASK-EAR-930" ]] || fail "O13 failure at $step left the task directory"
done
assert_eq "$(AI_OFFICE_OPEN_FAIL_AT=meta opn TASK-EAR-930 --title x --no-gates "docs only")" "5" "O13 failure at the only meta event"
[[ ! -e "$RUNS/TASK-EAR-930" ]] || fail "O13 failure at the only meta event left the task directory"
assert_eq "$(opn TASK-EAR-930 --title x --preset staging)" "0" "O13 the same id then opens"
rc=0; AI_OFFICE_RUNS_DIR="$SOLO/runs" AI_OFFICE_OPEN_FAIL_AT=meta OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-003 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O13 the failure hook against the live runs"
[[ ! -e "$SOLO/runs/TASK-003" ]] || fail "O13 the live-runs refusal wrote the task"

# --- Review Focus ---
# RF1: the gate writer accepts an opened task, and the preset's ordering holds.
rc=0; ruby "$GATE" TASK-EAR-901 pass implementation_verification --actor dev --reason "suite green" --ran-by dev --ran-ref abc123 >"$RUNS/gate.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "RF1 the writer passes a gate of an opened task ($(cat "$RUNS/gate.log"))"
rc=0; ruby "$GATE" TASK-EAR-901 pass staging_acceptance --actor dev --reason early --ran-by dev --ran-ref abc123 >"$RUNS/gate.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "RF1 staging_acceptance still waits on deploy_staging"
grep -qF "waits on: deploy_staging (pending)" "$RUNS/gate.log" || fail "RF1 ordering message: $(cat "$RUNS/gate.log")"
# RF2: a custom reason keeps everything after the first colon.
assert_eq "$(opn TASK-EAR-940 --title x --gate "smoke:check: staging, then prod")" "0" "RF2 colon in a reason"
assert_eq "$(field "$RUNS/TASK-EAR-940/status.yaml" completion_gates.smoke.reason)" "check: staging, then prod" "RF2 reason kept whole"
# RF3: preset names are exact; another case is refused with the known list.
assert_eq "$(opn TASK-EAR-941 --title x --preset Staging)" "2" "RF3 --preset Staging"
grep -qF "unknown preset 'Staging' (known: staging, production, backfill)" "$RUNS/open.log" || fail "RF3 message: $(cat "$RUNS/open.log")"
# RF4: a multi-line description lands in task.md verbatim; status.yaml stays valid.
assert_eq "$(opn TASK-EAR-942 --title x --no-gates y --description "$(printf 'Scope:\n- line one\n- line two')")" "0" "RF4 multi-line description"
assert_eq "$(sed -n 3,5p "$RUNS/TASK-EAR-942/task.md")" "$(printf 'Scope:\n- line one\n- line two')" "RF4 task.md body"
ruby "$ROOT/validate-yaml.rb" "$RUNS/TASK-EAR-942" >"$RUNS/validate.log" 2>&1 || fail "RF4 validate: $(cat "$RUNS/validate.log")"
# RF5: a runs directory that does not exist yet is created.
rc=0; AI_OFFICE_RUNS_DIR="$RUNS/fresh/runs" ruby "$ROOT/scripts/open-task.rb" TASK-EAR-943 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "RF5 a fresh runs directory ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/fresh/runs/TASK-EAR-943/status.yaml" ]] || fail "RF5 task not written"

# --- D: conductors are told to open tasks this way ---
grep -qF './run-agent.sh open <TASK_ID>' "$ROOT/AGENTS.md" || fail "D AGENTS.md does not tell conductors to open tasks with run-agent.sh open"
grep -qF 'never by hand-writing' "$ROOT/AGENTS.md" || fail "D AGENTS.md does not forbid hand-written status.yaml"
grep -qF './run-agent.sh open <TASK_ID>' "$ROOT/docs/codex.md" || fail "D docs/codex.md lacks the open rule"
grep -qF '## Opening a task with gates (#55)' "$ROOT/docs/completion-gates.md" || fail "D docs/completion-gates.md lacks the section"
grep -qF 'run-agent.sh open <TASK_ID>' "$ROOT/docs/skills/office-intake.md" || fail "D office-intake guide lacks the open step"
for preset in staging production backfill; do
  grep -qF "| \`$preset\` |" "$ROOT/docs/completion-gates.md" || fail "D completion-gates.md does not list preset $preset"
done

echo "[PASS] open-task: open a task with gates (#55)"
