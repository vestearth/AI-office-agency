#!/usr/bin/env bash
# M4: validation_failed is a bounded, route-out state. It routes current_agent to
# free-roam, counts retries (sync is skipped so `iteration` can't), refuses silent
# re-dispatch of the failing agent, and hard-halts after the retry cap.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
ENFORCE="$ROOT/scripts/enforce-output-contract.rb"
WORK="$(mktemp -d)"; BIN="$(mktemp -d)"; CALL="$(mktemp -d)"
# Part 2's fixtures must live where the driver looks. Since the reviewer-gate
# slice made run-agent.sh honour AI_OFFICE_RUNS_DIR (exported below), pointing
# these at the real runs/ meant the driver resolved the temp store and could not
# find them — and it was writing fixtures into the operator's live task tree.
RUNS_DIR="$WORK/runs"
T2="TASK-M4REF$$"; T3="TASK-M4HALT$$"
trap 'rm -rf "$WORK" "$BIN" "$CALL" "$RUNS_DIR/$T2" "$RUNS_DIR/$T3"' EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
yval() { ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
path, key = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts key.split(".").reduce(d) { |m, p| m.is_a?(Hash) ? m[p] : nil }.to_s
RUBY
}
hsize() { ruby -ryaml -e 'puts((YAML.load_file(ARGV[0])["history"] || []).size)' "$1"; }

# ── Part 1: enforce routes to free-roam, counts retries, no history churn ──────
export AI_OFFICE_RUNS_DIR="$WORK/runs"
TD="$WORK/runs/TASK-M4"; mkdir -p "$TD"
cat > "$TD/status.yaml" <<'Y'
task_id: TASK-M4
phase: in_review
state: in_review
iteration: 2
current_agent: reviewer
history: []
Y
cat > "$TD/reviewer-output.yaml" <<'Y'
summary: "Reviewed."
artifacts: []
next_action:
  agent: done
  reason: "x"
blockers: []
review_verdict: totally_bogus_verdict
build_check:
  compile: pass
  tests: pass
  details: "x"
Y
ruby "$ENFORCE" TASK-M4 reviewer >/dev/null 2>&1 || true
[[ "$(yval "$TD/status.yaml" phase)" == "validation_failed" ]] || fail "M4: phase should be validation_failed"
[[ "$(yval "$TD/status.yaml" current_agent)" == "free-roam" ]] || fail "M4: current_agent should route to free-roam"
[[ "$(yval "$TD/status.yaml" validation_failed_retries)" == "1" ]] || fail "M4: retries should be 1"
h1="$(hsize "$TD/status.yaml")"
ruby "$ENFORCE" TASK-M4 reviewer >/dev/null 2>&1 || true   # second failure
[[ "$(yval "$TD/status.yaml" validation_failed_retries)" == "2" ]] || fail "M4: retries should increment to 2"
[[ "$h1" == "$(hsize "$TD/status.yaml")" ]] || fail "M4: history must not churn on repeated validation_failed"
ok "M4 enforce: routes to free-roam, retries 1->2, no history churn"

# ── driver setup (fake codex) ─────────────────────────────────────────────────
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$M4_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"; exit 0
SH
chmod +x "$BIN/codex"
calls() { [[ -f "$CALL/codex.count" ]] && cat "$CALL/codex.count" || echo 0; }
mkvf() {  # <task> <retries>
  mkdir -p "$RUNS_DIR/$1"
  cat > "$RUNS_DIR/$1/status.yaml" <<YAML
task_id: $1
phase: validation_failed
state: validation_failed
iteration: 3
current_agent: free-roam
validation_failed_retries: $2
ready: false
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
  echo "# t" > "$RUNS_DIR/$1/task.md"
}

# ── Part 2: refuse silent re-dispatch of the failing agent ────────────────────
rm -f "$CALL/codex.count"; mkvf "$T2" 1
rc=0; M4_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T2" dev codex >"$WORK/ref.log" 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] || fail "M4: dev on validation_failed must be refused"
[[ "$(calls)" -eq 0 ]] || fail "M4: refused dispatch must not call the runner"
grep -q "refusing to re-dispatch" "$WORK/ref.log" || { cat "$WORK/ref.log"; fail "M4: expected refusal message"; }
ok "M4 driver: refuses re-dispatch of the failing agent (0 runner calls)"

# ── Part 3: hard-halt at the retry cap ────────────────────────────────────────
rm -f "$CALL/codex.count"; mkvf "$T3" 3   # >= default limit (3)
rc=0; M4_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T3" free-roam codex >"$WORK/halt.log" 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] || fail "M4: validation_failed at the cap must halt"
[[ "$(calls)" -eq 0 ]] || fail "M4: halt must not call the runner"
grep -q "Halting" "$WORK/halt.log" || { cat "$WORK/halt.log"; fail "M4: expected halt message"; }
ok "M4 driver: halts at the retry cap (0 runner calls)"

echo "[PASS] validation-failed-bounded (M4)"
