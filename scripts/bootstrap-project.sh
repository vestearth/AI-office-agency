#!/usr/bin/env bash
set -euo pipefail

OFFICE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=""
PROFILE="generic"

usage() {
  echo "Usage: $0 --target <target-project> [--profile <name>]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
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
  echo "[ERROR] --target is required" >&2
  usage >&2
  exit 1
fi

TARGET="$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)"

"$OFFICE_ROOT/scripts/sync-to-project.sh" --target "$TARGET" --profile "$PROFILE" >/dev/null

install_template() {
  local template="$1"
  local output="$2"
  local src="$OFFICE_ROOT/templates/$template"
  local dst="$TARGET/$output"

  if [[ ! -f "$src" ]]; then
    echo "[ERROR] template missing: $template" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dst")"
  if [[ ! -e "$dst" ]]; then
    cp "$src" "$dst"
  fi
}

install_template project-AGENTS.md AGENTS.md
install_template project-office.config.yaml office.config.yaml
install_template design.md docs/design.md
install_template task.md docs/task.md
install_template pr-review.md docs/pr-review.md
install_template decision-record.md docs/decision-record.md

mkdir -p "$TARGET/.agents/skills"
"$OFFICE_ROOT/scripts/install-cursor-templates.sh" --target "$TARGET"

echo "Bootstrapped AI Dev Office in $TARGET using profile $PROFILE"
