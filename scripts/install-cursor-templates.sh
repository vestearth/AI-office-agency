#!/usr/bin/env bash
set -euo pipefail

OFFICE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=""
FORCE=false

usage() {
  cat <<EOF
Usage: $0 [--target <repo-root>] [--force]

Install Cursor rules and agents from ai-dev-office/templates/cursor/
into <repo-root>/.cursor/.

Default target: parent directory of ai-dev-office/ (monorepo root when office
lives at <repo>/ai-dev-office).

Existing files are skipped unless --force is set.
__REPO_ROOT__ in templates is replaced with the resolved target path.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  TARGET="$(cd "$OFFICE_ROOT/.." && pwd)"
fi

TARGET="$(cd "$TARGET" && pwd)"
TEMPLATE_ROOT="$OFFICE_ROOT/templates/cursor"
SRC_RULES="$TEMPLATE_ROOT/rules"
SRC_AGENTS="$TEMPLATE_ROOT/agents"

if [[ ! -d "$SRC_RULES" || ! -d "$SRC_AGENTS" ]]; then
  echo "[ERROR] cursor templates missing under $TEMPLATE_ROOT" >&2
  exit 1
fi

installed=0
skipped=0

mkdir -p "$TARGET/.cursor/rules" "$TARGET/.cursor/agents"

for src in "$SRC_RULES"/*; do
  [[ -f "$src" ]] || continue
  dst="$TARGET/.cursor/rules/$(basename "$src")"
  if [[ -e "$dst" && "$FORCE" != true ]]; then
    echo "[SKIP] $dst (exists; use --force to overwrite)"
    skipped=$((skipped + 1))
  else
    escaped_target="${TARGET//\\/\\\\}"
    escaped_target="${escaped_target//|/\\|}"
    sed "s|__REPO_ROOT__|$escaped_target|g" "$src" > "$dst"
    echo "[OK] $dst"
    installed=$((installed + 1))
  fi
done

for src in "$SRC_AGENTS"/*; do
  [[ -f "$src" ]] || continue
  dst="$TARGET/.cursor/agents/$(basename "$src")"
  if [[ -e "$dst" && "$FORCE" != true ]]; then
    echo "[SKIP] $dst (exists; use --force to overwrite)"
    skipped=$((skipped + 1))
  else
    escaped_target="${TARGET//\\/\\\\}"
    escaped_target="${escaped_target//|/\\|}"
    sed "s|__REPO_ROOT__|$escaped_target|g" "$src" > "$dst"
    echo "[OK] $dst"
    installed=$((installed + 1))
  fi
done

echo "Cursor templates: installed=$installed skipped=$skipped target=$TARGET"
