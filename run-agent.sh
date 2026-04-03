#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$OFFICE_DIR/agents"
RUNS_DIR="$OFFICE_DIR/runs"

usage() {
  cat <<EOF
Usage: ./run-agent.sh <TASK_ID> <AGENT> [RUNNER]

  TASK_ID   Task identifier (e.g. TASK-003)
  AGENT     Agent role: pm | dev | dev-2 | reviewer | debugger | devops | free-roam
  RUNNER    Optional: copilot (default) | codex
            For Cursor: use the IDE directly (see ai-dev-office/SKILL.md)

Runner priority: copilot > cursor (IDE) > codex

Examples:
  ./run-agent.sh TASK-011 pm                  # runs with copilot (default)
  ./run-agent.sh TASK-011 dev
  ./run-agent.sh TASK-011 dev codex           # force codex runner
  ./run-agent.sh TASK-011 reviewer copilot    # explicit copilot

Pipeline shortcut (runs full flow automatically):
  ./run-agent.sh TASK-011 auto
EOF
  exit 1
}

[[ $# -lt 2 ]] && usage

TASK_ID="$1"
AGENT="$2"
RUNNER="${3:-copilot}"

TASK_DIR="$RUNS_DIR/$TASK_ID"
AGENT_FILE="$AGENTS_DIR/$AGENT.md"
TASK_FILE="$TASK_DIR/task.md"
STATUS_FILE="$TASK_DIR/status.yaml"
OUTPUT_FILE="$TASK_DIR/${AGENT}-output.yaml"

if [[ "$AGENT" == "pm" && ! -d "$TASK_DIR" ]]; then
  echo "Creating task directory: $TASK_DIR"
  mkdir -p "$TASK_DIR"
fi

if [[ "$AGENT" != "pm" && ! -d "$TASK_DIR" ]]; then
  echo "Error: Task directory not found: $TASK_DIR"
  echo "Run PM first: ./run-agent.sh $TASK_ID pm"
  exit 1
fi

if [[ "$AGENT" == "auto" ]]; then
  echo "=== Auto Pipeline for $TASK_ID ==="
  FLOW=(pm dev reviewer)
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
      if [[ "$NEXT" == "debugger" || "$NEXT" == "free-roam" || "$NEXT" == "devops" ]]; then
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

# Collect ALL dev outputs for reviewer (fixes parallel dev gap)
ALL_DEV_OUTPUTS=""
if [[ "$AGENT" == "reviewer" ]]; then
  for f in "$TASK_DIR"/dev-output.yaml "$TASK_DIR"/dev-2-output.yaml; do
    if [[ -f "$f" ]]; then
      DEV_NAME=$(basename "$f" | sed 's/-output\.yaml//')
      ALL_DEV_OUTPUTS="${ALL_DEV_OUTPUTS}
--- DEV OUTPUT ($DEV_NAME) ---
$(cat "$f")"
    fi
  done
fi

# Find the most recent non-planner, non-pm output for other agents
PREV_OUTPUT=""
for f in "$TASK_DIR"/*-output.yaml; do
  [[ -f "$f" ]] && PREV_OUTPUT="$f"
done

PM_SECTION=""
if [[ "$AGENT" != "pm" && -f "$TASK_DIR/pm-output.yaml" ]]; then
  PM_SECTION="
--- PM OUTPUT ---
$(cat "$TASK_DIR/pm-output.yaml")"
fi

PREV_SECTION=""
if [[ "$AGENT" == "reviewer" && -n "$ALL_DEV_OUTPUTS" ]]; then
  PREV_SECTION="$ALL_DEV_OUTPUTS"
elif [[ -n "$PREV_OUTPUT" && "$PREV_OUTPUT" != "$TASK_DIR/pm-output.yaml" ]]; then
  PREV_AGENT=$(basename "$PREV_OUTPUT" | sed 's/-output\.yaml//')
  PREV_SECTION="
--- PREVIOUS AGENT OUTPUT ($PREV_AGENT) ---
$(cat "$PREV_OUTPUT")"
fi

TASK_SECTION=""
if [[ -f "$TASK_FILE" ]]; then
  TASK_SECTION="
--- TASK ---
$(cat "$TASK_FILE")"
fi

STATUS_SECTION=""
if [[ -f "$STATUS_FILE" ]]; then
  STATUS_SECTION="
--- STATUS ---
$(cat "$STATUS_FILE")"
fi

PROMPT="$(cat "$AGENT_FILE")
${TASK_SECTION}${STATUS_SECTION}${PM_SECTION}${PREV_SECTION}

Produce your output following the Output Contract in your role definition."

echo "=== Running $AGENT for $TASK_ID (runner: $RUNNER) ==="

case "$RUNNER" in
  copilot)
    gh copilot suggest -t shell "$PROMPT"
    ;;
  codex)
    codex --approval-mode full-auto --quiet -p "$PROMPT"
    ;;
  cursor)
    echo "Cursor is an interactive IDE runner."
    echo "Paste the following into Cursor chat or reference @ai-dev-office/agents/$AGENT.md"
    echo ""
    echo "--- Prompt (saved to $TASK_DIR/.cursor-prompt.md) ---"
    echo "$PROMPT" > "$TASK_DIR/.cursor-prompt.md"
    echo "Prompt saved. Open it in Cursor and run."
    ;;
  *)
    echo "Error: Unknown runner '$RUNNER'. Use: copilot | codex | cursor"
    exit 1
    ;;
esac

echo ""
echo "=== $AGENT completed for $TASK_ID ==="
echo "Save output to: $OUTPUT_FILE"
echo "Then run next agent or use: ./run-agent.sh $TASK_ID auto"
