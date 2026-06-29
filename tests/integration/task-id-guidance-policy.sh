#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CREATION_FILES=(
  agents/pm.md
  SKILL.md
  docs/skills/office-intake.md
  templates/cursor/agents/ai-dev-office-pm.md
)

FORBIDDEN=(
  'starting or refining a TASK-NNN'
  'id: "<TASK-NNN>"'
  'next available TASK-NNN'
  'run-agent.sh TASK-NNN pm'
)

for rel in "${CREATION_FILES[@]}"; do
  for phrase in "${FORBIDDEN[@]}"; do
    if grep -Fq -- "$phrase" "$ROOT/$rel"; then
      echo "[FAIL] $rel recommends legacy new-task id: $phrase"
      exit 1
    fi
  done
done

grep -Fq 'run-agent.sh intake' "$ROOT/SKILL.md" \
  || { echo '[FAIL] SKILL must route new tasks through intake'; exit 1; }
grep -Fq 'TASK-<PREFIX>-NNN' "$ROOT/agents/pm.md" \
  || { echo '[FAIL] PM contract must describe namespaced new ids'; exit 1; }
grep -Fq 'TASK-<PREFIX>-NNN' "$ROOT/templates/cursor/agents/ai-dev-office-pm.md" \
  || { echo '[FAIL] Cursor PM trigger must describe namespaced ids'; exit 1; }

echo '[PASS] active task-id guidance follows Dashboard namespace policy'
