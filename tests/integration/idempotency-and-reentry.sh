#!/usr/bin/env bash
# M2: syncing the same agent-output artifact twice must be a no-op (a retried or
#     duplicate dispatch must not re-advance the state machine / re-increment).
# M6: pm/auto must not silently re-open a finished (done/aborted) task.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
# The extracted run-agent.sh functions are thin wrappers around
# ruby "$OFFICE_DIR/scripts/<x>.rb" (#23 Phase 2.1), so they need it set.
OFFICE_DIR="$ROOT"
RUNS_DIR="$ROOT/runs"
WORK="$(mktemp -d)"; BIN="$(mktemp -d)"; CALL="$(mktemp -d)"
T_DONE="TASK-M6DONE$$"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  rm -rf "$@"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap 'finish "$WORK" "$BIN" "$CALL" "$RUNS_DIR/$T_DONE"' EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
yval() { ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
path, key = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts key.split(".").reduce(d) { |m, p| m.is_a?(Hash) ? m[p] : nil }.to_s
RUBY
}

# ── M2: idempotent sync ───────────────────────────────────────────────────────
awk '/^sync_status_from_output\(\) \{/{f=1} f{print} f && $0=="}"{exit}' "$DRIVER" > "$WORK/sync.sh"
# shellcheck disable=SC1090
source "$WORK/sync.sh"
mkdir -p "$WORK/M2"
cat > "$WORK/M2/status.yaml" <<'Y'
task_id: TASK-M2
phase: assigned
state: assigned
iteration: 0
current_agent: dev
history: []
Y
cat > "$WORK/M2/dev-output.yaml" <<'Y'
summary: implemented the thing
artifacts:
  - path: foo.go
    action: modified
next_action:
  agent: reviewer
  reason: ready for review
blockers: []
Y
sync_status_from_output TASK-M2 dev "$WORK/M2/status.yaml" "$WORK/M2/dev-output.yaml" 2026-01-01 in_review >/dev/null
it1="$(yval "$WORK/M2/status.yaml" iteration)"
ph1="$(yval "$WORK/M2/status.yaml" phase)"
[[ "$it1" == "1" ]] || fail "M2: first sync should increment iteration to 1, got '$it1'"
[[ "$ph1" == "in_review" ]] || fail "M2: first sync should advance to in_review, got '$ph1'"
# Re-sync the SAME artifact (simulates a retried/duplicate dispatch).
out2="$(sync_status_from_output TASK-M2 dev "$WORK/M2/status.yaml" "$WORK/M2/dev-output.yaml" 2026-01-01 in_review)"
it2="$(yval "$WORK/M2/status.yaml" iteration)"
[[ "$it2" == "1" ]] || fail "M2: re-sync must NOT re-increment iteration (got '$it2', want 1)"
echo "$out2" | grep -q "already synced" || fail "M2: re-sync should report an idempotent skip"
ok "M2: re-syncing the same output artifact is a no-op (iteration stays 1)"

# ── M6: terminal re-entry guard ───────────────────────────────────────────────
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$M6_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"; exit 0
SH
chmod +x "$BIN/codex"
calls() { [[ -f "$CALL/codex.count" ]] && cat "$CALL/codex.count" || echo 0; }
mkdir -p "$RUNS_DIR/$T_DONE"
cat > "$RUNS_DIR/$T_DONE/status.yaml" <<YAML
task_id: $T_DONE
phase: done
state: done
iteration: 4
current_agent: done
ready: false
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
echo "# done task" > "$RUNS_DIR/$T_DONE/task.md"

for who in pm auto; do
  rm -f "$CALL/codex.count"
  rc=0; M6_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T_DONE" "$who" codex >"$WORK/reopen.log" 2>&1 || rc=$?
  [[ "$rc" -ne 0 ]] || fail "M6: '$who' on a done task must be refused"
  [[ "$(calls)" -eq 0 ]] || fail "M6: refused '$who' must not dispatch the runner"
  grep -q "refusing to re-open" "$WORK/reopen.log" || { cat "$WORK/reopen.log"; fail "M6: expected re-open refusal for '$who'"; }
done
ok "M6: pm/auto refuse to re-open a done task (0 runner calls)"

# FORCE override bypasses the M6 guard (must not print the refusal).
rm -f "$CALL/codex.count"
AI_DEV_OFFICE_FORCE=true M6_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T_DONE" auto codex >"$WORK/force.log" 2>&1 || true
grep -q "refusing to re-open" "$WORK/force.log" && fail "M6: AI_DEV_OFFICE_FORCE=true must bypass the re-open guard" || true
ok "M6: AI_DEV_OFFICE_FORCE=true bypasses the re-open guard"

SUITE_DONE=1
echo "[PASS] idempotency-and-reentry (M2 + M6)"
