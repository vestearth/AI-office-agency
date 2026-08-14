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

PROFILE_FILE="$OFFICE_ROOT/profiles/$PROFILE.yaml"
if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "[ERROR] profile not found: $PROFILE" >&2
  exit 1
fi

TARGET="$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)"
DEST="$TARGET/ai-dev-office"
mkdir -p "$DEST"

copy_path() {
  local rel="$1"
  local src="$OFFICE_ROOT/$rel"
  local dst="$DEST/$rel"

  if [[ ! -e "$src" ]]; then
    echo "[ERROR] install source missing: $rel" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  cp -R "$src" "$dst"
}

CORE_PATHS=(
  AGENTS.md
  SKILL.md
  README.md
  office.config.example.yaml
  docs/config-profile-merge-contract.md
  docs/getting-started.md
  docs/run-records.md
  docs/codex.md
  docs/cursor.md
  docs/cursor-templates.md
  docs/socraticode.md
  docs/evidence-contract.md
  agents
  runners
  workflows
  schemas
  profiles
  templates
  scripts/bootstrap-project.sh
  scripts/record-run.rb
  scripts/sync-to-project.sh
  scripts/install-cursor-templates.sh
  scripts/resolve-office-config.rb
  scripts/validate-knowledge-librarian.rb
  scripts/record-evidence.sh
)

for rel in "${CORE_PATHS[@]}"; do
  copy_path "$rel"
done

if [[ "$PROFILE" == "games-labs" ]]; then
  copy_path scripts/check-service-dependencies.sh
fi

"$OFFICE_ROOT/scripts/install-cursor-templates.sh" --target "$TARGET"

echo "Synced AI Dev Office to $TARGET using profile $PROFILE"
