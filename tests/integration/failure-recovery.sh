#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'find "$RUNS" -depth -delete' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
WRITER="$ROOT/scripts/classify-task-failure.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

fail() { echo "[FAIL] $1"; exit 1; }
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) { |node, key| node.is_a?(Hash) ? node[key] : nil }
puts value.nil? ? "" : value
RUBY
}
event_field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data.fetch("events").last) { |node, key| node.is_a?(Hash) ? node[key] : nil }
puts value.nil? ? "" : value
RUBY
}
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1 || fail "validation failed: $(cat "$RUNS/validate.log")"; }

# Construct a historical replay point from one actual, checked-in status
# history row. The live task and its full history are never modified.
replay() {
  local task_id="$1" needle="$2" phase="$3" agent="$4"
  local dir="$RUNS/$task_id"
  mkdir -p "$dir"
  ruby -ryaml -rdate - "$ROOT/runs/$task_id/status.yaml" "$dir/status.yaml" "$needle" "$phase" "$agent" <<'RUBY'
source_path, target_path, needle, phase, agent = ARGV
status = YAML.safe_load(File.read(source_path), permitted_classes: [Date, Time], aliases: true)
entry = status.fetch("history").find { |row| row["reason"].include?(needle) }
abort "replay source missing: #{needle}" unless entry
status["history"] = [entry]
status["phase"] = status["state"] = phase
status["current_agent"] = agent
status["ready"] = true
status.delete("next_action") # The checked-in file's completed-task summary is later evidence.
File.write(target_path, YAML.dump(status))
RUBY
  echo "$dir"
}

# VS-003: production 5xx exposed DB lock contention after a capacity rollout.
D="$(replay TASK-VS-003 'CloudWatch for 14:16/14:36 shows the 5xx' review reviewer)"
ruby "$WRITER" TASK-VS-003 invalid_assumption --actor pm \
  --reason "Production 5xx came from DB lock contention" --history-index 0 \
  --invalidates "The existing DB lock strategy can sustain the capacity target" --route dev >"$RUNS/classify.log"
[[ "$(field "$D/status.yaml" phase)" == assigned ]] || fail "VS-003 did not re-plan to assigned"
[[ "$(field "$D/status.yaml" current_agent)" == dev ]] || fail "VS-003 did not route to dev"
[[ "$(event_field "$D/meta.yaml" classification)" == invalid_assumption ]] || fail "VS-003 classification absent"
[[ "$(event_field "$D/meta.yaml" recovery.action)" == replan ]] || fail "VS-003 re-plan action absent"
validate "$D"
ruby "$WRITER" TASK-VS-003 invalid_assumption --actor pm \
  --reason "Production 5xx came from DB lock contention" --history-index 0 \
  --invalidates "The existing DB lock strategy can sustain the capacity target" --route dev >"$RUNS/classify.log"
grep -q 'idempotent skip' "$RUNS/classify.log" || fail "identical classification duplicated"

# VS-006's original source diagnosis was an implementation defect to fix.
D="$(replay TASK-VS-006 'frontend ignores the PUT response' assigned dev)"
ruby "$WRITER" TASK-VS-006 implementation_defect --actor dev \
  --reason "PUT response and cache state diverged" --history-index 0 --route dev >"$RUNS/classify.log"
[[ "$(event_field "$D/meta.yaml" recovery.action)" == debug_fix ]] || fail "VS-006 defect did not choose fix loop"
[[ "$(field "$D/status.yaml" phase)" == assigned ]] || fail "VS-006 dev fix route changed unexpectedly"
validate "$D"

# Later staging browser evidence found an additional SSR/hydration cause.
D="$(replay TASK-VS-006 'a separate root cause: an SSR watch' review reviewer)"
ruby "$WRITER" TASK-VS-006 invalid_assumption --actor dev \
  --reason "Staging hard reload disproved the client-cache-only explanation" --history-index 0 \
  --invalidates "PUT-response cache repair fully resolves hard-reload toggle state" --route dev >"$RUNS/classify.log"
[[ "$(event_field "$D/meta.yaml" recovery.action)" == replan ]] || fail "VS-006 new root cause did not re-plan"
validate "$D"

# Other classes use bounded existing workflow routes; permission blocks dispatch.
mkdir -p "$RUNS/TASK-901"
cat > "$RUNS/TASK-901/status.yaml" <<'YAML'
task_id: TASK-901
phase: review
state: review
iteration: 1
current_agent: reviewer
ready: true
history:
  - phase: assigned -> review
    agent: dev
    reason: Verification found an unresolved operator authority requirement.
YAML
ruby "$WRITER" TASK-901 permission_authority --actor pm --reason "Live load needs approval" \
  --history-index 0 --waiting-for "operator: approve live load" >"$RUNS/classify.log"
[[ "$(field "$RUNS/TASK-901/status.yaml" phase)" == blocked ]] || fail "authority class did not block"
grep -q 'operator: approve live load' "$RUNS/TASK-901/status.yaml" || fail "authority wait absent"
validate "$RUNS/TASK-901"

# Default recovery routes distinguish implementation, environment, and data.
for spec in '902 implementation_defect debugging debugger debug_fix' \
            '903 invalid_assumption pending pm replan' \
            '904 environment_runtime devops_needed devops diagnose' \
            '905 missing_data debugging debugger investigate'; do
  read -r suffix class phase agent action <<< "$spec"
  dir="$RUNS/TASK-$suffix"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: TASK-$suffix
phase: review
state: review
iteration: 1
current_agent: reviewer
history:
  - phase: assigned -> review
    agent: reviewer
    reason: Verification observed a failure requiring classification.
YAML
  if [[ "$class" == invalid_assumption ]]; then
    ruby "$WRITER" "TASK-$suffix" "$class" --actor reviewer --reason 'Replay diagnosis' \
      --history-index 0 --invalidates 'The original approach meets verification' >"$RUNS/classify.log"
  else
    ruby "$WRITER" "TASK-$suffix" "$class" --actor reviewer --reason 'Replay diagnosis' \
      --history-index 0 >"$RUNS/classify.log"
  fi
  [[ "$(field "$dir/status.yaml" phase)" == "$phase" ]] || fail "$class chose the wrong phase"
  [[ "$(field "$dir/status.yaml" current_agent)" == "$agent" ]] || fail "$class chose the wrong agent"
  [[ "$(event_field "$dir/meta.yaml" recovery.action)" == "$action" ]] || fail "$class chose the wrong action"
  validate "$dir"
done

# Recovery reuses Phase 1C projection: a blocked sibling does not stop the
# re-plan, but an all-blocked task remains blocked.
dir="$RUNS/TASK-906"
mkdir -p "$dir"
cat > "$dir/status.yaml" <<'YAML'
task_id: TASK-906
phase: review
state: review
iteration: 1
current_agent: reviewer
branches:
  executable:
    state: ready
    actor: reviewer
    reason: Independent path can continue
    updated_at: '2026-10-02T00:00:00Z'
  policy:
    state: blocked
    actor: reviewer
    reason: Needs operator policy
    updated_at: '2026-10-02T00:00:00Z'
    waiting_for:
      - operator policy decision
history:
  - phase: assigned -> review
    agent: reviewer
    reason: Verification invalidated the execution plan.
YAML
ruby "$WRITER" TASK-906 invalid_assumption --actor reviewer --reason 'Plan revision' \
  --history-index 0 --invalidates 'Original plan' >"$RUNS/classify.log"
[[ "$(field "$dir/status.yaml" phase)" == pending ]] || fail "ready branch could not re-plan"
grep -q 'branch:policy' "$dir/status.yaml" || fail "branch wait was lost"
validate "$dir"
ruby -ryaml -rdate - "$dir/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["branches"]["executable"]["state"] = "done"
File.write(p, YAML.dump(s))
RUBY
ruby "$WRITER" TASK-906 missing_data --actor reviewer --reason 'Need new measurement' \
  --history-index 0 >"$RUNS/classify.log"
[[ "$(field "$dir/status.yaml" phase)" == blocked ]] || fail "all-blocked task did not stay blocked"
[[ "$(event_field "$dir/meta.yaml" recovery.to_phase)" == blocked ]] || fail "effective blocked route absent"
validate "$dir"

# Task-level blocks must be resolved by their owner before classification may
# route to a runnable phase. The dependency case exercises the real unblocking
# writer, which intentionally retains blocked_on in legacy non-branch status.
mkdir -p "$RUNS/TASK-907" "$RUNS/TASK-908" "$RUNS/TASK-909"
cat > "$RUNS/TASK-907/status.yaml" <<'YAML'
task_id: TASK-907
phase: blocked
state: blocked
iteration: 1
current_agent: pm
ready: false
blocked_on:
  - TASK-909
assignment:
  primary: dev
  parallel: false
history:
  - phase: assigned -> blocked
    agent: pm
    reason: Verification found an implementation defect while dependency remained open.
YAML
cat > "$RUNS/TASK-908/status.yaml" <<'YAML'
task_id: TASK-908
phase: blocked
state: blocked
iteration: 1
current_agent: pm
ready: false
waiting_for:
  - 'operator: approve production correction'
history:
  - phase: assigned -> blocked
    agent: pm
    reason: Verification found an implementation defect while operator approval remained open.
YAML
for task_id in TASK-907 TASK-908; do
  cp "$RUNS/$task_id/status.yaml" "$RUNS/$task_id/before.yaml"
  if ruby "$WRITER" "$task_id" implementation_defect --actor reviewer \
    --reason 'Fix the defect' --history-index 0 >"$RUNS/classify.log" 2>&1; then
    fail "$task_id bypassed its task-level block"
  fi
  grep -q 'task-level dependency or wait is still blocked' "$RUNS/classify.log" || fail "$task_id refusal reason missing"
  cmp -s "$RUNS/$task_id/status.yaml" "$RUNS/$task_id/before.yaml" || fail "$task_id status changed after refusal"
  [[ ! -f "$RUNS/$task_id/meta.yaml" ]] || fail "$task_id wrote a meta event after refusal"
done
cat > "$RUNS/TASK-909/status.yaml" <<'YAML'
task_id: TASK-909
phase: done
state: done
iteration: 1
current_agent: done
YAML
ruby "$ROOT/scripts/reconcile-blocked-status.rb" TASK-907 "$RUNS/TASK-907/status.yaml" \
  "$RUNS" 2026-10-02 done in_review true true true >"$RUNS/reconcile.log"
[[ "$(field "$RUNS/TASK-907/status.yaml" phase)" == assigned ]] || fail "resolved dependency did not unblock"
ruby "$WRITER" TASK-907 implementation_defect --actor reviewer --reason 'Fix the defect' \
  --history-index 0 >"$RUNS/classify.log"
[[ "$(field "$RUNS/TASK-907/status.yaml" phase)" == debugging ]] || fail "recovery route lost after unblock"
validate "$RUNS/TASK-907"

# An unclassified legacy event remains valid, while a terminal task cannot
# receive a new classification.
cat > "$RUNS/TASK-902/meta.yaml" <<'YAML'
task_id: TASK-902
events:
  - type: runner_finished
    agent: dev
    details: Existing generic event
    timestamp: '2026-10-02T00:00:00Z'
YAML
validate "$RUNS/TASK-902/meta.yaml"
cat > "$RUNS/TASK-902/status.yaml" <<'YAML'
task_id: TASK-902
phase: done
state: done
iteration: 1
current_agent: done
history:
  - phase: review -> done
    agent: reviewer
    reason: Completed.
YAML
if ruby "$WRITER" TASK-902 implementation_defect --actor reviewer --reason 'Too late' \
  --history-index 0 >"$RUNS/classify.log" 2>&1; then fail "terminal task was reclassified"; fi

# Forged routing, missing support, and terminal rewrites are refused.
ruby -ryaml -rdate - "$D/meta.yaml" <<'RUBY'
p = ARGV[0]
m = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
m["events"].last["recovery"]["action"] = "debug_fix"
File.write(p, YAML.dump(m))
RUBY
if ruby "$VALIDATOR" "$D/meta.yaml" >"$RUNS/validate.log" 2>&1; then fail "forged recovery action validated"; fi
if ruby "$WRITER" TASK-VS-006 invalid_assumption --actor pm --reason "no support" --invalidates "x" 2>/dev/null; then fail "unsupported judgment allowed"; fi
if ruby "$WRITER" TASK-903 invalid_assumption --actor reviewer --reason 'Wrong route' \
  --history-index 0 --invalidates 'Original plan' --route devops >"$RUNS/classify.log" 2>&1; then
  fail "invalid recovery route was accepted"
fi
if ruby "$WRITER" TASK-903 invalid_assumption --actor reviewer --reason 'Unknown evidence' \
  --evidence ev-999 --invalidates 'Original plan' >"$RUNS/classify.log" 2>&1; then
  fail "unknown evidence was accepted"
fi

echo "[PASS] failure-recovery: VS-003/VS-006 replay, recovery routes, task-level blocks, idempotency, validation"
