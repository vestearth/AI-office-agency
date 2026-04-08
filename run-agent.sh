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
  RUNNER    Optional: copilot (default) | codex | cursor
            For Cursor: use the IDE directly (see ai-dev-office/SKILL.md)

Runner priority: copilot > cursor (IDE) > codex

Examples:
  ./run-agent.sh TASK-011 pm                  # runs with copilot (default)
  ./run-agent.sh TASK-011 dev
  ./run-agent.sh TASK-011 dev codex           # force codex runner
  ./run-agent.sh TASK-011 reviewer copilot    # explicit copilot
  ./run-agent.sh TASK-011 dev cursor          # generate Cursor prompt

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
TODAY="$(date +%F)"

sync_status_from_output() {
  local task_id="$1"
  local agent="$2"
  local status_file="$3"
  local output_file="$4"
  local today="$5"

  ruby - "$task_id" "$agent" "$status_file" "$output_file" "$today" <<'RUBY'
require "yaml"
require "time"

task_id, actor_agent, status_path, output_path, today = ARGV

unless File.exist?(output_path)
  warn "Status sync skipped: output file missing at #{output_path}"
  exit 0
end

status = if File.exist?(status_path)
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end
output = YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true) || {}

next_action = output["next_action"].is_a?(Hash) ? output["next_action"] : {}
next_agent = next_action["agent"]&.to_s&.strip
reason = next_action["reason"].to_s.strip

# Reviewer-specific fallback when next_action is missing in malformed output.
if (next_agent.nil? || next_agent.empty?) && actor_agent == "reviewer"
  verdict = output["review_verdict"].to_s.strip
  next_agent = case verdict
               when "approved" then "done"
               when "changes_requested" then "debugger"
               when "escalate" then "free-roam"
               when "infra_failure" then "devops"
               else nil
               end
end

if next_agent.nil? || next_agent.empty?
  warn "Status sync skipped: unable to determine next agent from #{output_path}"
  exit 0
end

old_phase = status["phase"].to_s.strip
old_phase = "pending" if old_phase.empty?

# Resolve phase with workflow-aware transitions first, then fallback.
new_phase =
  case actor_agent
  when "pm"
    case next_agent
    when "dev", "dev-2" then "assigned"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "dev", "dev-2"
    case next_agent
    when "reviewer" then "review"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "reviewer"
    case next_agent
    when "done" then "done"
    when "debugger" then "debugging"
    when "free-roam" then "escalated"
    when "devops" then "devops_needed"
    else old_phase
    end
  when "debugger"
    case next_agent
    when "reviewer" then "review"
    when "dev", "dev-2" then "debugging_complete"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "devops"
    case next_agent
    when "reviewer" then "review"
    when "dev", "dev-2" then "devops_complete"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "free-roam"
    case next_agent
    when "dev", "dev-2" then "free_roam_complete"
    when "pm" then "pending"
    when "done" then "aborted"
    else old_phase
    end
  else
    fallback_phase_map = {
      "pm" => "pending",
      "dev" => "assigned",
      "dev-2" => "assigned",
      "reviewer" => "review",
      "debugger" => "debugging",
      "devops" => "devops_needed",
      "free-roam" => "escalated",
      "done" => "done"
    }
    fallback_phase_map.fetch(next_agent, old_phase)
  end

iteration = status["iteration"].to_i
status["iteration"] = iteration + 1
status["task_id"] ||= task_id
status["phase"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["history"] = [] unless status["history"].is_a?(Array)

if reason.empty?
  summary = output["summary"].to_s.strip
  reason = summary.lines.first.to_s.strip
end
reason = "Transitioned by #{actor_agent} output." if reason.empty?

status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason
}

File.write(status_path, YAML.dump(status))
puts "Status synced: #{old_phase} -> #{new_phase} (next: #{next_agent})"
RUBY
}

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
    # GitHub Copilot CLI (via gh): `suggest -t shell` was removed; use -p for non-interactive prompts.
    gh copilot -p "$PROMPT" --allow-all-tools --silent
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
if [[ -f "$OUTPUT_FILE" ]]; then
  echo "Syncing status.yaml from $AGENT output..."
  sync_status_from_output "$TASK_ID" "$AGENT" "$STATUS_FILE" "$OUTPUT_FILE" "$TODAY"
  echo "Validating runtime files..."
  if ruby "$OFFICE_DIR/validate-yaml.rb" "$TASK_ID"; then
    echo "Validation passed."
  else
    echo "Validation failed. Review the messages above before continuing."
  fi
else
  echo "Output file not found yet; save it first, then run: ruby \"$OFFICE_DIR/validate-yaml.rb\" \"$TASK_ID\""
fi
echo "Validate runtime files with: ruby \"$OFFICE_DIR/validate-yaml.rb\" \"$TASK_ID\""
echo "Then run next agent or use: ./run-agent.sh $TASK_ID auto"
