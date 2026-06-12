#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TARGET_DIR"
}
trap cleanup EXIT

assert_file() {
  local path="$1"
  local message="$2"
  if [[ ! -f "$path" ]]; then
    echo "[FAIL] $message: missing file $path"
    exit 1
  fi
}

assert_dir() {
  local path="$1"
  local message="$2"
  if [[ ! -d "$path" ]]; then
    echo "[FAIL] $message: missing directory $path"
    exit 1
  fi
}

assert_no_path() {
  local path="$1"
  local message="$2"
  if [[ -e "$path" ]]; then
    echo "[FAIL] $message: unexpected path $path"
    exit 1
  fi
}

assert_contains() {
  local path="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq -- "$expected" "$path"; then
    echo "[FAIL] $message: expected '$expected' in $path"
    echo "----- $path -----"
    cat "$path"
    exit 1
  fi
}

echo "== Scenario 1: bootstrap creates a generic target project =="
"$ROOT_DIR/scripts/bootstrap-project.sh" --target "$TARGET_DIR" --profile generic >/tmp/bootstrap-project.log 2>&1

assert_file "$TARGET_DIR/AGENTS.md" "bootstrap should install project AGENTS template"
assert_file "$TARGET_DIR/office.config.yaml" "bootstrap should install project office config"
assert_file "$TARGET_DIR/docs/design.md" "bootstrap should install design template"
assert_file "$TARGET_DIR/docs/task.md" "bootstrap should install task template"
assert_file "$TARGET_DIR/docs/pr-review.md" "bootstrap should install review template"
assert_file "$TARGET_DIR/docs/decision-record.md" "bootstrap should install decision record template"
assert_dir "$TARGET_DIR/.agents/skills" "bootstrap should prepare agent skills directory"
assert_dir "$TARGET_DIR/.cursor/rules" "bootstrap should prepare Cursor rules directory"
assert_dir "$TARGET_DIR/.cursor/agents" "bootstrap should prepare Cursor agents directory"
assert_file "$TARGET_DIR/.cursor/rules/ai-dev-office.mdc" "bootstrap should install Cursor rules from templates"
assert_file "$TARGET_DIR/.cursor/agents/ai-dev-office-dev.md" "bootstrap should install Cursor agent stubs from templates"
assert_contains "$TARGET_DIR/.cursor/rules/socraticode.mdc" "$TARGET_DIR" "bootstrap should substitute __REPO_ROOT__ in socraticode rule"
assert_file "$TARGET_DIR/ai-dev-office/AGENTS.md" "bootstrap should install framework files"
assert_file "$TARGET_DIR/ai-dev-office/docs/getting-started.md" "bootstrap should install core getting-started doc"
assert_file "$TARGET_DIR/ai-dev-office/docs/codex.md" "bootstrap should install core codex doc"
assert_file "$TARGET_DIR/ai-dev-office/docs/cursor.md" "bootstrap should install core cursor doc"
assert_file "$TARGET_DIR/ai-dev-office/profiles/generic.yaml" "bootstrap should install selected profile"
assert_no_path "$TARGET_DIR/ai-dev-office/runs" "bootstrap must not copy runtime history by default"
assert_no_path "$TARGET_DIR/ai-dev-office/office.config.local.yaml" "bootstrap must not copy local config"
assert_contains /tmp/bootstrap-project.log "Bootstrapped AI Dev Office" "bootstrap should print summary"

echo "== Scenario 2: sync updates framework files without runtime history =="
rm "$TARGET_DIR/ai-dev-office/README.md"
"$ROOT_DIR/scripts/sync-to-project.sh" --target "$TARGET_DIR" --profile games-labs >/tmp/sync-project.log 2>&1

assert_file "$TARGET_DIR/ai-dev-office/README.md" "sync should restore framework README"
assert_file "$TARGET_DIR/ai-dev-office/profiles/games-labs.yaml" "sync should install selected profile"
assert_file "$TARGET_DIR/ai-dev-office/scripts/check-service-dependencies.sh" "sync should install Games Labs dependency guard"
assert_no_path "$TARGET_DIR/ai-dev-office/runs" "sync must not copy runtime history by default"
assert_contains /tmp/sync-project.log "Synced AI Dev Office" "sync should print summary"

echo "[PASS] bootstrap/sync integration scenarios passed"
