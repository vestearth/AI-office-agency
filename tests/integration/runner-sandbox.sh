#!/usr/bin/env bash
# codex exec defaults to a read-only sandbox, so a dispatched role could read
# the service repos but never edit them. The codex runner must open
# workspace-write over every sibling git repo except the configured read-only
# ones (Games-Lab-Android), with network on for go/npm, and tell the role that
# .git stays read-only.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
TASK_ID="TASK-${SUFFIX}S"
TEST_BIN_DIR="$(mktemp -d)"
CALL_DIR="$(mktemp -d)"
WORKSPACE="$(mktemp -d)"

cleanup() {
  rm -rf "$RUNS_DIR/$TASK_ID" "$TEST_BIN_DIR" "$CALL_DIR" "$WORKSPACE"
}
# bash 3.2 can enter this trap with $?=0 after a set -u abort, so completion is
# proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=
finish() {
  local rc=$?
  cleanup
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

fail() { echo "[FAIL] $1"; exit 1; }

# Fake workspace: two writable repos (a .git directory and a worktree-style
# .git file), the read-only Android repo, and a plain directory.
mkdir -p "$WORKSPACE/svc-a/.git" "$WORKSPACE/svc-b" "$WORKSPACE/Games-Lab-Android/.git" "$WORKSPACE/notes"
echo "gitdir: /elsewhere" > "$WORKSPACE/svc-b/.git"

mkdir -p "$RUNS_DIR/$TASK_ID"
cat > "$RUNS_DIR/$TASK_ID/status.yaml" <<YAML
task_id: $TASK_ID
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-10-12"
updated_at: "2026-10-12"
history: []
YAML

cat > "$TEST_BIN_DIR/codex" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$RUNNER_SANDBOX_CALL_DIR/codex.args"
exit 0
SH
chmod +x "$TEST_BIN_DIR/codex"

RUNNER_SANDBOX_CALL_DIR="$CALL_DIR" AI_OFFICE_WORKSPACE_ROOT="$WORKSPACE" PATH="$TEST_BIN_DIR:$PATH" \
  "$RUN_AGENT" "$TASK_ID" dev codex >/dev/null 2>&1 || true

ARGS="$CALL_DIR/codex.args"
[[ -f "$ARGS" ]] || fail "codex stub was never invoked"

has_pair() { grep -Fxq -- "$1" "$ARGS" && grep -A1 -Fx -- "$1" "$ARGS" | grep -Fxq -- "$2"; }

echo "== workspace-write sandbox with network =="
has_pair "--sandbox" "workspace-write" || fail "codex must run with --sandbox workspace-write"
has_pair "-c" "sandbox_workspace_write.network_access=true" || fail "workspace-write must enable network access"

echo "== writable roots =="
has_pair "--add-dir" "$ROOT_DIR" || fail "the office itself must be writable"
has_pair "--add-dir" "$WORKSPACE/svc-a" || fail "a repo with a .git directory must be writable"
has_pair "--add-dir" "$WORKSPACE/svc-b" || fail "a worktree-style repo (.git file) must be writable"

echo "== excluded roots =="
if grep -Fxq "$WORKSPACE/Games-Lab-Android" "$ARGS"; then fail "Games-Lab-Android must never be a writable root"; fi
if grep -Fxq "$WORKSPACE/notes" "$ARGS"; then fail "a directory without .git must not be a writable root"; fi
[[ "$(grep -Fxc -- "--add-dir" "$ARGS")" == "3" ]] || fail "expected exactly three writable roots (office, svc-a, svc-b)"

echo "== prompt tells the role git is read-only =="
grep -Fq "RUNNER SANDBOX" "$ARGS" || fail "the codex prompt must carry the RUNNER SANDBOX note"

SUITE_DONE=1
echo "[PASS] runner-sandbox"
