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
annotate() {  # <task_dir>
  ruby "$CLASSIFIER" annotate-validation-failure "$1" TASK-EB dev
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

# ── EB1c: legitimate baseline-then-confirm rerun — Fix 2 regression case ───
# Independent audit reproduction: fail, log a real diagnosis, rerun the SAME
# command to CONFIRM the repro before applying the actual fix. Output is
# byte-identical on both failing runs (same root cause, same failure) but a
# meaningful (non-routine) meta.yaml event was logged strictly between them,
# so this must NOT be treated as "no material change".
T1C="$WORK/EB1C"; mkdir -p "$T1C"
SHA1C="$(sha confirmed-repro)"
cat > "$T1C/evidence.yaml" <<YAML
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
    artifact_sha256: "$SHA1C"
  - id: ev-002
    type: command
    command: "make test"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:10:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA1C"
YAML
cat > "$T1C/meta.yaml" <<'Y'
task_id: TASK-EB
events:
  - type: diagnosis
    agent: dev
    details: "confirmed root cause: off-by-one in the paginator; second run was to verify repro before applying fix"
    timestamp: "2026-08-19T00:05:00Z"
Y
line="$(classify "$T1C")"
[[ "$line" == exhausted=false* ]] || fail "EB1c: a real diagnosis logged between two identical failures must NOT be flagged, got: $line"
ok "EB1c: baseline-then-confirm rerun (real diagnosis logged in between) is not flagged (Fix 2)"

# ── EB1d: control — same shape as EB1c but the intervening event is ROUTINE
# (harness bookkeeping only), so it must NOT rescue the repeat from flagging.
T1D="$WORK/EB1D"; mkdir -p "$T1D"
SHA1D="$(sha still-stuck)"
cat > "$T1D/evidence.yaml" <<YAML
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
    artifact_sha256: "$SHA1D"
  - id: ev-002
    type: command
    command: "make test"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-08-19T00:10:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA1D"
YAML
cat > "$T1D/meta.yaml" <<'Y'
task_id: TASK-EB
events:
  - type: prompt_assembly
    agent: dev
    details: "task=TASK-EB epic=none runner=codex phase=in_review iteration=3 sources=task"
    timestamp: "2026-08-19T00:05:00Z"
Y
line="$(classify "$T1D")"
[[ "$line" == exhausted=true\ signal=repeated_command_failure* ]] || fail "EB1d: routine harness bookkeeping in between must NOT rescue the repeat, got: $line"
ok "EB1d: a routine prompt_assembly event in between does not count as meaningful activity — still flagged (control for Fix 2)"

# ── EB2: validation_failed at the cap, no new diagnosis — ANNOTATION ONLY ──
# This signal never sets `classify`'s exhausted (see EB2-classify-noop below);
# it is read-only enrichment of run-agent.sh's own PRE-EXISTING M4 halt, via
# the separate `annotate-validation-failure` command.
T2="$WORK/EB2"; mkdir -p "$T2"
cat > "$T2/status.yaml" <<'Y'
task_id: TASK-EB
phase: validation_failed
state: validation_failed
iteration: 4
current_agent: free-roam
validation_failed_retries: 3
Y
# No evidence.yaml at all: exercises the "no evidence to compare" fallback in
# validation_failure_signal — absence of a NEW diagnosis is treated the same
# as an identical repeat, matching what M4's own unconditional retries>=limit
# halt already assumes today.
line="$(annotate "$T2")"
[[ "$line" == applicable=true* ]] || fail "EB2: expected applicable=true, got: $line"
[[ "$line" == *"no new diagnosis"* ]] || fail "EB2: reason should say 'no new diagnosis', got: $line"
ok "EB2: validation_failed at the retry cap with no evidence of a new diagnosis -> annotation applicable=true"

# ── EB2-classify-noop: classify() must NEVER flag this on its own — Fix 1 ──
# regression case (independent audit): a checkpoint deciding exhaustion from
# validation_failed_retries with no AI_DEV_OFFICE_FORCE escape hatch would
# silently defeat the operator's override of M4's halt. Proven at the
# classifier level here, and end-to-end through the real driver in EB7.
line="$(classify "$T2")"
[[ "$line" == exhausted=false* ]] || fail "EB2-classify-noop: classify() must never set exhausted from validation_failed_retries, got: $line"
ok "EB2-classify-noop: classify() ignores validation_failed_retries entirely (annotation-only, Fix 1)"

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
line="$(annotate "$T2B")"
[[ "$line" == applicable=false* ]] || fail "EB2b: 2 of 3 allowed validation failures must NOT be applicable, got: $line"
ok "EB2b: validation_failed_retries below the limit (2 of 3) is retryable (annotation not applicable)"

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
line="$(annotate "$T2C")"
[[ "$line" == applicable=true* ]] || fail "EB2c: at the cap, annotation should still be applicable, got: $line"
[[ "$line" == *"new evidence"* ]] || fail "EB2c: reason should note the new evidence, got: $line"
ok "EB2c: at the cap, new evidence changes the RECORDED annotation reason (M4's own halt still fires unconditionally, unaffected by this file)"

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

# ── EB9: evidence-exempt dispatches don't count toward no_new_evidence ─────
# Post-merge production regression (issue #12's reviewer-evidence-risk.sh,
# "the four verdicts still route correctly through the driver"): a task
# dispatched to `reviewer` repeatedly at LOW risk never needs evidence
# (review-gate's own require_evidence=false for that risk level) — legitimate,
# by #12's own design, not a test artifact. Each dispatch logs a
# `reviewer_evidence_policy` meta event carrying `require_evidence=false` and
# the dispatch's run_id. 4 such dispatches accumulate >12 total meta events
# with zero evidence.yaml entries ever, which used to trip no_new_evidence and
# escalate the task BEFORE the reviewer gate got to route it at all.
T9="$WORK/EB9"; mkdir -p "$T9"
{
  echo "task_id: TASK-EB"
  echo "events:"
  for i in 1 2 3 4; do
    run_id="run-20260819T00000${i}Z-TASK-EB-reviewer-abc00${i}"
    base=$(( (i - 1) * 4 ))
    printf '  - type: ownership_acquired\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T00:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 1))" "$run_id"
    printf '  - type: prompt_assembly\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T00:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 2))" "$run_id"
    printf '  - type: reviewer_evidence_policy\n    agent: reviewer\n    details: "task=TASK-EB mode=required risk_level=low labels=none require_evidence=false config_errors=0 gaps=0 blocking=false"\n    timestamp: "2026-08-19T00:%02d:00Z"\n    run_id: %s\n' "$((base + 3))" "$run_id"
    printf '  - type: runner_complete\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T00:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 4))" "$run_id"
  done
} > "$T9/meta.yaml"
line="$(classify "$T9")"
[[ "$line" == exhausted=false* ]] || fail "EB9: 4 evidence-exempt (require_evidence=false) reviewer dispatches (16 total events, 0 evidence) must NOT be flagged, got: $line"
ok "EB9: repeated low-risk reviewer dispatches with require_evidence=false never count toward no_new_evidence (Fix 5, post-merge regression)"

# ── EB9b: control — the SAME event volume, but NOT evidence-exempt, must
# still flag. Proves Fix 5 narrows the signal correctly rather than widening
# it into never firing (the false-negative concern from both prior audits).
T9B="$WORK/EB9B"; mkdir -p "$T9B"
{
  echo "task_id: TASK-EB"
  echo "events:"
  for i in 1 2 3 4; do
    run_id="run-20260819T00001${i}Z-TASK-EB-reviewer-def00${i}"
    base=$(( (i - 1) * 4 ))
    printf '  - type: ownership_acquired\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T01:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 1))" "$run_id"
    printf '  - type: prompt_assembly\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T01:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 2))" "$run_id"
    # HIGH risk this time: require_evidence=true, so this run_id is NOT exempt.
    printf '  - type: reviewer_evidence_policy\n    agent: reviewer\n    details: "task=TASK-EB mode=required risk_level=high labels=none require_evidence=true config_errors=0 gaps=1 blocking=true"\n    timestamp: "2026-08-19T01:%02d:00Z"\n    run_id: %s\n' "$((base + 3))" "$run_id"
    printf '  - type: runner_complete\n    agent: reviewer\n    details: "dispatch %d"\n    timestamp: "2026-08-19T01:%02d:00Z"\n    run_id: %s\n' "$i" "$((base + 4))" "$run_id"
  done
} > "$T9B/meta.yaml"
line="$(classify "$T9B")"
[[ "$line" == exhausted=true\ signal=no_new_evidence* ]] || fail "EB9b: high-risk (require_evidence=true) repeats with zero evidence must still flag, got: $line"
ok "EB9b: control — the same event shape WITHOUT the exemption still trips no_new_evidence (false-negative resistance)"

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

# ── EB7: pm is exempt even when every signal would otherwise fire — Fix 3 ──
# Mutation-coverage gap the independent audit found: removing the
# `"$AGENT" != "pm"` guard from the checkpoint survived all 13 regression
# suites because nothing dispatched pm through a clearly-exhausted fixture.
# This fixture is built so EVERY signal in SIGNAL_ORDER would fire if it were
# evaluated: repeated_command_failure (2 identical failing evidence entries),
# no_new_evidence (13 meta events, no evidence newer than them), and
# role_ping_pong (6 alternating dev/reviewer history rows). pm must still
# dispatch.
T7="TASK-EB7$$"
mkdir -p "$RUNS_DIR/$T7"
{
  echo "task_id: $T7"
  echo "phase: pending"
  echo "state: pending"
  echo "iteration: 0"
  echo "current_agent: pm"
  echo "ready: true"
  echo "created_at: \"2026-08-19\""
  echo "updated_at: \"2026-08-19\""
  echo "history:"
  agents=(dev reviewer dev reviewer dev reviewer)
  for i in "${!agents[@]}"; do
    printf '  - phase: "x -> y"\n    agent: %s\n    reason: "round %d"\n    at: "2026-08-19T00:%02d:00Z"\n' "${agents[$i]}" "$i" "$i"
  done
} > "$RUNS_DIR/$T7/status.yaml"
echo "# t" > "$RUNS_DIR/$T7/task.md"
SHA7="$(sha pm-exempt-repeat)"
cat > "$RUNS_DIR/$T7/evidence.yaml" <<YAML
task_id: $T7
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
    artifact_sha256: "$SHA7"
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
    artifact_sha256: "$SHA7"
YAML
{
  echo "task_id: $T7"
  echo "events:"
  for i in $(seq 1 13); do
    printf '  - type: tool_call\n    agent: dev\n    details: "step %d"\n    timestamp: "2026-08-19T01:%02d:00Z"\n' "$i" "$i"
  done
} > "$RUNS_DIR/$T7/meta.yaml"
# Sanity: this exact fixture DOES trip the classifier for a non-pm agent —
# otherwise the test would pass for the wrong reason.
sanity="$(ruby "$CLASSIFIER" classify "$RUNS_DIR/$T7" "$T7" dev)"
[[ "$sanity" == exhausted=true* ]] || fail "EB7 sanity: fixture should classify as exhausted for a non-pm agent, got: $sanity"

rm -f "$CALL/codex.count"
rc=0
AI_OFFICE_RUNS_DIR="$RUNS_DIR" EB_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T7" pm codex >"$WORK/eb7.log" 2>&1 || rc=$?
calls=0; [[ -f "$CALL/codex.count" ]] && calls="$(cat "$CALL/codex.count")"
[[ "$calls" -ge 1 ]] || { cat "$WORK/eb7.log"; fail "EB7: pm must still dispatch even with an otherwise-exhausted fixture, got $calls call(s) (rc=$rc)"; }
! grep -q "Execution budget exhausted" "$WORK/eb7.log" || fail "EB7: pm must be exempt from the execution budget checkpoint"
ok "EB7 driver: pm dispatches through an otherwise-exhausted fixture unaffected (mutation-coverage regression, Fix 3)"

# ── EB8: AI_DEV_OFFICE_FORCE=true must not be defeated — Fix 1 regression ──
# Independent audit's exact reproduction: an operator sets FORCE=true to give
# `dev` one more shot past M4's hard-halt. Before the fix, the execution-budget
# checkpoint independently re-implemented M4's trigger condition
# (validation_failed_retries >= limit) with no override and force-escalated
# anyway, silently discarding the operator's explicit intent. Now that
# validation_failure_signal is excluded from SIGNAL_ORDER (see EB2-classify-noop
# above), this must dispatch normally.
T8="TASK-EB8$$"
mkdir -p "$RUNS_DIR/$T8"
cat > "$RUNS_DIR/$T8/status.yaml" <<YAML
task_id: $T8
phase: validation_failed
state: validation_failed
iteration: 4
current_agent: dev
validation_failed_retries: 3
ready: true
created_at: "2026-08-19"
updated_at: "2026-08-19"
history: []
YAML
echo "# t" > "$RUNS_DIR/$T8/task.md"

rm -f "$CALL/codex.count"
rc=0
AI_OFFICE_RUNS_DIR="$RUNS_DIR" EB_CALL="$CALL" PATH="$BIN:$PATH" AI_DEV_OFFICE_FORCE=true \
  "$DRIVER" "$T8" dev codex >"$WORK/eb8.log" 2>&1 || rc=$?
calls=0; [[ -f "$CALL/codex.count" ]] && calls="$(cat "$CALL/codex.count")"
echo "  -- EB8 before/after reproduction --"
echo "  rc=$rc calls=$calls"
tail -5 "$WORK/eb8.log" | sed 's/^/  eb8.log: /'
[[ "$calls" -ge 1 ]] || { cat "$WORK/eb8.log"; fail "EB8: AI_DEV_OFFICE_FORCE=true must let dev dispatch past validation_failed at the cap, got $calls call(s) (rc=$rc)"; }
! grep -q "Execution budget exhausted" "$WORK/eb8.log" || fail "EB8: the execution-budget checkpoint must not independently re-block a FORCE-overridden validation_failed halt"
ok "EB8 driver: AI_DEV_OFFICE_FORCE=true is honored end-to-end; the execution-budget checkpoint no longer defeats it (Fix 1)"

rm -rf "$RUNS_DIR/$T5" "$RUNS_DIR/$T6" "$RUNS_DIR/$T7" "$RUNS_DIR/$T8"

echo "[PASS] execution-budget: classifier signals + false-positive resistance + driver wiring (#16)"
