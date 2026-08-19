#!/usr/bin/env bash
# #16: execution budget guard (scripts/execution-budget.rb + the run-agent.sh
# checkpoint that consumes it). Two layers, both covered here:
#   - EB1-EB4: the classifier itself, called directly, one fixture per signal.
#   - EB5-EB7: the real driver — halts before dispatch when exhausted, dispatches
#     normally otherwise (false-positive resistance), and records the reason.
# Mirrors the fixture/log-scraping idiom of loop-guard-bounded.sh and
# validation-failed-bounded.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
CLASSIFIER="$ROOT/scripts/execution-budget.rb"
WORK="$(mktemp -d)"; BIN="$(mktemp -d)"; CALL="$(mktemp -d)"
trap 'rm -rf "$WORK" "$BIN" "$CALL"' EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

classify() {  # <task_dir>
  ruby "$CLASSIFIER" classify "$1" TASK-EB dev
}
sha() { printf '%s' "$1" | ruby -rdigest -e 'puts Digest::SHA256.hexdigest(STDIN.read)'; }

# ── EB1: repeated identical command failure ─────────────────────────────────
T1="$WORK/EB1"; mkdir -p "$T1"
SHA1="$(sha same-output)"
cat > "$T1/evidence.yaml" <<YAML
task_id: TASK-EB
evidence:
  - id: ev-001
    type: command
    command: "make test"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$SHA1"
  - id: ev-002
    type: command
    command: "make test"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:05:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA1"
YAML
line="$(classify "$T1")"
[[ "$line" == exhausted=true\ signal=repeated_command_failure* ]] || fail "EB1: expected repeated_command_failure, got: $line"
ok "EB1: two identical failing commands with byte-identical output -> repeated_command_failure"

# ── EB1b: false-positive resistance — different output each time ───────────
T1B="$WORK/EB1B"; mkdir -p "$T1B"
cat > "$T1B/evidence.yaml" <<YAML
task_id: TASK-EB
evidence:
  - id: ev-001
    type: command
    command: "make test"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$(sha attempt-1)"
  - id: ev-002
    type: command
    command: "make test"
    exit_code: 0
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:05:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$(sha attempt-2)"
YAML
line="$(classify "$T1B")"
[[ "$line" == exhausted=false* ]] || fail "EB1b: a fixed failure (exit 0 on retry, different output) must NOT be flagged, got: $line"
ok "EB1b: a failure followed by a passing/different retry is not flagged (false-positive resistance)"

# ── EB2: validation_failed at the cap, no new diagnosis ─────────────────────
T2="$WORK/EB2"; mkdir -p "$T2"
cat > "$T2/status.yaml" <<'Y'
task_id: TASK-EB
phase: validation_failed
state: validation_failed
iteration: 4
current_agent: free-roam
validation_failed_retries: 3
Y
# No evidence.yaml at all: isolates this signal from EB1's repeated-command
# check (which needs >= 2 failing evidence entries to fire), and exercises the
# "no evidence to compare" fallback in validation_failure_signal — absence of
# a NEW diagnosis is treated the same as an identical repeat, which is exactly
# what the existing unconditional retries>=limit halt already assumes today.
line="$(classify "$T2")"
[[ "$line" == exhausted=true\ signal=validation_failure_no_new_evidence* ]] || fail "EB2: expected validation_failure_no_new_evidence, got: $line"
[[ "$line" == *"no new diagnosis"* ]] || fail "EB2: reason should say 'no new diagnosis', got: $line"
ok "EB2: validation_failed at the retry cap with no evidence of a new diagnosis -> validation_failure_no_new_evidence"

# ── EB2b: retryable — under the cap must NOT be flagged (recovery case) ────
T2B="$WORK/EB2B"; mkdir -p "$T2B"
cat > "$T2B/status.yaml" <<'Y'
task_id: TASK-EB
phase: validation_failed
state: validation_failed
iteration: 3
current_agent: free-roam
validation_failed_retries: 2
Y
line="$(classify "$T2B")"
[[ "$line" == exhausted=false* ]] || fail "EB2b: 2 of 3 allowed validation failures must NOT be flagged, got: $line"
ok "EB2b: validation_failed_retries below the limit (2 of 3) is retryable, not exhausted"

# ── EB2c: at the cap but the LAST failure carried new evidence ─────────────
T2C="$WORK/EB2C"; mkdir -p "$T2C"
cat > "$T2C/status.yaml" <<'Y'
task_id: TASK-EB
phase: validation_failed
state: validation_failed
iteration: 4
current_agent: free-roam
validation_failed_retries: 3
Y
cat > "$T2C/evidence.yaml" <<YAML
task_id: TASK-EB
evidence:
  - id: ev-001
    type: test
    command: "go test ./..."
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$(sha first-diagnosis)"
  - id: ev-002
    type: test
    command: "go test ./..."
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:10:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$(sha different-failure-this-time)"
YAML
line="$(classify "$T2C")"
[[ "$line" == exhausted=true* ]] || fail "EB2c: the existing retry cap is unconditional and must still fire, got: $line"
[[ "$line" == *"new evidence"* ]] || fail "EB2c: reason should note the new evidence, got: $line"
ok "EB2c: at the cap, new evidence changes the RECORDED reason but the halt itself still fires (matches the existing unconditional driver halt)"

# ── EB3: no evidence in max_no_progress_actions logged actions ─────────────
T3="$WORK/EB3"; mkdir -p "$T3"
{
  echo "task_id: TASK-EB"
  echo "events:"
  for i in $(seq 1 13); do
    printf '  - type: tool_call\n    agent: dev\n    details: "step %d"\n    timestamp: "2026-08-19T00:%02d:00Z"\n' "$i" "$i"
  done
} > "$T3/meta.yaml"
line="$(classify "$T3")"
[[ "$line" == exhausted=true\ signal=no_new_evidence* ]] || fail "EB3: expected no_new_evidence, got: $line"
ok "EB3: 13 logged actions with zero evidence ever recorded (limit 12) -> no_new_evidence"

# ── EB3b: under the limit must NOT be flagged ───────────────────────────────
T3B="$WORK/EB3B"; mkdir -p "$T3B"
{
  echo "task_id: TASK-EB"
  echo "events:"
  for i in $(seq 1 5); do
    printf '  - type: tool_call\n    agent: dev\n    details: "step %d"\n    timestamp: "2026-08-19T00:%02d:00Z"\n' "$i" "$i"
  done
} > "$T3B/meta.yaml"
line="$(classify "$T3B")"
[[ "$line" == exhausted=false* ]] || fail "EB3b: 5 logged actions (limit 12) must NOT be flagged, got: $line"
ok "EB3b: a short, normal action count is not flagged"

# ── EB4: role ping-pong with no evidence growth across the window ──────────
T4="$WORK/EB4"; mkdir -p "$T4"
{
  echo "task_id: TASK-EB"
  echo "phase: in_review"
  echo "state: in_review"
  echo "iteration: 6"
  echo "current_agent: reviewer"
  echo "history:"
  agents=(dev reviewer dev reviewer dev reviewer)
  for i in "${!agents[@]}"; do
    printf '  - phase: "x -> y"\n    agent: %s\n    reason: "round %d"\n    at: "2026-08-19T00:%02d:00Z"\n' "${agents[$i]}" "$i" "$i"
  done
} > "$T4/status.yaml"
line="$(classify "$T4")"
[[ "$line" == exhausted=true\ signal=role_ping_pong* ]] || fail "EB4: expected role_ping_pong, got: $line"
ok "EB4: dev<->reviewer alternating 6 handoffs with no evidence growth -> role_ping_pong"

# ── EB4b: same alternation, but evidence DID grow in the window -> not flagged
T4B="$WORK/EB4B"; mkdir -p "$T4B"
cp "$T4/status.yaml" "$T4B/status.yaml"
cat > "$T4B/evidence.yaml" <<YAML
task_id: TASK-EB
evidence:
  - id: ev-001
    type: test
    command: "npm test"
    exit_code: 0
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:03:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$(sha grew)"
YAML
line="$(classify "$T4B")"
[[ "$line" == exhausted=false* ]] || fail "EB4b: evidence growth inside the ping-pong window must NOT be flagged, got: $line"
ok "EB4b: role alternation WITH evidence growth in-window is legitimate iteration, not thrash"

# ── EB-missing: no task dir / no files at all -> never exhausted ───────────
line="$(ruby "$CLASSIFIER" classify "$WORK/does-not-exist" TASK-EB dev)"
[[ "$line" == exhausted=false* ]] || fail "EB-missing: a missing task dir must fail open, got: $line"
line="$(mkdir -p "$WORK/EBEMPTY" && ruby "$CLASSIFIER" classify "$WORK/EBEMPTY" TASK-EB dev)"
[[ "$line" == exhausted=false* ]] || fail "EB-missing: an empty task dir (no telemetry yet) must fail open, got: $line"
ok "EB-missing: absent/empty telemetry fails open (never assumes exhaustion from silence)"

# ── EB5: real driver halts before dispatch when exhausted ──────────────────
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$EB_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"; exit 0
SH
chmod +x "$BIN/codex"

RUNS_DIR="$WORK/runs"
T5="TASK-EB5$$"
mkdir -p "$RUNS_DIR/$T5"
cat > "$RUNS_DIR/$T5/status.yaml" <<YAML
task_id: $T5
phase: in_review
state: in_review
iteration: 2
current_agent: dev
ready: true
created_at: "2026-08-19"
updated_at: "2026-08-19"
history: []
YAML
echo "# t" > "$RUNS_DIR/$T5/task.md"
SHA5="$(sha driver-repeat)"
cat > "$RUNS_DIR/$T5/evidence.yaml" <<YAML
task_id: $T5
evidence:
  - id: ev-001
    type: command
    command: "make lint"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$SHA5"
  - id: ev-002
    type: command
    command: "make lint"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:05:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA5"
YAML

rm -f "$CALL/codex.count"
rc=0
AI_OFFICE_RUNS_DIR="$RUNS_DIR" EB_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T5" dev codex >"$WORK/eb5.log" 2>&1 || rc=$?
calls=0; [[ -f "$CALL/codex.count" ]] && calls="$(cat "$CALL/codex.count")"
[[ "$rc" -ne 0 ]] || fail "EB5: an exhausted task must halt (nonzero exit), got rc 0"
[[ "$calls" -eq 0 ]] || fail "EB5: halt must not call the runner, got $calls call(s)"
grep -q "Execution budget exhausted" "$WORK/eb5.log" || { cat "$WORK/eb5.log"; fail "EB5: expected the execution-budget halt message"; }
grep -q "repeated_command_failure" "$WORK/eb5.log" || { cat "$WORK/eb5.log"; fail "EB5: expected the signal name in the halt message"; }
phase="$(ruby -ryaml -e 'puts (YAML.load_file(ARGV[0])["phase"])' "$RUNS_DIR/$T5/status.yaml")"
agent="$(ruby -ryaml -e 'puts (YAML.load_file(ARGV[0])["current_agent"])' "$RUNS_DIR/$T5/status.yaml")"
[[ "$phase" == "escalated" ]] || fail "EB5: phase should route to the existing 'escalated' state, got '$phase'"
[[ "$agent" == "free-roam" ]] || fail "EB5: current_agent should route to free-roam, got '$agent'"
grep -q "execution_budget" "$RUNS_DIR/$T5/meta.yaml" || fail "EB5: expected an execution_budget meta event to be recorded"
grep -q "type: execution_budget" "$RUNS_DIR/$T5/meta.yaml" || fail "EB5: execution_budget event type not found in meta.yaml"
ok "EB5 driver: halts before dispatch (0 runner calls), routes to escalated/free-roam, records execution_budget event"

# ── EB6: real driver dispatches normally when NOT exhausted (recovery case) ─
T6="TASK-EB6$$"
mkdir -p "$RUNS_DIR/$T6"
cat > "$RUNS_DIR/$T6/status.yaml" <<YAML
task_id: $T6
phase: assigned
state: assigned
iteration: 1
current_agent: dev
ready: true
created_at: "2026-08-19"
updated_at: "2026-08-19"
history: []
YAML
echo "# t" > "$RUNS_DIR/$T6/task.md"
cat > "$RUNS_DIR/$T6/pm-output.yaml" <<'Y'
summary: "planned"
artifacts: []
next_action:
  agent: dev
  reason: "implement"
blockers: []
Y

rm -f "$CALL/codex.count"
rc=0
AI_OFFICE_RUNS_DIR="$RUNS_DIR" EB_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T6" dev codex >"$WORK/eb6.log" 2>&1 || rc=$?
calls=0; [[ -f "$CALL/codex.count" ]] && calls="$(cat "$CALL/codex.count")"
[[ "$calls" -ge 1 ]] || { cat "$WORK/eb6.log"; fail "EB6: a healthy task must still dispatch to the runner, got $calls call(s) (rc=$rc)"; }
! grep -q "Execution budget exhausted" "$WORK/eb6.log" || fail "EB6: a healthy task must not be flagged by the execution budget guard"
ok "EB6 driver: a task with no non-progress signal dispatches normally (false-positive resistance, end to end)"

rm -rf "$RUNS_DIR/$T5" "$RUNS_DIR/$T6"

echo "[PASS] execution-budget: classifier signals + false-positive resistance + driver wiring (#16)"
