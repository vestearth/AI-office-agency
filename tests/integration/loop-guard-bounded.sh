#!/usr/bin/env bash
# M3: the free-roam loop guard must be BOUNDED. free-roam no longer zeroes the
# work-agent iteration budget; a separate non-resettable free_roam_entries
# counter halts the task after a small cap instead of looping forever.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
# The extracted run-agent.sh functions are thin wrappers around
# ruby "$OFFICE_DIR/scripts/<x>.rb" (#23 Phase 2.1), so they need it set.
OFFICE_DIR="$ROOT"
RUNS_DIR="$ROOT/runs"
WORK="$(mktemp -d)"; BIN="$(mktemp -d)"; CALL="$(mktemp -d)"
T_HALT="TASK-M3HALT$$"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$@"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap 'finish "$WORK" "$BIN" "$CALL" "$RUNS_DIR/$T_HALT"' EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
yval() { ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
path, key = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts key.split(".").reduce(d) { |m, p| m.is_a?(Hash) ? m[p] : nil }.to_s
RUBY
}

# ── Part 1: sync carries iteration forward + increments free_roam_entries ──────
awk '/^sync_status_from_output\(\) \{/{f=1} f{print} f && $0=="}"{exit}' "$DRIVER" > "$WORK/sync.sh"
# shellcheck disable=SC1090
source "$WORK/sync.sh"
mkdir -p "$WORK/P1"
cat > "$WORK/P1/status.yaml" <<'Y'
task_id: TASK-P1
phase: escalated
state: escalated
iteration: 5
free_roam_entries: 0
current_agent: free-roam
Y
cat > "$WORK/P1/out.yaml" <<'Y'
summary: handled the escalation
next_action:
  agent: dev
  reason: retry implementation
Y
sync_status_from_output TASK-P1 free-roam "$WORK/P1/status.yaml" "$WORK/P1/out.yaml" 2026-01-01 in_review >/dev/null
it="$(yval "$WORK/P1/status.yaml" iteration)"
fr="$(yval "$WORK/P1/status.yaml" free_roam_entries)"
[[ "$it" == "6" ]] || fail "M3: iteration must carry forward (5->6 for dev), got '$it' (free-roam reset bug?)"
[[ "$fr" == "1" ]] || fail "M3: free_roam_entries must increment to 1, got '$fr'"
ok "M3 sync: iteration carries (6, not reset to 0/1) + free_roam_entries=1"

# ── Part 2: the real driver halts free-roam at the cap WITHOUT dispatching ─────
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$M3_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"; exit 0
SH
chmod +x "$BIN/codex"
mkdir -p "$RUNS_DIR/$T_HALT"
cat > "$RUNS_DIR/$T_HALT/status.yaml" <<YAML
task_id: $T_HALT
phase: escalated
state: escalated
iteration: 9
free_roam_entries: 99
current_agent: free-roam
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
echo "# halt task" > "$RUNS_DIR/$T_HALT/task.md"
rc=0
M3_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T_HALT" free-roam codex >"$WORK/halt.log" 2>&1 || rc=$?
calls=0; [[ -f "$CALL/codex.count" ]] && calls="$(cat "$CALL/codex.count")"
[[ "$rc" -ne 0 ]] || fail "M3: free-roam past the cap must halt (exit nonzero), got rc 0"
[[ "$calls" -eq 0 ]] || fail "M3: free-roam past the cap must NOT dispatch the runner, got $calls call(s)"
grep -q "Free-roam loop guard triggered" "$WORK/halt.log" || { echo "--- log ---"; cat "$WORK/halt.log"; fail "M3: expected the free-roam loop-guard halt message"; }
ok "M3 driver: free_roam_entries past cap halts before dispatch (0 runner calls)"

SUITE_DONE=1
echo "[PASS] loop-guard-bounded: free-roam budget is bounded (M3)"
