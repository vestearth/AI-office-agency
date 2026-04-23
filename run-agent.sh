#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$OFFICE_DIR/agents"
RUNS_DIR="$OFFICE_DIR/runs"
DEFAULT_LOOP_LIMIT=5

usage() {
  cat <<EOF
Usage: ./run-agent.sh <TASK_ID> <AGENT> [RUNNER]
       ./run-agent.sh <TASK_ID> scaffold <dev|dev-2|reviewer> [--force]

  TASK_ID   Task identifier (e.g. TASK-003)
  AGENT     Agent role: pm | dev | dev-2 | reviewer | debugger | devops | free-roam
  RUNNER    Optional: copilot (default) | codex | cursor
            For Cursor: use the IDE directly (see ai-dev-office/SKILL.md)

Scaffold mode:
  scaffold  Create a starter <agent>-output.yaml for manual completion.
  --force   Overwrite an existing scaffold target file.

Runner priority: copilot > cursor (IDE) > codex

Examples:
  ./run-agent.sh TASK-011 pm                  # runs with copilot (default)
  ./run-agent.sh TASK-011 dev
  ./run-agent.sh TASK-011 dev codex           # force codex runner
  ./run-agent.sh TASK-011 reviewer copilot    # explicit copilot
  ./run-agent.sh TASK-011 dev cursor          # generate Cursor prompt
  ./run-agent.sh TASK-011 scaffold dev
  ./run-agent.sh TASK-011 scaffold reviewer --force

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
PM_OUTPUT_FILE="$TASK_DIR/pm-output.yaml"
OUTPUT_FILE="$TASK_DIR/${AGENT}-output.yaml"
META_FILE="$TASK_DIR/meta.yaml"
TODAY="$(date +%F)"

scaffold_output_template() {
  local task_id="$1"
  local scaffold_agent="$2"
  local pm_output_file="$3"

  ruby - "$task_id" "$scaffold_agent" "$pm_output_file" <<'RUBY'
require "yaml"
require "date"

task_id, scaffold_agent, pm_output_path = ARGV
pm_output = if File.exist?(pm_output_path)
  YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

task = pm_output["task"].is_a?(Hash) ? pm_output["task"] : {}
title = task["title"].to_s.strip
summary_suffix = title.empty? ? task_id : "#{task_id} — #{title}"

payload =
  case scaffold_agent
  when "dev", "dev-2"
    {
      "summary" => "#{summary_suffix}\n\nDescribe what was implemented and why.",
      "artifacts" => [
        {
          "path" => "path/to/changed-file",
          "action" => "modified"
        }
      ],
      "next_action" => {
        "agent" => "reviewer",
        "reason" => "Implementation is ready for review."
      },
      "blockers" => []
    }
  when "reviewer"
    {
      "summary" => "#{summary_suffix}\n\nRecord the review verdict, key observations, and verification results.",
      "review_verdict" => "approved",
      "build_check" => {
        "compile" => "pass",
        "tests" => "pass",
        "details" => "Document the exact build/test commands and outcomes."
      },
      "artifacts" => [
        {
          "path" => "path/to/reviewed-file",
          "issues" => []
        }
      ],
      "next_action" => {
        "agent" => "done",
        "reason" => "All acceptance criteria are met and validation passed."
      },
      "transition" => {
        "from_phase" => "review",
        "to_phase" => "done"
      },
      "blockers" => []
    }
  else
    warn "Unsupported scaffold agent: #{scaffold_agent}"
    exit 1
  end

puts YAML.dump(payload).sub(/\A---\s*\n/, "")
RUBY
}

write_scaffold_output() {
  local task_id="$1"
  local scaffold_agent="$2"
  local output_file="$3"
  local pm_output_file="$4"
  local force_flag="$5"

  if [[ -f "$output_file" && "$force_flag" != "--force" ]]; then
    echo "Scaffold target already exists: $output_file"
    echo "Re-run with --force to overwrite it."
    exit 1
  fi

  scaffold_output_template "$task_id" "$scaffold_agent" "$pm_output_file" > "$output_file"
  echo "Scaffolded $scaffold_agent output: $output_file"
}

log_meta_event() {
  local task_id="$1"
  local meta_file="$2"
  local event_type="$3"
  local actor="$4"
  local details="$5"
  local timestamp

  timestamp="$(date -u +%FT%TZ)"

  ruby - "$task_id" "$meta_file" "$event_type" "$actor" "$details" "$timestamp" <<'RUBY'
require "yaml"
require "date"

task_id, meta_path, event_type, actor, details, timestamp = ARGV

meta = if File.exist?(meta_path)
  YAML.safe_load(File.read(meta_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

meta["task_id"] ||= task_id
meta["events"] = [] unless meta["events"].is_a?(Array)
meta["events"] << {
  "type" => event_type,
  "agent" => actor,
  "details" => details,
  "timestamp" => timestamp
}
meta["updated_at"] = timestamp

File.write(meta_path, YAML.dump(meta))
RUBY
}

status_value() {
  local status_file="$1"
  local key_path="$2"

  ruby - "$status_file" "$key_path" <<'RUBY'
require "yaml"
require "date"

status_path, key_path = ARGV
exit 0 unless File.exist?(status_path)

data = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
value = key_path.split(".").reduce(data) do |memo, key|
  memo.is_a?(Hash) ? memo[key] : nil
end

case value
when nil
  puts ""
when TrueClass, FalseClass, Numeric
  puts value
else
  puts value.to_s
end
RUBY
}

task_metadata_value() {
  local pm_output_file="$1"
  local key_name="$2"

  ruby - "$pm_output_file" "$key_name" <<'RUBY'
require "yaml"
require "date"

pm_output_path, key_name = ARGV
exit 0 unless File.exist?(pm_output_path)

data = YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
value = data.dig("task", key_name).to_s.strip
puts value unless value.empty?
RUBY
}

task_short_name() {
  local pm_output_file="$1"

  ruby - "$pm_output_file" <<'RUBY'
require "yaml"
require "date"

pm_output_path = ARGV[0]
exit 0 unless File.exist?(pm_output_path)

data = YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
task = data["task"].is_a?(Hash) ? data["task"] : {}
short_name = task["short_name"].to_s.strip

if short_name.empty?
  title = task["title"].to_s.strip
  short_name = title.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/^-+|-+$/, "").gsub(/-+/, "-")
end

puts short_name unless short_name.empty?
RUBY
}

append_prompt_source() {
  local source_path="$1"
  local normalized_sources

  [[ -n "$source_path" ]] || return 0

  normalized_sources=",${PROMPT_SOURCES//, /,},"

  if [[ "$normalized_sources" != *",${source_path},"* ]]; then
    if [[ -n "$PROMPT_SOURCES" ]]; then
      PROMPT_SOURCES="$PROMPT_SOURCES, $source_path"
    else
      PROMPT_SOURCES="$source_path"
    fi
  fi
}

previous_agents_for() {
  case "$1" in
    reviewer)
      echo "dev dev-2 debugger devops free-roam"
      ;;
    debugger)
      echo "reviewer"
      ;;
    devops)
      echo "reviewer free-roam"
      ;;
    dev|dev-2)
      echo "pm debugger free-roam devops"
      ;;
    free-roam)
      echo "reviewer debugger devops pm dev dev-2"
      ;;
    pm)
      echo ""
      ;;
    *)
      echo "pm reviewer debugger devops dev dev-2 free-roam"
      ;;
  esac
}

find_latest_output_for_agents() {
  local status_file="$1"
  shift
  ruby - "$status_file" "$TASK_DIR" "$@" <<'RUBY'
require "yaml"
require "date"

status_path, task_dir, *preferred_agents = ARGV
history = []

if File.exist?(status_path)
  data = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
  history = Array(data["history"])
end

ordered_agents = history.reverse.map { |entry| entry.is_a?(Hash) ? entry["agent"].to_s : nil }.compact
preferred_agents.each do |agent|
  next unless ordered_agents.include?(agent)

  path = File.join(task_dir, "#{agent}-output.yaml")
  if File.exist?(path)
    puts path
    exit 0
  end
end

preferred_agents.each do |agent|
  path = File.join(task_dir, "#{agent}-output.yaml")
  if File.exist?(path)
    puts path
    exit 0
  end
end
RUBY
}

read_output_file() {
  local file_path="$1"
  [[ -f "$file_path" ]] || return 0
  cat "$file_path"
}

effective_iteration() {
  local status_file="$1"

  ruby - "$status_file" <<'RUBY'
require "yaml"
require "date"

status_path = ARGV[0]
exit 0 unless File.exist?(status_path)

data = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
iteration = data["iteration"].to_i
history_size = Array(data["history"]).size
puts [iteration, history_size].max
RUBY
}

resolve_loop_limit() {
  local config_file="$OFFICE_DIR/office.config.yaml"

  ruby - "$config_file" "$DEFAULT_LOOP_LIMIT" <<'RUBY'
require "yaml"
require "date"

config_path, fallback = ARGV
limit = fallback.to_i

if File.exist?(config_path)
  data = YAML.safe_load(File.read(config_path), permitted_classes: [Date, Time], aliases: true) || {}
  configured = data.dig("loop_guard", "max_iterations")
  limit = configured.to_i if configured
end

puts limit
RUBY
}

LOOP_LIMIT="$(resolve_loop_limit)"

sync_status_from_output() {
  local task_id="$1"
  local agent="$2"
  local status_file="$3"
  local output_file="$4"
  local today="$5"

  ruby - "$task_id" "$agent" "$status_file" "$output_file" "$today" <<'RUBY'
require "yaml"
require "time"
require "date"

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

force_status_route() {
  local task_id="$1"
  local status_file="$2"
  local today="$3"
  local next_agent="$4"
  local new_phase="$5"
  local actor_agent="$6"
  local reason="$7"

  ruby - "$task_id" "$status_file" "$today" "$next_agent" "$new_phase" "$actor_agent" "$reason" <<'RUBY'
require "yaml"
require "date"

task_id, status_path, today, next_agent, new_phase, actor_agent, reason = ARGV

status = if File.exist?(status_path)
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

old_phase = status["phase"].to_s.strip
old_phase = "pending" if old_phase.empty?

status["task_id"] ||= task_id
status["phase"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason
}

File.write(status_path, YAML.dump(status))
puts "Status forced: #{old_phase} -> #{new_phase} (next: #{next_agent})"
RUBY
}

if [[ "$AGENT" == "pm" && ! -d "$TASK_DIR" ]]; then
  echo "Creating task directory: $TASK_DIR"
  mkdir -p "$TASK_DIR"
fi

if [[ "$AGENT" == "scaffold" ]]; then
  SCAFFOLD_AGENT="${3:-}"
  FORCE_FLAG="${4:-}"

  if [[ -z "$SCAFFOLD_AGENT" ]]; then
    echo "Error: scaffold requires a target agent: dev | dev-2 | reviewer"
    usage
  fi

  if [[ "$SCAFFOLD_AGENT" != "dev" && "$SCAFFOLD_AGENT" != "dev-2" && "$SCAFFOLD_AGENT" != "reviewer" ]]; then
    echo "Error: unsupported scaffold target '$SCAFFOLD_AGENT'"
    echo "Supported scaffold targets: dev | dev-2 | reviewer"
    exit 1
  fi

  if [[ ! -d "$TASK_DIR" ]]; then
    echo "Error: Task directory not found: $TASK_DIR"
    echo "Run PM first: ./run-agent.sh $TASK_ID pm"
    exit 1
  fi

  OUTPUT_FILE="$TASK_DIR/${SCAFFOLD_AGENT}-output.yaml"
  write_scaffold_output "$TASK_ID" "$SCAFFOLD_AGENT" "$OUTPUT_FILE" "$PM_OUTPUT_FILE" "$FORCE_FLAG"
  exit 0
fi

if [[ "$AGENT" != "pm" && ! -d "$TASK_DIR" ]]; then
  echo "Error: Task directory not found: $TASK_DIR"
  echo "Run PM first: ./run-agent.sh $TASK_ID pm"
  exit 1
fi

TASK_SHORT_NAME="$(task_short_name "$PM_OUTPUT_FILE")"
TASK_TITLE="$(task_metadata_value "$PM_OUTPUT_FILE" "title")"
TASK_EPIC="$(task_metadata_value "$PM_OUTPUT_FILE" "epic")"
TASK_LABEL="$TASK_ID"
if [[ -n "$TASK_SHORT_NAME" ]]; then
  TASK_LABEL="$TASK_ID [$TASK_SHORT_NAME]"
fi
if [[ -n "$TASK_TITLE" ]]; then
  TASK_LABEL="$TASK_LABEL $TASK_TITLE"
fi

CURRENT_ITERATION="$(effective_iteration "$STATUS_FILE")"
CURRENT_PHASE="$(status_value "$STATUS_FILE" "phase")"

if [[ "$AGENT" != "pm" && "$AGENT" != "free-roam" && -f "$STATUS_FILE" && "$CURRENT_ITERATION" =~ ^[0-9]+$ && "$CURRENT_ITERATION" -ge "$LOOP_LIMIT" ]]; then
  LOOP_REASON="Loop guard triggered: exceeded max_iterations (${CURRENT_ITERATION}/${LOOP_LIMIT}) while attempting ${AGENT}."
  echo "Loop guard triggered for $TASK_LABEL at iteration $CURRENT_ITERATION. Routing to free-roam."
  force_status_route "$TASK_ID" "$STATUS_FILE" "$TODAY" "free-roam" "escalated" "$AGENT" "$LOOP_REASON"
  log_meta_event "$TASK_ID" "$META_FILE" "loop_guard" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} phase=${CURRENT_PHASE:-unknown} iteration=$CURRENT_ITERATION limit=$LOOP_LIMIT routed_to=free-roam"
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

# Collect ALL upstream outputs for reviewer and determine the most relevant prior context for other agents.
ALL_DEV_OUTPUTS=""
if [[ "$AGENT" == "reviewer" ]]; then
  for f in "$TASK_DIR"/dev-output.yaml "$TASK_DIR"/dev-2-output.yaml "$TASK_DIR"/debugger-output.yaml "$TASK_DIR"/devops-output.yaml "$TASK_DIR"/free-roam-output.yaml; do
    if [[ -f "$f" ]]; then
      DEV_NAME=$(basename "$f" | sed 's/-output\.yaml//')
      ALL_DEV_OUTPUTS="${ALL_DEV_OUTPUTS}
--- DEV OUTPUT ($DEV_NAME) ---
$(cat "$f")"
    fi
  done
fi

# Find the most relevant upstream output based on workflow role history.
PREV_OUTPUT=""
PREFERRED_PREV_AGENTS="$(previous_agents_for "$AGENT")"
if [[ -n "$PREFERRED_PREV_AGENTS" ]]; then
  # shellcheck disable=SC2086
  PREV_OUTPUT="$(find_latest_output_for_agents "$STATUS_FILE" $PREFERRED_PREV_AGENTS)"
fi

PM_SECTION=""
if [[ "$AGENT" != "pm" && -f "$PM_OUTPUT_FILE" ]]; then
  PM_SECTION="
--- PM OUTPUT ---
$(cat "$PM_OUTPUT_FILE")"
fi

PREV_SECTION=""
if [[ "$AGENT" == "reviewer" && -n "$ALL_DEV_OUTPUTS" ]]; then
  PREV_SECTION="$ALL_DEV_OUTPUTS"
elif [[ -n "$PREV_OUTPUT" && "$PREV_OUTPUT" != "$TASK_DIR/pm-output.yaml" ]]; then
  PREV_AGENT=$(basename "$PREV_OUTPUT" | sed 's/-output\.yaml//')
  PREV_SECTION="
--- PREVIOUS AGENT OUTPUT ($PREV_AGENT) ---
$(read_output_file "$PREV_OUTPUT")"
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

PROMPT_SOURCES=""
append_prompt_source "agents/$AGENT.md"
[[ -f "$TASK_FILE" ]] && append_prompt_source "runs/$TASK_ID/task.md"
[[ -f "$STATUS_FILE" ]] && append_prompt_source "runs/$TASK_ID/status.yaml"
[[ -f "$PM_OUTPUT_FILE" && "$AGENT" != "pm" ]] && append_prompt_source "runs/$TASK_ID/pm-output.yaml"
if [[ "$AGENT" == "reviewer" ]]; then
  for reviewed_output in dev-output.yaml dev-2-output.yaml debugger-output.yaml devops-output.yaml free-roam-output.yaml; do
    [[ -f "$TASK_DIR/$reviewed_output" ]] && append_prompt_source "runs/$TASK_ID/$reviewed_output"
  done
fi
[[ -n "$PREV_OUTPUT" ]] && append_prompt_source "runs/$TASK_ID/$(basename "$PREV_OUTPUT")"

log_meta_event "$TASK_ID" "$META_FILE" "prompt_assembly" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$RUNNER phase=${CURRENT_PHASE:-unknown} iteration=$CURRENT_ITERATION sources=$PROMPT_SOURCES"

echo "=== Running $AGENT for $TASK_LABEL (runner: $RUNNER) ==="

case "$RUNNER" in
  copilot-chat)
    # Save the assembled prompt to a file for interactive use with Copilot Chat in an IDE.
    PROMPT_FILE="$TASK_DIR/.copilot-prompt.md"
    mkdir -p "$TASK_DIR"
    echo "$PROMPT" > "$PROMPT_FILE"
    echo "Prompt saved for Copilot Chat: $PROMPT_FILE"
    echo "Open it in your IDE, select the content and send to Copilot Chat (or paste into the chat input)."
    ;;
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

log_meta_event "$TASK_ID" "$META_FILE" "runner_complete" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$RUNNER output_expected=runs/$TASK_ID/$(basename "$OUTPUT_FILE")"

echo ""
echo "=== $AGENT completed for $TASK_LABEL ==="
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
