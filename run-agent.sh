#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$OFFICE_DIR/agents"
RUNS_DIR="$OFFICE_DIR/runs"

usage() {
  cat <<EOF
Usage: ./run-agent.sh <TASK_ID> <AGENT> [RUNNER]

  TASK_ID   Task identifier (e.g. TASK-003)
  AGENT     Agent role: planner | dev | dev-2 | reviewer | debugger | tester | free-roam
  RUNNER    Optional: codex (default) | copilot

Examples:
  ./run-agent.sh TASK-003 planner
  ./run-agent.sh TASK-003 dev
  ./run-agent.sh TASK-003 reviewer
  ./run-agent.sh TASK-003 reviewer copilot    # force copilot runner

Pipeline shortcut (runs full flow automatically):
  ./run-agent.sh TASK-003 auto
EOF
  exit 1
}

[[ $# -lt 2 ]] && usage

TASK_ID="$1"
AGENT="$2"
RUNNER="${3:-codex}"

TASK_DIR="$RUNS_DIR/$TASK_ID"
AGENT_FILE="$AGENTS_DIR/$AGENT.md"
TASK_FILE="$TASK_DIR/task.md"
STATUS_FILE="$TASK_DIR/status.yaml"
OUTPUT_FILE="$TASK_DIR/${AGENT}-output.yaml"

if [[ ! -d "$TASK_DIR" ]]; then
  echo "Error: Task directory not found: $TASK_DIR"
  echo "Create it first: mkdir -p $TASK_DIR"
  exit 1
fi

if [[ "$AGENT" == "auto" ]]; then
  echo "=== Auto Pipeline for $TASK_ID ==="
  FLOW=(planner dev reviewer tester)
  for STEP in "${FLOW[@]}"; do
    echo ""
    echo ">>> Running $STEP ..."
    "$0" "$TASK_ID" "$STEP" "$RUNNER"
    STEP_OUTPUT="$TASK_DIR/${STEP}-output.yaml"
    if [[ -f "$STEP_OUTPUT" ]] && grep -q "next_action" "$STEP_OUTPUT" 2>/dev/null; then
      NEXT=$(grep -A1 "next_action" "$STEP_OUTPUT" | grep "agent:" | head -1 | sed 's/.*agent: *//' | tr -d '[:space:]')
      if [[ "$NEXT" == "done" ]]; then
        echo ""
        echo "=== Task $TASK_ID completed! ==="
        exit 0
      fi
      if [[ "$NEXT" == "debugger" || "$NEXT" == "free-roam" ]]; then
        echo ">>> Flow diverged to $NEXT, running..."
        "$0" "$TASK_ID" "$NEXT" "$RUNNER"
      fi
    fi
  done
  echo ""
  echo "=== Pipeline finished for $TASK_ID ==="
  exit 0
fi

if [[ ! -f "$AGENT_FILE" ]]; then
  echo "Error: Agent prompt not found: $AGENT_FILE"
  exit 1
fi

PREV_OUTPUT=""
for f in "$TASK_DIR"/*-output.yaml; do
  [[ -f "$f" ]] && PREV_OUTPUT="$f"
done

PLANNER_SECTION=""
if [[ "$AGENT" != "planner" && -f "$TASK_DIR/planner-output.yaml" ]]; then
  PLANNER_SECTION="
--- PLANNER OUTPUT ---
$(cat "$TASK_DIR/planner-output.yaml")"
fi

PREV_SECTION=""
if [[ -n "$PREV_OUTPUT" && "$PREV_OUTPUT" != "$TASK_DIR/planner-output.yaml" ]]; then
  PREV_AGENT=$(basename "$PREV_OUTPUT" | sed 's/-output\.yaml//')
  PREV_SECTION="
--- PREVIOUS AGENT OUTPUT ($PREV_AGENT) ---
$(cat "$PREV_OUTPUT")"
fi

PROMPT="$(cat "$AGENT_FILE")

--- TASK ---
$(cat "$TASK_FILE")

--- STATUS ---
$(cat "$STATUS_FILE")
${PLANNER_SECTION}${PREV_SECTION}

Produce your output following the Output Contract in your role definition."

echo "=== Running $AGENT for $TASK_ID (runner: $RUNNER) ==="

if [[ "$RUNNER" == "copilot" ]]; then
  gh copilot suggest -t shell "$PROMPT"
else
  codex --approval-mode full-auto --quiet -p "$PROMPT"
fi

echo ""
echo "=== $AGENT completed for $TASK_ID ==="
echo "Save output to: $OUTPUT_FILE"
echo "Then run next agent or use: ./run-agent.sh $TASK_ID auto"
