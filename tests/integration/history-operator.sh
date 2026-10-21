#!/usr/bin/env bash
set -euo pipefail

# SPAR-32 phase 2 — status.yaml history rows record the AI tool that wrote them
# in history[].operator (docs/superpowers/specs/2026-10-21-history-operator-design.md).
# The role stays in history[].agent. Sections: R resolution order, W every
# history writer, D run-agent.sh credits the runner, V validator.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$RUNS" "$FAKE_BIN"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
SCRIPTS="$ROOT/scripts"
VALIDATOR="$ROOT/validate-yaml.rb"
RUN_AGENT="$ROOT/run-agent.sh"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# bare <cmd...> — run with no operator variable and no harness marker, whatever
# harness runs this suite; callers add back the ones a case needs.
bare() { env -u AI_DEV_OFFICE_HISTORY_OPERATOR -u CURSOR_AGENT -u CODEX_THREAD_ID -u CLAUDECODE "$@"; }
# operators <status.yaml> — one line per history row: its operator, or "-".
operators() {
  ruby -ryaml -rdate -e 'd = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
    Array(d["history"]).each { |h| puts(h["operator"] || "-") }' "$1"
}
# all_rows_by <status.yaml> <operator> <label> — every history row names <operator>.
all_rows_by() {
  local out
  out="$(operators "$1")"
  [[ -n "$out" ]] || fail "$3: no history rows"
  [[ -z "$(grep -vxF "$2" <<<"$out" || true)" ]] || fail "$3: rows not by $2: $(tr '\n' ' ' <<<"$out")"
}
# task <TASK_ID> [phase] — a minimal governed task.
task() {
  local dir="$RUNS/$1" phase="${2:-assigned}"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: $phase
state: $phase
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-21'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}

# --- R: resolution order, through a real writer -------------------------------
# resolved <env assignments...> — the operator update-waits-on records under them.
N=0
resolved() {
  N=$((N + 1))
  local id="TASK-$((3100 + N))" dir
  dir="$(task "$id")"
  bare env "$@" ruby "$SCRIPTS/update-waits-on.rb" "$id" add qa --actor pm --reason r >/dev/null 2>"$RUNS/resolve.err" \
    || fail "R writer failed under $*: $(cat "$RUNS/resolve.err")"
  operators "$dir/status.yaml"
}
assert_eq "$(resolved)" "-" "R no variable and no marker: no operator"
assert_eq "$(resolved CLAUDECODE=1)" "claude" "R Claude Code shell"
assert_eq "$(resolved CODEX_THREAD_ID=t1)" "codex" "R Codex shell"
assert_eq "$(resolved CURSOR_AGENT=1)" "cursor" "R cursor-agent shell"
assert_eq "$(resolved CODEX_THREAD_ID=t1 CLAUDECODE=1)" "codex" "R Codex started from Claude Code: the inner harness"
assert_eq "$(resolved CURSOR_AGENT=1 CODEX_THREAD_ID=t1 CLAUDECODE=1)" "cursor" "R Cursor started from Codex and Claude"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR=codex CLAUDECODE=1 CURSOR_AGENT=1)" "codex" "R the explicit variable wins"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR=cursor-agent)" "cursor" "R a runner name maps to its operator"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR=' Copilot ')" "copilot" "R case and spaces are ignored"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR=antigravity)" "antigravity" "R Antigravity through the variable"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR= CLAUDECODE=1)" "claude" "R an empty variable counts as unset"
assert_eq "$(resolved AI_DEV_OFFICE_HISTORY_OPERATOR=dev CLAUDECODE=1)" "-" "R an unknown value records nothing, no marker fallback"
grep -q "AI_DEV_OFFICE_HISTORY_OPERATOR" "$RUNS/resolve.err" || fail "R an unknown value must warn: $(cat "$RUNS/resolve.err")"

# --- W: every status.yaml history writer stamps its rows ----------------------
as_codex() { bare env AI_DEV_OFFICE_HISTORY_OPERATOR=codex "$@"; }
quiet() { "$@" >"$RUNS/w.log" 2>&1 || fail "W command failed: $* :: $(cat "$RUNS/w.log")"; }

# open-task.rb (created row + gate rows), then update-completion-gate.rb's three row builders.
quiet as_codex env OFFICE_TASK_PREFIX=EAR ruby "$SCRIPTS/open-task.rb" TASK-EAR-3201 --title "operator rows" --gate "smoke:checked on staging"
D="$RUNS/TASK-EAR-3201"
quiet as_codex ruby "$SCRIPTS/update-completion-gate.rb" TASK-EAR-3201 declare unit --actor pm --reason r
quiet as_codex ruby "$SCRIPTS/update-completion-gate.rb" TASK-EAR-3201 depend smoke --after unit --actor pm --reason r
quiet as_codex ruby "$SCRIPTS/update-completion-gate.rb" TASK-EAR-3201 require-record smoke --actor pm --reason r
quiet as_codex ruby "$SCRIPTS/update-waits-on.rb" TASK-EAR-3201 add qa --actor pm --reason r
quiet as_codex ruby "$SCRIPTS/update-train-carries.rb" TASK-EAR-3201 add TASK-3101 --actor pm --reason r
quiet as_codex ruby "$SCRIPTS/revise-task-plan.rb" TASK-EAR-3201 scope_expanded --actor pm --reason r --no-new-gates why
[[ "$(operators "$D/status.yaml" | wc -l | tr -d ' ')" -ge 8 ]] || fail "W expected at least 8 rows on TASK-EAR-3201"
all_rows_by "$D/status.yaml" codex "W open-task, gate, waits_on, carries, revision writers"

D="$(task TASK-3202 pending)"
quiet as_codex ruby "$SCRIPTS/update-task-branch.rb" TASK-3202 declare api --actor pm --reason r --state blocked --waiting-for "api team"
quiet as_codex ruby "$SCRIPTS/revise-task-plan.rb" TASK-3202 plan_changed --actor pm --reason r --branch "web:ready"
all_rows_by "$D/status.yaml" codex "W branch writer and branch revision"

D="$(task TASK-3203 in_review)"
quiet as_codex ruby "$SCRIPTS/force-status-route.rb" TASK-3203 "$D/status.yaml" 2026-10-21 reviewer in_review dev r
quiet as_codex ruby "$SCRIPTS/classify-task-failure.rb" TASK-3203 permission_authority --actor reviewer --reason r --history-index 0 --waiting-for w
all_rows_by "$D/status.yaml" codex "W force-status-route and classify-task-failure"

# reconcile-blocked-status.rb: a blocked task whose dependency is done.
D="$(task TASK-3204 blocked)"
ruby -ryaml -e 'p = ARGV[0]; s = YAML.load_file(p); s["blocked_on"] = ["TASK-3205"]; s["ready"] = false; File.write(p, YAML.dump(s))' "$D/status.yaml"
printf 'task_id: TASK-3205\nphase: done\nstate: done\niteration: 1\ncurrent_agent: done\n' > "$(task TASK-3205 done)/status.yaml"
quiet as_codex ruby "$SCRIPTS/reconcile-blocked-status.rb" TASK-3204 "$D/status.yaml" "$RUNS" 2026-10-21 done in_review true true true
assert_eq "$(ruby -ryaml -e 'puts YAML.load_file(ARGV[0])["phase"]' "$D/status.yaml")" "assigned" "W reconcile-blocked-status unblocked"
all_rows_by "$D/status.yaml" codex "W reconcile-blocked-status"

# reconcile-decision.rb: a human decision applied by the driver.
D="$(task TASK-3206 in_review)"
printf 'task_id: TASK-3206\ndecisions:\n  - decision: request_changes\n    actor: alice\n    decided_at: "2026-10-21T01:00:00Z"\n' > "$D/decision.yaml"
quiet as_codex ruby "$SCRIPTS/reconcile-decision.rb" TASK-3206
all_rows_by "$D/status.yaml" codex "W reconcile-decision"

# enforce-output-contract.rb (validation_failed row) and sync-status-from-output.rb.
D="$(task TASK-3207)"
printf 'summary: bad\nnext_action: {}\n' > "$D/dev-output.yaml"
rc=0; as_codex ruby "$SCRIPTS/enforce-output-contract.rb" TASK-3207 dev >"$RUNS/w.log" 2>&1 || rc=$?
assert_eq "$rc" "1" "W enforce-output-contract refuses the bad output ($(cat "$RUNS/w.log"))"
all_rows_by "$D/status.yaml" codex "W enforce-output-contract"
D="$(task TASK-3208)"
printf 'summary: ok\nartifacts: []\nnext_action:\n  agent: reviewer\n  reason: ready\nblockers: []\n' > "$D/dev-output.yaml"
quiet as_codex ruby "$SCRIPTS/sync-status-from-output.rb" TASK-3208 dev "$D/status.yaml" "$D/dev-output.yaml" 2026-10-21 in_review
all_rows_by "$D/status.yaml" codex "W sync-status-from-output"

# No variable, no marker: rows are written exactly as before (no operator key).
D="$(task TASK-3209 in_review)"
quiet bare ruby "$SCRIPTS/force-status-route.rb" TASK-3209 "$D/status.yaml" 2026-10-21 reviewer in_review dev r
grep -q 'operator' "$D/status.yaml" && fail "W a row written outside any harness must not carry operator"

# --- D: run-agent.sh credits the runner that succeeded ------------------------
ready_task() {
  local dir
  dir="$(task "$1")"
  cat > "$dir/pm-output.yaml" <<YAML
task:
  id: "$1"
  title: "Operator dispatch"
  short_name: "operator-dispatch"
  type: feature
  priority: high
scope: {}
description: "test"
acceptance_criteria: []
plan: {}
assignment:
  primary: dev
  parallel: false
  reason: "test"
summary: "test"
artifacts: []
next_action:
  agent: dev
  reason: "test"
blockers: []
YAML
  printf 'summary: "handoff"\nartifacts:\n  - path: "foo"\n    action: modified\nnext_action:\n  agent: reviewer\n  reason: "ready for review"\nblockers: []\n' > "$dir/dev-output.yaml"
  echo "$dir"
}
# sync_row_operator <status.yaml> — the operator on the dispatch's assigned -> in_review row.
sync_row_operator() {
  ruby -ryaml -rdate -e 'd = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
    row = Array(d["history"]).reverse.find { |h| h["phase"] == "assigned -> in_review" } or abort "no sync row"
    puts(row["operator"] || "-")' "$1"
}
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/codex"; chmod +x "$FAKE_BIN/codex"
D="$(ready_task TASK-3301)"
bare env CLAUDECODE=1 PATH="$FAKE_BIN:$PATH" bash "$RUN_AGENT" TASK-3301 dev codex >"$RUNS/d1.log" 2>&1 \
  || fail "D1 dispatch failed: $(tail -20 "$RUNS/d1.log")"
assert_eq "$(sync_row_operator "$D/status.yaml")" "codex" "D1 the Codex runner, though Claude Code ran the dispatch"

printf '#!/usr/bin/env bash\necho "insufficient_quota: Codex quota exhausted" >&2\nexit 42\n' > "$FAKE_BIN/codex"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/cursor"; chmod +x "$FAKE_BIN/cursor"
D="$(ready_task TASK-3302)"
bare env CLAUDECODE=1 PATH="$FAKE_BIN:$PATH" bash "$RUN_AGENT" TASK-3302 dev codex >"$RUNS/d2.log" 2>&1 \
  || fail "D2 dispatch failed: $(tail -20 "$RUNS/d2.log")"
grep -q 'switching to .cursor-agent.' "$RUNS/d2.log" || fail "D2 expected a fallback to cursor-agent: $(tail -20 "$RUNS/d2.log")"
assert_eq "$(sync_row_operator "$D/status.yaml")" "cursor" "D2 the fallback runner cursor-agent, recorded as cursor"

# --- V: the validator accepts a known operator and nothing else ---------------
validate_with_operator() {  # <task id> <yaml scalar> — exit code of the validator
  local dir
  dir="$(task "$1")"
  printf -- '- phase: pending -> assigned\n  agent: pm\n  reason: r\n  operator: %s\n' "$2" > "$RUNS/row.yaml"
  ruby -ryaml -e 'p = ARGV[0]; s = YAML.load_file(p); s["history"] = YAML.load_file(ARGV[1]); File.write(p, YAML.dump(s))' "$dir/status.yaml" "$RUNS/row.yaml"
  local rc=0
  ruby "$VALIDATOR" "$dir/status.yaml" >"$RUNS/validate.log" 2>&1 || rc=$?
  echo "$rc"
}
assert_eq "$(validate_with_operator TASK-3401 codex)" "0" "V operator codex is valid ($(cat "$RUNS/validate.log"))"
assert_eq "$(validate_with_operator TASK-3402 dev)" "1" "V a role in operator is refused"
grep -q 'history\[0\].operator' "$RUNS/validate.log" || fail "V the refusal names the field: $(cat "$RUNS/validate.log")"
assert_eq "$(validate_with_operator TASK-3403 7)" "1" "V a non-string operator is refused"

SUITE_DONE=1
echo "[PASS] history-operator: history rows record the operator that wrote them (SPAR-32)"
