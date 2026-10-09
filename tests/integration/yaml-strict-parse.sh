#!/usr/bin/env bash
# Ruby's YAML loader keeps the LAST value of a duplicated key and only the FIRST
# document of a multi-document file, silently. The dashboard's js-yaml rejects
# both, so such a status.yaml validated clean here yet showed as an unreadable
# task there. The validator must refuse both shapes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT/runs"
TASK="TASK-990002"
TASK_DIR="$RUNS_DIR/$TASK"

cleanup() {
  rm -rf "$TASK_DIR"
}
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  cleanup
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

write_status() {
  mkdir -p "$TASK_DIR"
  cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: done
state: done
iteration: 1
current_agent: done
assignment:
  primary: dev
  parallel: false
created_at: "2026-10-09"
updated_at: "2026-10-09"
history:
- phase: assigned -> done
  agent: dev
  reason: first
$1
YAML
}

expect_rejected() {
  local name="$1" pattern="$2" out
  if out="$(ruby "$ROOT/validate-yaml.rb" "$TASK" 2>&1)"; then
    echo "[FAIL] $name: validator accepted it"
    echo "$out"
    exit 1
  fi
  if ! grep -q "$pattern" <<<"$out"; then
    echo "[FAIL] $name: rejected without naming the problem ($pattern)"
    echo "$out"
    exit 1
  fi
  echo "[ok] $name"
}

# A second top-level history: list replaces the first one in Ruby.
write_status "history:
- phase: done -> done
  agent: reviewer
  reason: second"
expect_rejected "duplicate top-level key" "duplicate key 'history' at line"

# A duplicated key inside a list item (two reason: in one history entry).
write_status "  reason: again"
expect_rejected "duplicate nested key" "duplicate key 'reason' at line"

# A stray trailing document separator makes a second (empty) document.
write_status "---"
expect_rejected "trailing document separator" "more than one YAML document"

# The same file without those defects still validates.
write_status ""
ruby "$ROOT/validate-yaml.rb" "$TASK" >/dev/null
echo "[ok] clean status.yaml validates"

SUITE_DONE=1
echo "[PASS] yaml-strict-parse"
