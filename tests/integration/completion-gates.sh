#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 1A — completion gates.
#
# A task that declares `completion_gates` in status.yaml cannot reach `done`
# through any supported writer while a gate is unresolved. Tasks with no
# `completion_gates` behave exactly as before.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SYNC="$ROOT_DIR/scripts/sync-status-from-output.rb"
RECONCILE="$ROOT_DIR/scripts/reconcile-decision.rb"
FORCE="$ROOT_DIR/scripts/force-status-route.rb"
DECIDE="$ROOT_DIR/scripts/decide-next-step.rb"
GATE="$ROOT_DIR/scripts/update-completion-gate.rb"
BLOCKED_STATUS="$ROOT_DIR/scripts/reconcile-blocked-status.rb"
VALIDATOR="$ROOT_DIR/validate-yaml.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
# The ownership fence is irrelevant here: no ownership.yaml exists, so writes
# are ungoverned-and-allowed. Make sure a leaked epoch from a parent run
# cannot change that.
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
trap 'rm -rf "$TMP_RUNS"' EXIT

fail() { echo "[FAIL] $1"; exit 1; }

assert_eq() {
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

# yaml_get <file> <dotted.key.path> — prints the value, or empty when absent.
yaml_get() {
  ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
v = ARGV[1].split(".").reduce(d) { |n, k| n.is_a?(Hash) ? n[k] : nil }
puts v.nil? ? "" : v.to_s
RUBY
}

# event_count <task_dir> <type> — number of meta.yaml events of that type.
event_count() {
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
unless File.exist?(path)
  puts 0
  exit 0
end
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts Array(d["events"]).count { |e| e.is_a?(Hash) && e["type"] == type }
RUBY
}

# last_event_details <task_dir> <type>
last_event_details() {
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
e = Array(d["events"]).reverse.find { |x| x.is_a?(Hash) && x["type"] == type }
puts e ? e["details"].to_s : ""
RUBY
}

new_task() {  # <task_id> — creates and echoes the task dir
  local dir="$TMP_RUNS/$1"
  mkdir -p "$dir"
  echo "$dir"
}

# write_status <task_dir> <task_id> <phase> [<extra yaml, already indented as top-level keys>]
write_status() {
  cat > "$1/status.yaml" <<YAML
task_id: $2
phase: $3
state: $3
iteration: 1
current_agent: reviewer
${4:-}
YAML
}

write_reviewer_approved() {  # <task_dir>
  cat > "$1/reviewer-output.yaml" <<'YAML'
review_verdict: approved
next_action:
  agent: done
  reason: approved
YAML
}

PENDING_GATE='completion_gates:
  authenticated_runtime:
    status: pending
    evidence_refs: []'

# ---------------------------------------------------------------------------
# Task 1 — the shared guard (unit level)
# ---------------------------------------------------------------------------
ruby - "$ROOT_DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")

def check(cond, msg)
  abort "[FAIL] guard: #{msg}" unless cond
end

allowed = CompletionGuard.can_transition_to_done({})
check allowed.allowed && allowed.unresolved.empty?, "no completion_gates key must allow done (backward compatible)"

check CompletionGuard.can_transition_to_done({ "completion_gates" => {} }).allowed,
      "an empty completion_gates map must allow done"

pending = CompletionGuard.can_transition_to_done(
  "completion_gates" => { "authenticated_runtime" => { "status" => "pending" } }
)
check !pending.allowed && pending.unresolved == ["authenticated_runtime"], "pending gate must block done"

mixed = CompletionGuard.can_transition_to_done(
  "completion_gates" => {
    "source_verification" => { "status" => "pass" },
    "deployment" => { "status" => "na" },
    "authenticated_runtime" => { "status" => "pending" },
    "another" => { "status" => "pending" }
  }
)
check mixed.unresolved == %w[another authenticated_runtime], "unresolved must be the sorted pending gate names, got #{mixed.unresolved.inspect}"

resolved = CompletionGuard.can_transition_to_done(
  "completion_gates" => { "a" => { "status" => "pass" }, "b" => { "status" => "na" } }
)
check resolved.allowed, "all pass/na must allow done"

# Fail closed on malformed state: a gate the guard cannot read is not resolved.
check !CompletionGuard.can_transition_to_done("completion_gates" => { "a" => "pass" }).allowed,
      "a non-map gate record must block done"
check !CompletionGuard.can_transition_to_done("completion_gates" => { "a" => { "status" => "passed" } }).allowed,
      "an unknown gate status must block done"
check !CompletionGuard.can_transition_to_done("completion_gates" => ["a"]).allowed,
      "a non-map completion_gates must block done"

check CompletionGuard.blocked_message(%w[a b]).include?("a, b"), "message must name every unresolved gate"
check CompletionGuard.event_agent("reviewer") == "reviewer", "known actor maps to itself"
check CompletionGuard.event_agent("Sichol") == "orchestrator", "free-text actor maps to orchestrator on events"
check CompletionGuard::GATE_STATUSES == %w[pending pass na], "gate statuses are exactly pending/pass/na"
check CompletionGuard::COMPLETION_BLOCKED == 5, "refusal exit code is 5"
RUBY
echo "[ok] completion-guard unit checks"

# ---------------------------------------------------------------------------
# Task 2 — the three writers are bound by the guard
# ---------------------------------------------------------------------------

# Test A — VS-008-style pending runtime gate: reviewer approval is refused.
DIR="$(new_task TASK-901)"
write_status "$DIR" TASK-901 review "$PENDING_GATE"
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-901 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>"$TMP_RUNS/err" || rc=$?
assert_eq "5" "$rc" "A: sync must exit 5 (completion blocked)"
grep -q "authenticated_runtime" "$TMP_RUNS/err" || fail "A: the refusal must name the unresolved gate"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "A: phase must stay review"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" current_agent)" "A: routing must not change"
assert_eq "" "$(yaml_get "$DIR/status.yaml" validation_failed_retries)" "A: no validation retry consumed"
assert_eq "" "$(yaml_get "$DIR/status.yaml" last_synced_output.digest)" "A: refused output must not be recorded as synced"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "A: one completion_blocked event"
assert_eq "attempted=review -> done unresolved=authenticated_runtime" \
  "$(last_event_details "$DIR" completion_blocked)" "A: event carries the attempted transition and unresolved gates"

# Re-running the same refused sync is de-duplicated, not spammed.
rc=0
ruby "$SYNC" TASK-901 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "A: a retry is refused the same way"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "A: an identical refusal is not logged twice"

# Test B — a human `approve` must not bypass the invariant (approve -> done).
DIR="$(new_task TASK-902)"
write_status "$DIR" TASK-902 in_review "$PENDING_GATE"
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-902
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T01:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-902 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "B: reconcile must report the held decision"
assert_eq "in_review" "$(yaml_get "$DIR/status.yaml" phase)" "B: task must not become done"
assert_eq "" "$(yaml_get "$DIR/status.yaml" decision_applied_at)" "B: a held decision stays pending, not applied"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "B: completion_blocked recorded"
out="$(ruby "$RECONCILE" TASK-902 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "B: still held on the next dispatch"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "B: repeat attempts are de-duplicated"

# Test C — force-status-route ... done is bound by the same guard.
DIR="$(new_task TASK-903)"
write_status "$DIR" TASK-903 review "$PENDING_GATE"
rc=0
ruby "$FORCE" TASK-903 "$DIR/status.yaml" 2026-09-30 done done orchestrator "operator forced done" >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "C: force ... done must be refused (no implicit bypass)"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "C: phase must stay review"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "C: completion_blocked recorded"

# Force to a non-done phase is untouched by the guard.
rc=0
ruby "$FORCE" TASK-903 "$DIR/status.yaml" 2026-09-30 free-roam escalated orchestrator "loop guard" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "C: forcing a non-done phase is not affected"
assert_eq "escalated" "$(yaml_get "$DIR/status.yaml" phase)" "C: non-done force still lands"

# Test F — backward compatibility: no completion_gates key, nothing changes.
DIR="$(new_task TASK-904)"
write_status "$DIR" TASK-904 review ""
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-904 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F: a task without completion_gates syncs to done as before"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: phase is done"
assert_eq "0" "$(event_count "$DIR" completion_blocked)" "F: no completion_blocked event"

DIR="$(new_task TASK-905)"
write_status "$DIR" TASK-905 in_review ""
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-905
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T01:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-905 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "F: approve without gates still applies"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: approve without gates is done"

DIR="$(new_task TASK-906)"
write_status "$DIR" TASK-906 review ""
ruby "$FORCE" TASK-906 "$DIR/status.yaml" 2026-09-30 done done orchestrator "operator" >/dev/null 2>&1
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F: force done without gates still works"

# Resolved gates do not block.
DIR="$(new_task TASK-907)"
write_status "$DIR" TASK-907 review 'completion_gates:
  authenticated_runtime:
    status: na
    actor: reviewer
    reason: no runtime-facing component changed
    updated_at: "2026-09-30T00:00:00Z"'
write_reviewer_approved "$DIR"
rc=0
ruby "$SYNC" TASK-907 reviewer "$DIR/status.yaml" "$DIR/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "resolved gates allow done"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "resolved gates -> done"
echo "[ok] writers enforce the guard (A, B, C, F)"

# ---------------------------------------------------------------------------
# Task 3 — the auto loop must not claim completion the guard refused
# ---------------------------------------------------------------------------
DIR="$(new_task TASK-910)"
write_status "$DIR" TASK-910 review "$PENDING_GATE"
write_reviewer_approved "$DIR"
assert_eq "next=done terminal=true" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" 2>/dev/null)" \
  "decide-next-step without a status file is unchanged"
assert_eq "next= terminal=false" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" \
  "decide-next-step must not report terminal while a gate is pending"

DIR="$(new_task TASK-911)"
write_status "$DIR" TASK-911 review ""
write_reviewer_approved "$DIR"
assert_eq "next=done terminal=true" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" \
  "a task without gates is still terminal on done"
echo "[ok] auto-loop decision respects the guard"

# ---------------------------------------------------------------------------
# Task 4 — the governed gate writer (D, E) and dependency release
# ---------------------------------------------------------------------------
gate() { ruby "$GATE" "$@"; }

DIR="$(new_task TASK-920)"
write_status "$DIR" TASK-920 review ""

# declare
out="$(gate TASK-920 declare authenticated_runtime --actor pm --reason "prod branch page must show API/LINE counts")"
assert_eq "gate authenticated_runtime: absent -> pending" "$out" "declare output"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "declare sets pending"
assert_eq "pm" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.actor)" "declare records the actor"
assert_eq "1" "$(event_count "$DIR" completion_gate_updated)" "declare is auditable in meta.yaml"

# declaring twice, unknown gate, bad name, missing actor, missing reason: all refused
rc=0; gate TASK-920 declare authenticated_runtime --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "re-declaring an existing gate is refused"
rc=0; gate TASK-920 pass no_such_gate --actor dev --reason x >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "resolving an undeclared gate is refused"
rc=0; gate TASK-920 declare Bad-Name --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "gate names must match the grammar"
rc=0; gate TASK-920 pass authenticated_runtime --reason "looks fine" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "pass without an actor is refused"
rc=0; gate TASK-920 pass authenticated_runtime --actor dev >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "pass without a reason is refused"
rc=0; gate TASK-920 na authenticated_runtime --actor reviewer >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "na without a reason is refused"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "refused edits leave the gate untouched"

# Test D — legitimate `na`: audit record exists and completion becomes possible.
out="$(gate TASK-920 na authenticated_runtime --actor reviewer --reason "no runtime-facing component changed after investigation")"
assert_eq "gate authenticated_runtime: pending -> na" "$out" "na output"
assert_eq "na" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.status)" "D: gate is na"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.actor)" "D: actor recorded"
assert_eq "no runtime-facing component changed after investigation" \
  "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.reason)" "D: reason recorded"
[[ -n "$(yaml_get "$DIR/status.yaml" completion_gates.authenticated_runtime.updated_at)" ]] || fail "D: updated_at recorded"
assert_eq "2" "$(event_count "$DIR" completion_gate_updated)" "D: the na change is in the execution trail (meta)"
grep -q "gate authenticated_runtime: pending -> na" "$DIR/status.yaml" || fail "D: the na change is in status history"
ruby -e 'require ARGV[0]; s = YAML.safe_load(File.read(ARGV[1])); exit(CompletionGuard.can_transition_to_done(s).allowed ? 0 : 1)' \
  "$ROOT_DIR/scripts/completion-guard" "$DIR/status.yaml" || fail "D: after na the guard must allow done"

# Test E — evidence-backed pass with an explicit acceptance judgment.
DIR="$(new_task TASK-921)"
write_status "$DIR" TASK-921 review ""
gate TASK-921 declare deployment --actor pm >/dev/null
rc=0; gate TASK-921 pass deployment --actor dev --reason "deployed" --evidence ev-001 >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "E: an evidence id that does not resolve is refused"
assert_eq "pending" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.status)" "E: refused pass leaves the gate pending"
( cd "$ROOT_DIR" && bash scripts/record-evidence.sh TASK-921 -- true >/dev/null 2>&1 ) || fail "E: could not record evidence for the test"
EV_ID="$(ruby -e 'require "yaml"; puts YAML.safe_load(File.read(ARGV[0]))["evidence"].last["id"]' "$DIR/evidence.yaml")"
out="$(gate TASK-921 pass deployment --actor dev --reason "ECS service reports the new image healthy" --evidence "$EV_ID")"
assert_eq "gate deployment: pending -> pass" "$out" "E: pass output"
assert_eq "pass" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.status)" "E: gate is pass"
grep -q -- "- $EV_ID" "$DIR/status.yaml" || fail "E: evidence ref $EV_ID must be stored on the gate"
assert_eq "ECS service reports the new image healthy" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.reason)" "E: acceptance reason stored"

# The helper refuses to edit gates on a finished task (no done + pending).
DIR="$(new_task TASK-922)"
write_status "$DIR" TASK-922 done ""
rc=0; gate TASK-922 declare late_gate --actor pm >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "gates cannot be declared on a done task"

# Dependency release: a pending gate upstream must keep downstream blocked; once
# the gate resolves and done lands, dependency reconciliation releases it.
UP="$(new_task TASK-930)"; DOWN="$(new_task TASK-931)"
write_status "$UP" TASK-930 review ""
gate TASK-930 declare authenticated_runtime --actor pm >/dev/null
write_reviewer_approved "$UP"
cat > "$DOWN/status.yaml" <<'YAML'
task_id: TASK-931
phase: blocked
state: blocked
iteration: 0
current_agent: pm
blocked_on:
  - TASK-930
YAML
rc=0; ruby "$SYNC" TASK-930 reviewer "$UP/status.yaml" "$UP/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "dependency: upstream done is refused while its gate is pending"
ruby "$BLOCKED_STATUS" TASK-931 "$DOWN/status.yaml" "$TMP_RUNS" 2026-09-30 done in_review true true true >/dev/null 2>&1
assert_eq "blocked" "$(yaml_get "$DOWN/status.yaml" phase)" "dependency: downstream stays blocked while upstream is not done"

gate TASK-930 na authenticated_runtime --actor reviewer --reason "no runtime-facing change" >/dev/null
ruby "$SYNC" TASK-930 reviewer "$UP/status.yaml" "$UP/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1
assert_eq "done" "$(yaml_get "$UP/status.yaml" phase)" "dependency: upstream reaches done once the gate is resolved"
ruby "$BLOCKED_STATUS" TASK-931 "$DOWN/status.yaml" "$TMP_RUNS" 2026-09-30 done in_review true true true >/dev/null 2>&1
[[ "$(yaml_get "$DOWN/status.yaml" phase)" != "blocked" ]] || fail "dependency: downstream must be released once the upstream reaches done"
echo "[ok] gate writer (D, E) and dependency release"

# ---------------------------------------------------------------------------
# Task 5 — stored-state validation (G) and shape rules
# ---------------------------------------------------------------------------
expect_valid()   { ruby "$VALIDATOR" "$1" >/dev/null 2>&1 || fail "$2 (validation unexpectedly failed)"; }
expect_invalid() {  # <task_dir> <message> <substring the errors must mention>
  local out
  out="$(ruby "$VALIDATOR" "$1" 2>&1)" && fail "$2 (validation unexpectedly passed)"
  grep -q "$3" <<<"$out" || fail "$2 (expected the errors to mention '$3', got: $out)"
}

# Test G — a manually corrupted stored state: done + a pending gate.
DIR="$(new_task TASK-940)"
write_status "$DIR" TASK-940 done "$PENDING_GATE"
expect_invalid "$DIR" "G: done with a pending gate must fail validation" "unresolved completion gate"

# Same task in review is fine.
write_status "$DIR" TASK-940 review "$PENDING_GATE"
expect_valid "$DIR" "a pending gate is valid while the task is not done"

# Backward compatibility: no completion_gates key.
write_status "$DIR" TASK-940 done ""
expect_valid "$DIR" "F: a done task without gates still validates"

# Resolved gates on a done task validate.
write_status "$DIR" TASK-940 done 'completion_gates:
  authenticated_runtime:
    status: na
    actor: reviewer
    reason: no runtime-facing component changed
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs: []'
expect_valid "$DIR" "done with all gates resolved validates"

# Shape rules.
write_status "$DIR" TASK-940 review 'completion_gates:
  authenticated_runtime:
    status: pass'
expect_invalid "$DIR" "pass without actor/reason/updated_at is invalid" "actor"

write_status "$DIR" TASK-940 review 'completion_gates:
  authenticated_runtime:
    status: passed'
expect_invalid "$DIR" "an unknown gate status is invalid" "status"

write_status "$DIR" TASK-940 review 'completion_gates:
  Bad-Name:
    status: pending'
expect_invalid "$DIR" "a bad gate name is invalid" "gate name"

write_status "$DIR" TASK-940 review 'completion_gates:
  - authenticated_runtime'
expect_invalid "$DIR" "completion_gates must be a map" "completion_gates"

write_status "$DIR" TASK-940 review 'completion_gates:
  deployment:
    status: pass
    actor: dev
    reason: deployed
    updated_at: "2026-09-30T00:00:00Z"
    evidence_refs:
      - ev-099'
expect_invalid "$DIR" "a pass gate citing evidence that does not exist is invalid" "evidence"
echo "[ok] stored-state validation (G) and shape rules"

# ---------------------------------------------------------------------------
# Final fix wave — devops `done`, stale held approve, dedupe by agent
# ---------------------------------------------------------------------------
write_devops_done() {  # <task_dir>
  cat > "$1/devops-output.yaml" <<'YAML'
summary: standalone infra task finished
next_action:
  agent: done
  reason: infra change complete
YAML
}

# F1 — devops next_action.agent: done is guarded even though the phase table keeps old_phase.
DIR="$(new_task TASK-950)"
write_status "$DIR" TASK-950 devops_needed "$PENDING_GATE"
write_devops_done "$DIR"
rc=0
ruby "$SYNC" TASK-950 devops "$DIR/status.yaml" "$DIR/devops-output.yaml" 2026-09-30 devops_needed >/dev/null 2>"$TMP_RUNS/err" || rc=$?
assert_eq "5" "$rc" "F1: devops done with a pending gate must exit 5"
assert_eq "devops_needed" "$(yaml_get "$DIR/status.yaml" phase)" "F1: phase unchanged"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" current_agent)" "F1: current_agent unchanged"
assert_eq "" "$(yaml_get "$DIR/status.yaml" last_synced_output.digest)" "F1: refused output not recorded as synced"
assert_eq "1" "$(event_count "$DIR" completion_blocked)" "F1: completion_blocked recorded"

DIR="$(new_task TASK-951)"
write_status "$DIR" TASK-951 devops_needed ""
write_devops_done "$DIR"
rc=0
ruby "$SYNC" TASK-951 devops "$DIR/status.yaml" "$DIR/devops-output.yaml" 2026-09-30 devops_needed >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F1: devops done without gates still syncs"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" current_agent)" "F1: no gates -> current_agent done as before"

DIR="$(new_task TASK-952)"
write_status "$DIR" TASK-952 review "$PENDING_GATE"
rc=0
ruby "$FORCE" TASK-952 "$DIR/status.yaml" 2026-09-30 done review orchestrator "x" >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "F1: force next_agent=done with a non-done phase is refused"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "F1: force left status untouched"
assert_eq "reviewer" "$(yaml_get "$DIR/status.yaml" current_agent)" "F1: force left routing untouched"
echo "[ok] F1 devops done guarded"

# F2 — held human approve vs a task that moved on.
write_decision() {  # <task_dir> <task_id> <against_phase or empty>
  {
    echo "task_id: $2"
    echo "decisions:"
    echo "  - decision: approve"
    echo "    actor: alice"
    echo "    decided_at: \"2026-09-30T01:00:00Z\""
    [[ -n "${3:-}" ]] && echo "    against_phase: $3"
  } > "$1/decision.yaml"
  return 0
}

DIR="$(new_task TASK-960)"
write_status "$DIR" TASK-960 in_review "$PENDING_GATE"
write_decision "$DIR" TASK-960 in_review
out="$(ruby "$RECONCILE" TASK-960 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "F2: held while gate pending"
gate TASK-960 na authenticated_runtime --actor reviewer --reason "not runtime facing" >/dev/null
out="$(ruby "$RECONCILE" TASK-960 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "F2: unchanged phase -> held approve applies once gates resolve"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F2: task done"

DIR="$(new_task TASK-961)"
write_status "$DIR" TASK-961 in_review "$PENDING_GATE"
write_decision "$DIR" TASK-961 in_review
out="$(ruby "$RECONCILE" TASK-961 2>/dev/null)"
assert_eq "blocked:approve:authenticated_runtime" "$out" "F2: held (stale scenario)"
ruby - "$DIR/status.yaml" <<'RUBY'
require "yaml"
s = YAML.safe_load(File.read(ARGV[0]))
s["phase"] = "debugging"; s["state"] = "debugging"
File.write(ARGV[0], YAML.dump(s))
RUBY
gate TASK-961 na authenticated_runtime --actor reviewer --reason "not runtime facing" >/dev/null
out="$(ruby "$RECONCILE" TASK-961 2>/dev/null)"
assert_eq "stale:approve:in_review->debugging" "$out" "F2: approve against a superseded phase is stale"
assert_eq "debugging" "$(yaml_get "$DIR/status.yaml" phase)" "F2: phase stays debugging"
assert_eq "2026-09-30T01:00:00Z" "$(yaml_get "$DIR/status.yaml" decision_applied_at)" "F2: stale decision marked applied"
grep -q "superseded" "$DIR/status.yaml" || fail "F2: history must mention superseded"
out="$(ruby "$RECONCILE" TASK-961 2>/dev/null)"
assert_eq "noop" "$out" "F2: second reconcile is a noop"

DIR="$(new_task TASK-962)"
write_status "$DIR" TASK-962 debugging 'completion_gates:
  authenticated_runtime:
    status: na
    actor: reviewer
    reason: not runtime facing
    updated_at: "2026-09-30T00:00:00Z"'
write_decision "$DIR" TASK-962 ""
out="$(ruby "$RECONCILE" TASK-962 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "F2: no against_phase -> applies as before (known limit)"

DIR="$(new_task TASK-963)"
write_status "$DIR" TASK-963 debugging ""
write_decision "$DIR" TASK-963 in_review
out="$(ruby "$RECONCILE" TASK-963 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "F2: no completion_gates -> against_phase mismatch is ignored"
echo "[ok] F2 stale held approve"

# Fold-in a — dedupe compares agent as well as type/details.
DDIR="$(new_task TASK-964)"
ruby - "$ROOT_DIR" "$DDIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
d = ARGV[1]
a = CompletionGuard.append_meta_event!(d, type: "t", agent: "reviewer", details: "x", dedupe: true)
b = CompletionGuard.append_meta_event!(d, type: "t", agent: "orchestrator", details: "x", dedupe: true)
c = CompletionGuard.append_meta_event!(d, type: "t", agent: "orchestrator", details: "x", dedupe: true)
abort "[FAIL] guard: dedupe must consider agent" unless a && b && !c
RUBY
assert_eq "2" "$(event_count "$DDIR" t)" "dedupe by agent: two distinct-agent events kept, exact repeat dropped"
echo "[ok] dedupe by agent"

# --- APPEND-NEW-SECTIONS-ABOVE ---
echo "PASS: completion-gates"
