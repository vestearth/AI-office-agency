#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")" && pwd)"
# Exported so the ruby heredocs (which run as `ruby -` and have no __dir__) can
# locate scripts/task-ownership.rb for the status fence.
export AI_DEV_OFFICE_HOME="$OFFICE_DIR"
AGENTS_DIR="$OFFICE_DIR/agents"
# Overridable so tests can point at a temp dir instead of the live runs/ —
# matches scripts/record-evidence.sh and scripts/enforce-output-contract.rb.
RUNS_DIR="${AI_OFFICE_RUNS_DIR:-$OFFICE_DIR/runs}"
# Overridable so tests (and alternate setups) can point at a stub wrapper or
# force the PATH `socraticode` binary; defaults to the in-repo TCP wrapper.
SOCRATICODE_WRAPPER="${SOCRATICODE_WRAPPER:-$OFFICE_DIR/scripts/socraticode-tcp-wrapper.sh}"
CONFIG_RESOLVER="$OFFICE_DIR/scripts/resolve-office-config.rb"
GIT_SYNC="$OFFICE_DIR/scripts/office-git-sync.sh"
# Fallback only when no config value is available; keep aligned with portable defaults.
DEFAULT_LOOP_LIMIT=8
OFFICE_PROFILE="${OFFICE_PROFILE:-}"

parse_global_args() {
  REMAINING_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profile)
        OFFICE_PROFILE="${2:-}"
        shift 2
        ;;
      --profile=*)
        OFFICE_PROFILE="${1#--profile=}"
        shift
        ;;
      *)
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

run_agent_invocation() {
  local extra=()
  if [[ -n "${OFFICE_PROFILE:-}" ]]; then
    extra=(--profile "$OFFICE_PROFILE")
  fi
  "$0" ${extra[@]+"${extra[@]}"} "$@"
}

export OFFICE_PROFILE
parse_global_args "$@"
set -- "${REMAINING_ARGS[@]}"

usage() {
  cat <<EOF
Usage: ./run-agent.sh [--profile <name>] <TASK_ID> <AGENT> [RUNNER]
       ./run-agent.sh [--profile <name>] <TASK_ID> scaffold <dev|dev-2|reviewer> [--force]
       ./run-agent.sh [--profile <name>] status [TASK_ID]
       ./run-agent.sh [--profile <name>] intake "<request>"
       ./run-agent.sh [--profile <name>] verify <TASK_ID>
       ./run-agent.sh [--profile <name>] cleanup

  TASK_ID   Task identifier (e.g. TASK-003)
  AGENT     Agent role: pm | dev | dev-2 | reviewer | debugger | devops | free-roam
  RUNNER    Optional: codex (default) | cursor-agent | cursor
            For Cursor: use the IDE directly (see ai-dev-office/SKILL.md)
            For Cursor Agent: runs Cursor in your terminal.

Scaffold mode:
  scaffold  Create a starter <agent>-output.yaml for manual completion.
  --force   Overwrite an existing scaffold target file.

Runner priority: codex > cursor-agent > cursor (IDE)

Examples:
  ./run-agent.sh TASK-011 pm                  # runs with codex (default)
  ./run-agent.sh TASK-011 dev
  ./run-agent.sh TASK-011 dev codex           # force codex runner
  ./run-agent.sh TASK-011 reviewer cursor-agent # run Cursor CLI agent
  ./run-agent.sh TASK-011 dev cursor          # generate Cursor prompt
  ./run-agent.sh TASK-011 scaffold dev
  ./run-agent.sh TASK-011 scaffold reviewer --force

Pipeline shortcut (runs full flow automatically):
  ./run-agent.sh TASK-011 auto

Status:
  ./run-agent.sh status            # summarize all task runs
  ./run-agent.sh status TASK-011   # summarize one task run

Operator helpers:
  ./run-agent.sh intake "Fix wallet callback failure"
  ./run-agent.sh verify TASK-011
  ./run-agent.sh cleanup
EOF
  exit 1
}

show_office_status() {
  local task_filter="${1:-}"

  ruby - "$OFFICE_DIR" "$RUNS_DIR" "$task_filter" <<'RUBY'
require "yaml"
require "date"
require "open3"

office_dir, runs_dir, task_filter = ARGV
validator = File.join(office_dir, "validate-yaml.rb")

def load_yaml(path)
  return {} unless File.exist?(path)

  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError
  {}
end

def list_value(value)
  Array(value).map(&:to_s).map(&:strip).reject(&:empty?)
end

def validation_status(validator, task_id)
  _stdout, _stderr, status = Open3.capture3("ruby", validator, task_id)
  status.success? ? "pass" : "fail"
end

def next_command(task_id, status)
  phase = status["phase"].to_s
  state = status["state"].to_s
  current_agent = status["current_agent"].to_s

  return "done" if current_agent == "done" || phase == "done" || state == "done"
  return "blocked" if phase == "blocked" || state == "blocked"
  return "none" if current_agent.empty?

  "./run-agent.sh #{task_id} #{current_agent}"
end

def task_ids(runs_dir)
  Dir.children(runs_dir)
     .select { |entry| entry.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/) && File.directory?(File.join(runs_dir, entry)) }
     .sort_by { |entry| [entry.include?("PKG") ? 1 : 0, entry[/\d+/].to_i, entry] }
end

if task_filter && !task_filter.empty?
  task_dir = File.join(runs_dir, task_filter)
  unless File.directory?(task_dir)
    warn "Task not found: #{task_filter}"
    exit 1
  end

  status = load_yaml(File.join(task_dir, "status.yaml"))
  phase = status["phase"].to_s.empty? ? "unknown" : status["phase"].to_s
  state = status["state"].to_s.empty? ? phase : status["state"].to_s
  current_agent = status["current_agent"].to_s.empty? ? "unknown" : status["current_agent"].to_s
  ready = status.key?("ready") ? status["ready"].to_s : "unknown"
  iteration = status.key?("iteration") ? status["iteration"].to_s : "unknown"
  blocked_on = list_value(status["blocked_on"])
  waiting_for = list_value(status["waiting_for"])

  puts "Task: #{task_filter}"
  puts "Phase: #{phase}"
  puts "State: #{state}"
  puts "Current agent: #{current_agent}"
  puts "Ready: #{ready}"
  puts "Iteration: #{iteration}"
  puts "Blocked on: #{blocked_on.empty? ? 'none' : blocked_on.join(', ')}"
  puts "Waiting for: #{waiting_for.empty? ? 'none' : waiting_for.join(', ')}"
  puts "Validation: #{validation_status(validator, task_filter)}"
  puts "Next: #{next_command(task_filter, status)}"
  # N5: show the most recent transitions so `status` answers "why", not just "where".
  recent = Array(status["history"]).select { |h| h.is_a?(Hash) }.last(3)
  unless recent.empty?
    puts "Recent:"
    recent.each do |h|
      stamp = h["at"].to_s.empty? ? "" : " @#{h['at']}"
      puts "  #{h['phase']} [#{h['agent']}]#{stamp}: #{h['reason']}"
    end
  end
  exit 0
end

ids = task_ids(runs_dir)
if ids.empty?
  puts "No task runs found in #{runs_dir}"
  exit 0
end

puts "AI Dev Office status"
ids.each do |task_id|
  status = load_yaml(File.join(runs_dir, task_id, "status.yaml"))
  phase = status["phase"].to_s.empty? ? "unknown" : status["phase"].to_s
  current_agent = status["current_agent"].to_s.empty? ? "unknown" : status["current_agent"].to_s
  ready = status.key?("ready") ? status["ready"].to_s : "unknown"
  iteration = status.key?("iteration") ? status["iteration"].to_s : "unknown"
  blocked_on = list_value(status["blocked_on"])
  validation = validation_status(validator, task_id)
  parts = [
    task_id,
    "phase=#{phase}",
    "agent=#{current_agent}",
    "ready=#{ready}",
    "iteration=#{iteration}",
    "validation=#{validation}",
    "next=#{next_command(task_id, status)}"
  ]
  parts << "blocked_on=#{blocked_on.join(',')}" unless blocked_on.empty?
  puts parts.join(" | ")
end
RUBY
}

if [[ "${1:-}" == "status" ]]; then
  show_office_status "${2:-}"
  exit $?
fi

show_intake_preview() {
  local request="$1"
  # Multi-user git mode: each user allocates ids in their own TASK-<PREFIX>-NNN
  # namespace so concurrent intakes on different machines never collide.
  # Prefix comes from OFFICE_TASK_PREFIX or office.task_prefix in
  # office.config.local.yaml; empty prefix keeps the legacy shared TASK-NNN pool.
  local task_prefix="${OFFICE_TASK_PREFIX:-}"
  if [[ -z "$task_prefix" ]]; then
    # Let the resolver's own '[ERROR] invalid YAML in ...' through and fail
    # closed: swallowing it would mis-report a broken config as "no prefix set"
    # and send the user to fix the very file they just edited.
    if ! task_prefix="$(ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" office.task_prefix "")"; then
      echo "[ERROR] could not read office config (see message above); fix it before intake" >&2
      return 1
    fi
  fi

  ruby - "$RUNS_DIR" "$OFFICE_DIR/tasks" "$request" "$task_prefix" "$OFFICE_DIR/office.team.yaml" <<'RUBY'
# encoding: utf-8
require "yaml"

runs_dir, tasks_dir, request, raw_prefix, registry_path = ARGV

prefix = raw_prefix.to_s.strip.upcase
unless prefix.empty? || prefix.match?(/\A[A-Z][A-Z0-9]*\z/)
  warn "[ERROR] task prefix #{raw_prefix.inspect} must be letters/digits starting with a letter (e.g. EA, BOB)"
  exit 1
end
if prefix == "PKG"
  warn "[ERROR] task prefix PKG is reserved for package tasks - pick a personal prefix"
  exit 1
end

# Team prefix registry (office.team.yaml, committed). Once anyone registers,
# intake requires a registered prefix - this is what turns prefix uniqueness
# from a team agreement into an enforced rule. Parsing fails CLOSED: an
# unparseable or mis-shaped registry (a git conflict in this exact file is the
# feature's own collision event) must halt intake, never silently revert to the
# raced TASK-NNN pool the registry exists to close. Genuinely empty states
# (file absent, comments-only, `prefixes:` absent/empty) stay solo/legacy.
registry = {}
if registry_path && File.exist?(registry_path)
  begin
    data = YAML.safe_load(File.read(registry_path))
  rescue StandardError => e
    warn "[ERROR] office.team.yaml exists but cannot be parsed (#{e.class}: #{e.message.lines.first&.strip})"
    warn "  fix it (unresolved git conflict markers? a tab in the indentation?) before intake -"
    warn "  refusing to silently disable prefix enforcement."
    exit 1
  end
  unless data.nil?
    unless data.is_a?(Hash)
      warn "[ERROR] office.team.yaml must be a map with a 'prefixes:' entry (got #{data.class})"
      exit 1
    end
    raw = data["prefixes"]
    unless raw.nil?
      unless raw.is_a?(Hash)
        warn "[ERROR] office.team.yaml 'prefixes:' must be a map of PREFIX: Name (got #{raw.class})"
        exit 1
      end
      registry = raw.each_with_object({}) { |(k, v), h| h[k.to_s.strip.upcase] = v.to_s }
    end
  end
end

prefix_owner = registry[prefix]
if registry.any?
  if prefix.empty?
    warn "[ERROR] the team prefix registry is active (office.team.yaml) - unprefixed TASK-NNN intake races across machines."
    warn "  Set your prefix first (office.config.local.yaml):"
    warn "    office:"
    warn "      task_prefix: <PREFIX>"
    warn "  or enter your name in the dashboard - it registers and configures one for you."
    exit 1
  end
  unless prefix_owner
    warn "[ERROR] prefix #{prefix} is not registered in office.team.yaml - claim it first:"
    warn "  add this line under prefixes:, then commit and push:"
    warn "    #{prefix}: <Your Name>"
    exit 1
  end
end

id_stem = prefix.empty? ? "TASK" : "TASK-#{prefix}"
id_pattern = /\A#{Regexp.escape(id_stem)}-(\d+)\z/

def task_ids_from(path, id_pattern)
  return [] unless Dir.exist?(path)

  Dir.children(path).map { |entry| entry[id_pattern, 1] }.compact.map(&:to_i)
end

def slug(text)
  value = text.downcase.gsub(/[^a-z0-9]+/, "-").gsub(/^-+|-+$/, "").gsub(/-+/, "-")
  value.empty? ? "new-task" : value.split("-").first(5).join("-")
end

lower = request.downcase
max_id = (task_ids_from(runs_dir, id_pattern) + task_ids_from(tasks_dir, id_pattern)).max || 0
next_task_id = format("%s-%03d", id_stem, max_id + 1)

type =
  if lower.match?(/\b(bug|fix|fail|failure|error|broken|outage|crash)\b/)
    "bugfix"
  elsif lower.match?(/\b(docker|ci|deploy|pipeline|infra|environment)\b/)
    "devops"
  elsif lower.match?(/\b(refactor|cleanup|rename)\b/)
    "refactor"
  elsif lower.match?(/\b(investigate|research|diagnose|unknown)\b/)
    "investigation"
  else
    "feature"
  end

priority =
  if lower.match?(/\b(critical|outage|security|data loss|production down|p0)\b/)
    "critical"
  elsif lower.match?(/\b(blocked|blocking|fail|failure|urgent|p1)\b/)
    "high"
  else
    "medium"
  end

known_services = %w[
  Games-Labs-Auth Games-Labs-Game Games-Labs-Logs Games-Labs-Missions
  Games-Labs-Order Games-Labs-Provider Games-Labs-User Games-Labs-Wallet
  api-gateway shared-lib
]
services = known_services.select { |service| lower.include?(service.downcase) }

unknowns = []
unknowns << "acceptance criteria" unless lower.match?(/\b(should|must|when|then|acceptance|expected)\b/)
unknowns << "affected files" unless lower.match?(/\b(\.go|\.proto|dockerfile|workflow|yaml|yml|readme|docs?)\b/)
unknowns << "target service" if services.empty?

puts "Intake preview"
puts "Task ID: #{next_task_id}"
puts "Prefix owner: #{prefix_owner}" if prefix_owner && !prefix_owner.empty?
puts "Short name: #{slug(request)}"
puts "Type: #{type}"
puts "Priority: #{priority}"
puts "Services: #{services.empty? ? 'unknown' : services.join(', ')}"
puts "Known scope: #{request}"
puts "Unknowns: #{unknowns.empty? ? 'none' : unknowns.join(', ')}"
puts "Question: #{unknowns.empty? ? 'none' : "Please clarify #{unknowns.first}."}"
puts "Next: ./run-agent.sh #{next_task_id} pm"
RUBY
}

show_verify_plan() {
  local task_id="$1"

  ruby - "$OFFICE_DIR" "$RUNS_DIR" "$task_id" <<'RUBY'
require "yaml"
require "date"

office_dir, runs_dir, task_id = ARGV
task_dir = File.join(runs_dir, task_id)

unless File.directory?(task_dir)
  warn "Task not found: #{task_id}"
  exit 1
end

def load_yaml(path)
  return {} unless File.exist?(path)

  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError
  {}
end

def artifact_paths(data)
  Array(data["artifacts"]).map do |artifact|
    artifact.is_a?(Hash) ? artifact["path"].to_s : nil
  end.compact.reject(&:empty?)
end

texts = []
%w[task.md pm-output.yaml dev-output.yaml dev-2-output.yaml debugger-output.yaml devops-output.yaml free-roam-output.yaml reviewer-output.yaml].each do |name|
  path = File.join(task_dir, name)
  texts << File.read(path) if File.exist?(path)
end
combined = texts.join("\n")

paths = []
%w[pm-output.yaml dev-output.yaml dev-2-output.yaml debugger-output.yaml devops-output.yaml free-roam-output.yaml reviewer-output.yaml].each do |name|
  data = load_yaml(File.join(task_dir, name))
  paths.concat(artifact_paths(data))
  scope_files = data.dig("scope", "affected_files")
  paths.concat(Array(scope_files).map { |entry| entry.is_a?(Hash) ? entry["path"].to_s : nil }.compact)
end
paths = paths.uniq

commands = []
commands << "ruby validate-yaml.rb #{task_id}"

services = paths.map { |path| path.split("/").first if path.start_with?("Games-Labs-") || path.start_with?("api-gateway") }.compact.uniq
services.each do |service|
  commands << "go test ./#{service}/..." if service.start_with?("Games-Labs-") || service == "api-gateway"
end

if paths.any? { |path| path.end_with?(".proto") } || combined.downcase.include?("proto")
  commands << "make proto"
end

if paths.any? { |path| path.downcase.include?("dockerfile") || path.start_with?(".github/") || path.end_with?("go.mod") } ||
   combined.downcase.match?(/\b(ci|docker|shared-lib|dependency)\b/)
  commands << "scripts/check-service-dependencies.sh"
end

if commands.length == 1 && combined.downcase.match?(/\b(readme|docs|documentation)\b/)
  commands << "ruby validate-yaml.rb #{task_id}"
end

puts "Verification plan: #{task_id}"
puts "Artifacts: #{paths.empty? ? 'none listed' : paths.join(', ')}"
puts "Commands:"
commands.uniq.each { |command| puts "  - #{command}" }
RUBY
}

show_cleanup_report() {
  ruby - "$OFFICE_DIR" "$RUNS_DIR" <<'RUBY'
require "yaml"
require "date"
require "open3"

office_dir, runs_dir = ARGV
validator = File.join(office_dir, "validate-yaml.rb")

def load_yaml(path)
  return {} unless File.exist?(path)

  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError
  {}
end

def validation_pass?(validator, task_id)
  _stdout, _stderr, status = Open3.capture3("ruby", validator, task_id)
  status.success?
end

def expected_agents_for_phase(phase)
  # S9: every PHASES enum value must appear here. An unmapped phase returns nil
  # (surfaced as unmapped_phase) so a new phase can't silently bypass the check.
  {
    "pending" => %w[pm],
    "assigned" => %w[dev dev-2],
    "assigned_parallel" => %w[dev dev-2],
    "review" => %w[reviewer],
    "in_review" => %w[reviewer],
    "debugging" => %w[debugger],
    "debugging_complete" => %w[dev dev-2],
    "devops_needed" => %w[devops],
    "devops_complete" => %w[dev dev-2 reviewer],
    "escalated" => %w[free-roam],
    "free_roam_complete" => %w[dev dev-2 reviewer],
    "validation_failed" => %w[free-roam],
    "blocked" => %w[pm dev dev-2 reviewer debugger devops free-roam],
    "done" => %w[done],
    "aborted" => %w[done]
  }[phase]
end

ids = Dir.children(runs_dir)
         .select { |entry| entry.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/) && File.directory?(File.join(runs_dir, entry)) }
         .sort_by { |entry| [entry.include?("PKG") ? 1 : 0, entry[/\d+/].to_i, entry] }

puts "Office cleanup report"
issues = 0

ids.each do |task_id|
  task_dir = File.join(runs_dir, task_id)
  status = load_yaml(File.join(task_dir, "status.yaml"))
  phase = status["phase"].to_s
  current_agent = status["current_agent"].to_s

  unless validation_pass?(validator, task_id)
    puts "#{task_id} validation=fail"
    issues += 1
  end

  unless phase.empty?
    expected = expected_agents_for_phase(phase)
    if expected.nil?
      puts "#{task_id} unmapped_phase=#{phase} (no route-mismatch check; add it to expected_agents_for_phase)"
      issues += 1
    elsif !expected.empty? && !current_agent.empty? && !expected.include?(current_agent)
      puts "#{task_id} route_mismatch phase=#{phase} current_agent=#{current_agent} expected=#{expected.join(',')}"
      issues += 1
    end
  end

  next unless phase == "blocked"

  Array(status["blocked_on"]).map(&:to_s).reject(&:empty?).each do |dep_id|
    dep_path = File.join(runs_dir, dep_id, "status.yaml")
    unless File.exist?(dep_path)
      puts "#{task_id} blocked_dependency_missing=#{dep_id}"
      issues += 1
      next
    end

    dep_status = load_yaml(dep_path)
    dep_phase = dep_status["phase"].to_s
    if dep_phase == "done"
      puts "#{task_id} blocked_dependency_done=#{dep_id}"
      issues += 1
    end
  end
end

puts "No cleanup issues found." if issues.zero?
RUBY
}

if [[ "${1:-}" == "intake" ]]; then
  [[ $# -ge 2 ]] || usage
  # Multi-user git mode: see the latest team state (allocated ids, prefix
  # registry) before previewing a new task id. No-op unless git_sync is on.
  bash "$GIT_SYNC" pull || true
  show_intake_preview "$2"
  exit $?
fi

if [[ "${1:-}" == "verify" ]]; then
  [[ $# -ge 2 ]] || usage
  show_verify_plan "$2"
  exit $?
fi

if [[ "${1:-}" == "cleanup" ]]; then
  show_cleanup_report
  exit $?
fi

[[ $# -lt 2 ]] && usage

TASK_ID="$1"
AGENT="$2"
RUNNER="${3:-codex}"

TASK_DIR="$RUNS_DIR/$TASK_ID"
AGENT_FILE="$AGENTS_DIR/$AGENT.md"
TASK_FILE="$TASK_DIR/task.md"
STATUS_FILE="$TASK_DIR/status.yaml"
PM_OUTPUT_FILE="$TASK_DIR/pm-output.yaml"
OUTPUT_FILE="$TASK_DIR/${AGENT}-output.yaml"
META_FILE="$TASK_DIR/meta.yaml"
TODAY="$(date +%F)"

# Multi-user git mode (opt-in via git_sync.enabled — both hooks are no-ops
# otherwise). Pull team state once per pipeline: the auto runner re-invokes
# this script per step, so sub-invocations skip the redundant pull via the
# exported marker. The EXIT trap publishes this run's state on every exit
# path (step done, validation_failed, loop guard, human-decision terminal),
# except parallel lanes — the parent's next step publishes all lane outputs
# at once, avoiding same-repo commit races.
if [[ "$AGENT" != "scaffold" && "${AI_DEV_OFFICE_GIT_SYNCED:-}" != "1" ]]; then
  bash "$GIT_SYNC" pull || true
  export AI_DEV_OFFICE_GIT_SYNCED=1
fi

office_git_sync_publish() {
  [[ "$AGENT" == "scaffold" ]] && return 0
  [[ "${AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS:-false}" == "true" ]] && return 0
  bash "$GIT_SYNC" push "$TASK_ID" "$TASK_ID: $AGENT step (office auto-sync)" || true
}
# F5: a SIGTERM'd or crashed dispatch must not wedge the task for the whole
# lease. Ownership release goes in the SAME exit handler (a second `trap ... EXIT`
# would replace this one, not add to it), and runs before the git publish so the
# released record is what gets synced. INT/TERM are trapped explicitly because
# bash does not run an EXIT trap for an un-trapped fatal signal.
office_exit_handler() {
  local rc=$?
  # Guarded: the trap is installed before the ownership helpers are defined, so
  # an early exit (usage error) would otherwise hit an undefined function.
  if declare -f ownership_release >/dev/null 2>&1; then
    ownership_release "process exit (rc=$rc)"
  fi
  office_git_sync_publish
  return "$rc"
}
trap office_exit_handler EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

scaffold_output_template() {
  local task_id="$1"
  local scaffold_agent="$2"
  local pm_output_file="$3"
  local reviewer_queue_phase="${4:-in_review}"

  ruby - "$task_id" "$scaffold_agent" "$pm_output_file" "$reviewer_queue_phase" <<'RUBY'
# encoding: utf-8
# This template embeds an em-dash literal (summary_suffix below); the magic
# comment keeps it parseable under a US-ASCII default external encoding.
require "yaml"
require "date"

task_id, scaffold_agent, pm_output_path, reviewer_queue_phase = ARGV
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
      "context_sources" => {
        "github" => {
          "branch" => "",
          "pr" => ""
        },
        "socraticode" => {
          "status" => "skipped",
          "queries" => [],
          "relevant_symbols" => [],
          "notes" => "Scaffolded output; replace with concise context-provider usage."
        }
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
      "context_sources" => {
        "github" => {
          "branch" => "",
          "pr" => ""
        },
        "socraticode" => {
          "status" => "skipped",
          "queries" => [],
          "relevant_symbols" => [],
          "notes" => "Scaffolded output; replace with concise context-provider usage."
        }
      },
      "transition" => {
        "from_phase" => reviewer_queue_phase,
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

  scaffold_output_template "$task_id" "$scaffold_agent" "$pm_output_file" "$REVIEWER_QUEUE_PHASE" > "$output_file"
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

# M1: serialize concurrent writers (parallel dev lanes) on one per-task lock.
# flock is advisory but released automatically when this short-lived process exits.
__lock = File.open(File.join(File.dirname(meta_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

meta = if File.exist?(meta_path)
  YAML.safe_load(File.read(meta_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

meta["task_id"] ||= task_id
meta["events"] = [] unless meta["events"].is_a?(Array)
event = {
  "type" => event_type,
  "agent" => actor,
  "details" => details,
  "timestamp" => timestamp
}
# Run attribution as a structured field, so consumers never parse `details`.
# Empty outside a dispatch (e.g. status-only invocations) — then simply absent.
run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
event["run_id"] = run_id unless run_id.empty?
meta["events"] << event
meta["updated_at"] = timestamp

tmp_path = "#{meta_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(meta))
  File.rename(tmp_path, meta_path)
rescue => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end
RUBY
}

# Run identity (docs/run-records.md). The record store lives in
# runs/<task>/run-records/; scripts/record-run.rb owns the writing (and the
# task lock). Observability must never break a run, so both wrappers swallow
# helper failures: a lost record is a lost metric, not a lost dispatch.
record_run_start() {
  local run_id
  run_id="$(printf '%s' "$PROMPT" | ruby "$OFFICE_DIR/scripts/record-run.rb" start "$TASK_DIR" "$TASK_ID" "$AGENT" \
    "client=$RUNNER" \
    "harness_version=$(config_value "office.version" "")" \
    "repo_sha=$(git rev-parse HEAD 2>/dev/null || true)" \
    "model_requested=${AI_DEV_OFFICE_MODEL:-}" \
    "model_observed=${AI_DEV_OFFICE_MODEL_OBSERVED:-}" \
    "skill_version=${AI_DEV_OFFICE_SKILL_VERSION:-}" \
    "mcp_profile=${AI_DEV_OFFICE_MCP_PROFILE:-}" 2>/dev/null)" || run_id=""
  export AI_DEV_OFFICE_RUN_ID="$run_id"
}

record_run_update() {  # <update|finish> [k=v ...]
  [[ -n "${AI_DEV_OFFICE_RUN_ID:-}" ]] || return 0
  local command="$1"
  shift
  ruby "$OFFICE_DIR/scripts/record-run.rb" "$command" "$TASK_DIR" "$AI_DEV_OFFICE_RUN_ID" "$@" >/dev/null 2>&1 || true
}

# Task ownership / execution leases (docs/task-ownership.md). Unlike the run
# record, ownership is NOT best-effort: a refusal (exit 9) means another live
# run owns this task, and continuing would be exactly the lost update the
# fence exists to prevent — so acquire aborts the dispatch. Release is
# best-effort: it runs from the exit handler for every catchable end, and an
# uncatchable one (kill -9, OOM) is covered by the lease lapsing instead — the
# renewer stops as soon as its driver is gone.
# The parallel dev/dev-2 lanes are a DELIBERATE concurrent execution of ONE
# task: they already set AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS so that neither
# lane writes status (the parent auto runner routes once both finish), so they
# are sub-executions of one dispatch, not competing owners. Taking the lease
# would have lane 2 refuse lane 1 (auto-parallel.sh fails at scenario 1).
#
# The exemption is narrow on purpose. An env var is forgeable, so every
# condition of the real lane must hold: the parallel marker AND the
# skip-status marker AND an agent that is actually a parallel dev lane. Setting
# AI_DEV_OFFICE_PARALLEL_AUTO=true alone no longer buys a free pass, and a lane
# is still fenced on every write it might attempt.
# The in-process fence reads only the environment (it runs inside the task lock
# and cannot afford a config subprocess), so `ownership.enabled: false` has to
# be TRANSLATED into the env kill switch. Without this the flag half-disables:
# acquisition stops but the fence stays armed, which is the worst of both — no
# mutual exclusion, yet stale registers still refuse writes.
#
# Called BEFORE the pre-dispatch writers (the dependency unblocker, the human
# decision reconciler), which are fenced too — translating it at acquire time
# would leave those armed in a disabled office.
ownership_apply_config_switch() {
  [[ -z "${AI_DEV_OFFICE_OWNERSHIP:-}" ]] || return 0
  if [[ "$(ruby "$OFFICE_DIR/scripts/task-ownership.rb" config "$TASK_DIR" 2>/dev/null \
        | sed -n 's/^enabled=//p')" == "false" ]]; then
    export AI_DEV_OFFICE_OWNERSHIP="off"
  fi
}

ownership_parallel_lane() {  # <agent>
  [[ "${AI_DEV_OFFICE_PARALLEL_AUTO:-false}" == "true" ]] || return 1
  [[ "${AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS:-false}" == "true" ]] || return 1
  case "$1" in
    dev|dev-2) return 0 ;;
    *) return 1 ;;
  esac
}

ownership_acquire() {  # <agent>
  # Ownership is keyed to the run id; without one (auto/scaffold lanes, or a
  # run record that could not be written) there is nothing to key it to. Those
  # writers are still fenced — a writer with no epoch can never overwrite a
  # task whose lease is live.
  [[ -n "${AI_DEV_OFFICE_RUN_ID:-}" ]] || return 0
  ownership_parallel_lane "$1" && return 0
  if [[ "${AI_DEV_OFFICE_OWNERSHIP:-}" == "off" ]]; then
    echo "ownership disabled by config: no lease taken, fence passing through"
    return 0
  fi
  local line
  line="$(ruby "$OFFICE_DIR/scripts/task-ownership.rb" acquire "$TASK_DIR" "$TASK_ID" \
    "agent=$1" "reason=dispatch $1")" || exit $?
  echo "$line"
  # The epoch we were granted is the fencing token every later status write in
  # this dispatch (and in the helpers it spawns) is checked against.
  export AI_DEV_OFFICE_OWNERSHIP_EPOCH="$(printf '%s' "$line" | sed -n 's/.*epoch=\([0-9][0-9]*\).*/\1/p')"
  ownership_start_renewer
}

# F6: renew in the BACKGROUND, not on status writes. The only in-dispatch write
# is the one at the very end, so a fence-time self-renew leaves a long run with
# zero renewals for its whole life — reclaimable the moment it passes
# lease_seconds, and then fenced out of its own completed work. A background
# renewer instead keeps the lease fresh for as long as the dispatch is alive,
# which is precisely the signal a lease is supposed to carry. It stops on the
# first refusal: once the lease is lost, re-taking it silently is the bug.
ownership_start_renewer() {
  [[ -n "${AI_DEV_OFFICE_OWNERSHIP_EPOCH:-}" ]] || return 0
  local interval
  interval="$(ruby "$OFFICE_DIR/scripts/task-ownership.rb" config "$TASK_DIR" 2>/dev/null \
    | sed -n 's/^renew_interval_seconds=//p')"
  [[ "$interval" =~ ^[0-9]+$ ]] || return 0
  # $$ stays the driver's pid inside the subshell below, so capture it here and
  # let the renewer watch it. Without that watch the renewer OUTLIVES a SIGKILL
  # or an OOM of the driver and keeps renewing a lease nobody holds — turning
  # the bounded wedge a dead dispatch used to leave (lapses after
  # lease_seconds, task self-heals) into an unbounded one needing a forced
  # release. The exit handler cannot help: kill -9 never reaches it.
  local driver_pid=$$
  (
    # A bash subshell INHERITS the EXIT trap, so without clearing it the renewer
    # would run office_exit_handler when it is killed — releasing the very lease
    # it exists to keep alive, and firing a git publish.
    trap - EXIT TERM INT
    while sleep "$interval"; do
      # Renew only on behalf of a driver that is still alive. Exiting without a
      # release is deliberate: the lease then lapses on its own schedule, which
      # is exactly the self-healing an uncatchably-killed dispatch needs.
      kill -0 "$driver_pid" 2>/dev/null || break
      ruby "$OFFICE_DIR/scripts/task-ownership.rb" renew "$TASK_DIR" >/dev/null 2>&1 || break
    done
  ) &
  OWNERSHIP_RENEWER_PID=$!
}

ownership_stop_renewer() {
  [[ -n "${OWNERSHIP_RENEWER_PID:-}" ]] || return 0
  kill "$OWNERSHIP_RENEWER_PID" 2>/dev/null || true
  wait "$OWNERSHIP_RENEWER_PID" 2>/dev/null || true
  OWNERSHIP_RENEWER_PID=""
}

ownership_release() {  # <reason>
  ownership_stop_renewer
  [[ -n "${AI_DEV_OFFICE_RUN_ID:-}" ]] || return 0
  [[ -n "${AI_DEV_OFFICE_OWNERSHIP_EPOCH:-}" ]] || return 0
  ruby "$OFFICE_DIR/scripts/task-ownership.rb" release "$TASK_DIR" "reason=$1" >/dev/null 2>&1 || true
  # UNSET, never blanked: the fence treats a set-but-empty epoch as tampering.
  unset AI_DEV_OFFICE_OWNERSHIP_EPOCH
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

status_list_values() {
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

if value.is_a?(Array)
  puts value.map(&:to_s).reject(&:empty?).join(",")
elsif !value.nil?
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
puts data["iteration"].to_i
RUBY
}

# M3: completed free-roam passes (non-resettable) — drives the free-roam halt.
effective_free_roam_entries() {
  local status_file="$1"

  ruby - "$status_file" <<'RUBY'
require "yaml"
require "date"

status_path = ARGV[0]
exit 0 unless File.exist?(status_path)

data = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
puts data["free_roam_entries"].to_i
RUBY
}

resolve_loop_limit() {
  ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" loop_guard.max_iterations "$DEFAULT_LOOP_LIMIT"
}

resolve_free_roam_loop_limit() {
  local configured
  configured="$(ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" loop_guard.free_roam_max_iterations "" 2>/dev/null || true)"
  if [[ "$configured" =~ ^[0-9]+$ && "$configured" -gt 0 ]]; then
    echo "$configured"
  else
    # M3: now counts COMPLETED free-roam passes (not work iterations). Free-roam
    # is the last resort before a hard halt — keep the cap small.
    echo 3
  fi
}

LOOP_LIMIT="$(resolve_loop_limit)"
FREE_ROAM_LOOP_LIMIT="$(resolve_free_roam_loop_limit)"
# M4: how many times a task may hit validation_failed before a hard halt.
VALIDATION_FAILED_RETRY_LIMIT="$(ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" loop_guard.validation_failed_retry_limit 3 2>/dev/null || echo 3)"
[[ "$VALIDATION_FAILED_RETRY_LIMIT" =~ ^[0-9]+$ && "$VALIDATION_FAILED_RETRY_LIMIT" -gt 0 ]] || VALIDATION_FAILED_RETRY_LIMIT=3

config_value() {
  local key_path="$1"
  local fallback="${2:-}"
  ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" "$key_path" "$fallback"
}

config_list_values() {
  local key_path="$1"
  local fallback="${2:-}"
  ruby "$CONFIG_RESOLVER" list "$OFFICE_DIR" "$key_path" "$fallback"
}

config_bool() {
  local key_path="$1"
  local fallback="${2:-false}"
  local value
  value="$(config_value "$key_path" "$fallback")"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    true|1|yes|on) echo "true" ;;
    *) echo "false" ;;
  esac
}

runner_priority_values() {
  config_list_values "runner_selector.priority" "codex cursor-agent cursor"
}

runner_trigger_patterns() {
  config_list_values "runner_selector.trigger_patterns" "insufficient_quota,quota exceeded,rate limit,unauthorized,invalid api key,token expired"
}

runner_retry_before_switch() {
  local configured
  configured="$(config_value "runner_selector.retry_before_switch" "2")"
  if [[ "$configured" =~ ^[0-9]+$ ]]; then
    echo "$configured"
  else
    echo "2"
  fi
}

next_runner_after() {
  local current="$1"
  local found="false"
  local runner

  while IFS= read -r runner; do
    [[ -n "$runner" ]] || continue
    if [[ "$found" == "true" ]]; then
      echo "$runner"
      return 0
    fi
    [[ "$runner" == "$current" ]] && found="true"
  done < <(runner_priority_values)

  case "$current" in
    codex) echo "cursor-agent" ;;
    cursor-agent) echo "cursor" ;;
    *) return 1 ;;
  esac
}

runner_failure_pattern() {
  local log_file="$1"
  local pattern

  while IFS= read -r pattern; do
    [[ -n "$pattern" ]] || continue
    if grep -Fqi -- "$pattern" "$log_file"; then
      echo "$pattern"
      return 0
    fi
  done < <(runner_trigger_patterns)

  return 1
}

# A reviewer verdict is a state-machine input, not a durable transcript of every
# review pass. Keep an older verdict for diagnosis, but never leave it at the
# canonical path where a later reviewer dispatch can accidentally re-submit it.
archive_reviewer_output_for_attempt() {
  [[ "$AGENT" == "reviewer" && -f "$OUTPUT_FILE" ]] || return 0

  local attempt="${REVIEWER_OUTPUT_ATTEMPT:-0}"
  local stamp
  local archive
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  archive="$TASK_DIR/reviewer-output.superseded-${stamp}-$$-${attempt}.yaml"

  mv "$OUTPUT_FILE" "$archive"
  echo "Archived previous reviewer output: $archive"
  log_meta_event "$TASK_ID" "$META_FILE" "reviewer_output_archived" "$AGENT" "task=$TASK_LABEL previous=runs/$TASK_ID/reviewer-output.yaml archive=runs/$TASK_ID/$(basename "$archive") attempt=$attempt"
}

run_runner_once() {
  local runner="$1"
  local output_log="$2"

  case "$runner" in
    codex)
      codex --ask-for-approval never exec --skip-git-repo-check "$PROMPT" >"$output_log" 2>&1
      ;;
    cursor)
      {
        echo "Cursor is an interactive IDE runner."
        echo "Paste the following into Cursor chat or reference @ai-dev-office/agents/$AGENT.md"
        echo ""
        echo "--- Prompt (saved to $TASK_DIR/.cursor-prompt.md) ---"
        echo "$PROMPT" > "$TASK_DIR/.cursor-prompt.md"
        echo "Prompt saved. Open it in Cursor and run."
      } >"$output_log" 2>&1
      ;;
    cursor-agent)
      {
        echo "Launching Cursor CLI Agent..."
        cursor agent -p "$PROMPT"
      } >"$output_log" 2>&1
      ;;
    *)
      echo "Error: Unknown runner '$runner'. Use: codex | cursor-agent | cursor" >"$output_log"
      return 64
      ;;
  esac
}

# N2: a runner crash used to leave only a dangling prompt_assembly event and the
# transcript was rm'd. Persist the transcript and record the failure.
log_runner_failure() {  # <runner> <exit_code> <output_log> <classification>
  local saved="$TASK_DIR/$AGENT-runner.log"
  cp -f "$3" "$saved" 2>/dev/null || true
  log_meta_event "$TASK_ID" "$META_FILE" "runner_failed" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$1 exit_code=$2 classification=$4 phase=${CURRENT_PHASE:-unknown} iteration=${CURRENT_ITERATION:-unknown} log=runs/$TASK_ID/$(basename "$saved")"
}

run_runner_with_fallback() {
  local current_runner="$1"
  local auto_switch
  local retry_limit
  local retry_count=0
  local output_log
  local status
  local matched_pattern
  local next_runner

  auto_switch="$(config_bool "runner_selector.auto_switch" "true")"
  retry_limit="$(runner_retry_before_switch)"

  while true; do
    REVIEWER_OUTPUT_ATTEMPT=$(( ${REVIEWER_OUTPUT_ATTEMPT:-0} + 1 ))
    archive_reviewer_output_for_attempt
    output_log="$(mktemp)"
    # $RUNNER is only assigned on success, so the failure path would otherwise
    # attribute a fallback runner's exit code to the runner we started with.
    RUNNER_LAST_ATTEMPTED="$current_runner"

    status=0
    run_runner_once "$current_runner" "$output_log" || status=$?

    if [[ "$status" -eq 0 ]]; then
      cat "$output_log"
      rm -f "$output_log"
      RUNNER="$current_runner"
      if [[ "$current_runner" == "cursor" ]]; then
        INTERACTIVE_RUNNER="true"
      else
        INTERACTIVE_RUNNER="false"
      fi
      return 0
    fi

    cat "$output_log"

    if [[ "$auto_switch" != "true" ]] || ! matched_pattern="$(runner_failure_pattern "$output_log")"; then
      log_runner_failure "$current_runner" "$status" "$output_log" "non-switchable"
      rm -f "$output_log"
      return "$status"
    fi

    if [[ "$retry_count" -lt "$retry_limit" ]]; then
      retry_count=$((retry_count + 1))
      echo "Runner '$current_runner' failed with switchable pattern '$matched_pattern'; retrying ($retry_count/$retry_limit)."
      log_meta_event "$TASK_ID" "$META_FILE" "runner_retry" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$current_runner attempt=$retry_count/$retry_limit matched_pattern=$matched_pattern"
      rm -f "$output_log"
      continue
    fi

    next_runner="$(next_runner_after "$current_runner" || true)"
    if [[ -z "$next_runner" ]]; then
      echo "Runner '$current_runner' failed with switchable pattern '$matched_pattern', but no fallback runner is configured."
      log_runner_failure "$current_runner" "$status" "$output_log" "no-fallback"
      rm -f "$output_log"
      return "$status"
    fi

    echo "Runner '$current_runner' failed with switchable pattern '$matched_pattern'; switching to '$next_runner'."
    log_meta_event "$TASK_ID" "$META_FILE" "runner_switch" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} from=$current_runner to=$next_runner matched_pattern=$matched_pattern phase=${CURRENT_PHASE:-unknown} iteration=${CURRENT_ITERATION:-unknown}"
    current_runner="$next_runner"
    retry_count=0
    rm -f "$output_log"
  done
}

config_list_contains() {
  local key_path="$1"
  local expected="$2"
  ruby "$CONFIG_RESOLVER" contains "$OFFICE_DIR" "$key_path" "$expected"
}

yaml_file_text() {
  local task_file="$1"
  local pm_output_file="$2"

  ruby - "$task_file" "$pm_output_file" <<'RUBY'
require "yaml"
require "date"

task_path, pm_output_path = ARGV
parts = []
parts << File.read(task_path) if File.exist?(task_path)

if File.exist?(pm_output_path)
  data = YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
  parts << data.to_s
end

puts parts.join("\n")
RUBY
}

context_task_is_code_impacting() {
  local task_file="$1"
  local pm_output_file="$2"
  local text
  text="$(yaml_file_text "$task_file" "$pm_output_file" | tr '[:upper:]' '[:lower:]')"

  if [[ "$text" == *"no code changes"* || "$text" == *"vendor email"* || "$text" == *"communication note"* || "$text" == *"pure communication"* ]]; then
    return 1
  fi

  if [[ "$text" == *".go"* || "$text" == *".proto"* || "$text" == *"affected_files"* || "$text" == *"target_services"* || "$text" == *"shared-lib"* || "$text" == *"api-gateway"* || "$text" == *"games-labs-"* || "$text" == *"callback"* || "$text" == *"contract"* ]]; then
    return 0
  fi

  return 1
}

context_queries_for_task() {
  local role="$1"
  local task_file="$2"
  local pm_output_file="$3"

  ruby - "$role" "$task_file" "$pm_output_file" <<'RUBY'
require "yaml"
require "date"

role, task_path, pm_output_path = ARGV
queries = []

if File.exist?(task_path)
  title = File.readlines(task_path).find { |line| line.start_with?("#") }.to_s.gsub(/^#+\s*/, "").strip
  queries << "#{role} #{title}" unless title.empty?
end

if File.exist?(pm_output_path)
  data = YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
  task = data["task"].is_a?(Hash) ? data["task"] : {}
  title = task["title"].to_s.strip
  queries << "#{role} #{title}" unless title.empty?

  scope = data["scope"].is_a?(Hash) ? data["scope"] : {}
  services = Array(scope["target_services"]).map do |entry|
    entry.is_a?(Hash) ? entry["service"].to_s.strip : nil
  end.compact.reject(&:empty?)
  files = Array(scope["affected_files"]).map do |entry|
    entry.is_a?(Hash) ? entry["path"].to_s.strip : nil
  end.compact.reject(&:empty?)
  queries << "affected services #{services.join(' ')}" unless services.empty?
  queries << "affected files #{files.join(' ')}" unless files.empty?
end

puts queries.uniq.first(5).join(" | ")
RUBY
}

detect_context_provider() {
  local provider="$1"

  case "$provider" in
    socraticode)
      if [[ -x "$SOCRATICODE_WRAPPER" ]]; then
        echo "socraticode"
      elif command -v socraticode >/dev/null 2>&1; then
        echo "socraticode"
      else
        echo "none"
      fi
      ;;
    *)
      echo "none"
      ;;
  esac
}

build_context_index_section() {
  local role="$1"
  local task_file="$2"
  local status_file="$3"
  local pm_output_file="$4"
  local provider="$5"
  local mode="$6"
  local fallback="$7"
  local context_status="skipped"
  local freshness="unknown"
  local confidence="low"
  local queries
  local detected
  local output_file
  local error_file

  queries="$(context_queries_for_task "$role" "$task_file" "$pm_output_file")"
  [[ -n "$queries" ]] || queries="$role task context"

  if [[ "$CONTEXT_PROVIDER_ENABLED" != "true" ]]; then
    CONTEXT_PROVIDER_STATUS="skipped"
    CONTEXT_PROVIDER_FRESHNESS="unknown"
    CONTEXT_PROVIDER_CONFIDENCE="low"
    CONTEXT_PROVIDER_NOTE="context provider disabled"
    cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: skipped
freshness: unknown
confidence: low
fallback: $fallback
note: "Context provider is disabled."
EOF
    return 0
  fi

  if [[ "$(config_list_contains "context_provider.roles" "$role")" != "true" ]]; then
    CONTEXT_PROVIDER_STATUS="skipped"
    CONTEXT_PROVIDER_FRESHNESS="unknown"
    CONTEXT_PROVIDER_CONFIDENCE="low"
    CONTEXT_PROVIDER_NOTE="role not configured"
    cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: skipped
freshness: unknown
confidence: low
fallback: $fallback
note: "Context provider is not configured for role '$role'."
EOF
    return 0
  fi

  if ! context_task_is_code_impacting "$task_file" "$pm_output_file"; then
    CONTEXT_PROVIDER_STATUS="skipped"
    CONTEXT_PROVIDER_FRESHNESS="unknown"
    CONTEXT_PROVIDER_CONFIDENCE="low"
    CONTEXT_PROVIDER_NOTE="not code-impacting"
    cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: skipped
freshness: unknown
confidence: low
fallback: $fallback
queries:
  - "$queries"
note: "Context lookup skipped because this task is not code-impacting."
EOF
    return 0
  fi

  detected="$(detect_context_provider "$provider")"
  if [[ "$detected" == "none" ]]; then
    context_status="unavailable"
    CONTEXT_PROVIDER_STATUS="$context_status"
    CONTEXT_PROVIDER_FRESHNESS="$freshness"
    CONTEXT_PROVIDER_CONFIDENCE="$confidence"
    CONTEXT_PROVIDER_NOTE="provider command unavailable"
    cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: unavailable
freshness: unknown
confidence: low
fallback: $fallback
queries:
  - "$queries"
note: "SocratiCode is unavailable. Use local repo inspection, ripgrep, tests, and CI evidence."
rules:
  - Treat this section as guidance only.
  - Verify all code against files on disk before editing.
  - Use ripgrep for exact identifiers and error strings.
EOF
    if [[ "$mode" == "required" ]]; then
      return 1
    fi
    return 0
  fi

  output_file="$(mktemp)"
  error_file="$(mktemp)"
  local socraticode_cmd="${SOCRATICODE_WRAPPER}"
  if [[ ! -x "$socraticode_cmd" ]]; then
    socraticode_cmd="socraticode"
  fi
  if "$socraticode_cmd" context --role "$role" --task-file "$task_file" --status-file "$status_file" --pm-output "$pm_output_file" >"$output_file" 2>"$error_file"; then
    if [[ ! -s "$output_file" ]]; then
      context_status="fallback"
      CONTEXT_PROVIDER_STATUS="$context_status"
      CONTEXT_PROVIDER_FRESHNESS="unknown"
      CONTEXT_PROVIDER_CONFIDENCE="low"
      CONTEXT_PROVIDER_NOTE="empty index result"
      rm -f "$output_file" "$error_file"
      cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: fallback
freshness: unknown
confidence: low
fallback: $fallback
queries:
  - "$queries"
note: "SocratiCode returned no context. Use local repo inspection, ripgrep, tests, and CI evidence."
rules:
  - Treat this section as guidance only.
  - Verify all code against files on disk before editing.
  - Use ripgrep for exact identifiers and error strings.
EOF
      return 0
    fi

    CONTEXT_PROVIDER_FRESHNESS="$(grep -E '^freshness:' "$output_file" | head -1 | sed 's/^freshness:[[:space:]]*//' || true)"
    CONTEXT_PROVIDER_CONFIDENCE="$(grep -E '^confidence:' "$output_file" | head -1 | sed 's/^confidence:[[:space:]]*//' || true)"
    [[ -n "$CONTEXT_PROVIDER_FRESHNESS" ]] || CONTEXT_PROVIDER_FRESHNESS="unknown"
    [[ -n "$CONTEXT_PROVIDER_CONFIDENCE" ]] || CONTEXT_PROVIDER_CONFIDENCE="medium"
    if [[ "$CONTEXT_PROVIDER_FRESHNESS" == "stale" ]]; then
      CONTEXT_PROVIDER_STATUS="fallback"
      CONTEXT_PROVIDER_NOTE="stale index result"
    else
      CONTEXT_PROVIDER_STATUS="used"
      CONTEXT_PROVIDER_NOTE="provider context injected"
    fi
    cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: $CONTEXT_PROVIDER_STATUS
$(cat "$output_file")
rules:
  - Treat this section as guidance only.
  - Verify all code against files on disk before editing.
  - Use ripgrep for exact identifiers and error strings.
EOF
    rm -f "$output_file" "$error_file"
    return 0
  fi

  local error_summary
  error_summary="$(head -3 "$error_file" | tr '\n' ' ' | sed 's/"/'\''/g')"
  CONTEXT_PROVIDER_STATUS="failed"
  CONTEXT_PROVIDER_FRESHNESS="unknown"
  CONTEXT_PROVIDER_CONFIDENCE="low"
  CONTEXT_PROVIDER_NOTE="$error_summary"
  rm -f "$output_file" "$error_file"
  cat <<EOF
--- AI CONTEXT INDEX ---
provider: $provider
status: failed
freshness: unknown
confidence: low
fallback: $fallback
queries:
  - "$queries"
note: "SocratiCode lookup failed. Use local repo inspection, ripgrep, tests, and CI evidence."
rules:
  - Treat this section as guidance only.
  - Verify all code against files on disk before editing.
  - Use ripgrep for exact identifiers and error strings.
EOF
  if [[ "$mode" == "required" ]]; then
    return 1
  fi
}

REVIEWER_QUEUE_PHASE="$(config_value "state_model.reviewer_queue_phase" "in_review")"
BLOCKED_DISPATCH_GUARD="$(config_bool "dependency_policy.blocked_dispatch_guard" "true")"
ENFORCE_CURRENT_AGENT_ROUTE="$(config_bool "dependency_policy.enforce_current_agent_route" "true")"
AUTO_RECONCILE_BEFORE_DISPATCH="$(config_bool "dependency_policy.auto_reconcile_before_dispatch" "true")"
UNBLOCK_WHEN_UPSTREAM_PHASE="$(config_value "dependency_policy.unblock_when_upstream_phase" "done")"
UNBLOCK_CLEAR_WAITING_FOR="$(config_bool "dependency_policy.on_unblock.clear_waiting_for" "true")"
UNBLOCK_SET_READY="$(config_bool "dependency_policy.on_unblock.set_ready" "true")"
UNBLOCK_ROUTE_FROM_ASSIGNMENT="$(config_bool "dependency_policy.on_unblock.route_from_assignment_primary" "true")"
DEPENDENCY_GUARD_ENABLED="$(config_bool "dependency_guard.enabled" "true")"
DEPENDENCY_GUARD_SCRIPT="$(config_value "dependency_guard.script" "scripts/check-service-dependencies.sh")"
CONTEXT_PROVIDER_ENABLED="$(config_bool "context_provider.enabled" "false")"
CONTEXT_PROVIDER_NAME="$(config_value "context_provider.provider" "socraticode")"
CONTEXT_PROVIDER_MODE="$(config_value "context_provider.mode" "optional")"
CONTEXT_PROVIDER_POLICY="$(config_value "context_provider.policy" "recorded")"
CONTEXT_PROVIDER_FALLBACK="$(config_value "context_provider.fallback" "repo_search")"
CONTEXT_PROVIDER_STATUS="skipped"
CONTEXT_PROVIDER_FRESHNESS="unknown"
CONTEXT_PROVIDER_CONFIDENCE="low"
CONTEXT_PROVIDER_NOTE=""

should_run_dependency_guard() {
  case "$1" in
    reviewer|devops|auto) return 0 ;;
    *) return 1 ;;
  esac
}

run_dependency_guard() {
  local guard_script="$OFFICE_DIR/$DEPENDENCY_GUARD_SCRIPT"
  if [[ ! -f "$guard_script" ]]; then
    echo "Dependency guard script not found: $guard_script"
    return 1
  fi
  echo "Running dependency guard: $guard_script"
  "$guard_script"
}

reconcile_blocked_status() {
  local task_id="$1"
  local status_file="$2"
  local runs_dir="$3"
  local today="$4"
  local unblock_phase="$5"
  local reviewer_queue_phase="$6"
  local clear_waiting_for="$7"
  local set_ready="$8"
  local route_from_assignment="$9"

  ruby - "$task_id" "$status_file" "$runs_dir" "$today" "$unblock_phase" "$reviewer_queue_phase" "$clear_waiting_for" "$set_ready" "$route_from_assignment" <<'RUBY'
require "yaml"
require "date"

task_id, status_path, runs_dir, today, unblock_phase, reviewer_queue_phase, clear_waiting_for, set_ready, route_from_assignment = ARGV
exit 0 unless File.exist?(status_path)

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

status = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
phase = status["state"].to_s.strip
phase = status["phase"].to_s.strip if phase.empty?
blocked_on = Array(status["blocked_on"]).map(&:to_s).map(&:strip).reject(&:empty?)

exit 0 unless phase == "blocked"
exit 0 if blocked_on.empty?

# I3: ownership fence, ORCHESTRATOR lane — placed AFTER the no-op guards above,
# so it only gates the invocations that are actually going to write. Unblocking
# a dependency-gated task is not a dispatch and holds no lease (it runs BEFORE
# this dispatch acquires, so there is no epoch to present even in principle),
# so it is refused only while a lease is LIVE. See docs/task-ownership.md.
__own = File.join(
  ENV["AI_DEV_OFFICE_HOME"].to_s.empty? ? File.expand_path("../..", File.dirname(status_path)) : ENV["AI_DEV_OFFICE_HOME"],
  "scripts", "task-ownership.rb"
)
if File.exist?(__own)
  require __own
  TaskOwnership.fence!(File.dirname(status_path), force_orchestrator: true)
elsif File.exist?(File.join(File.dirname(status_path), "ownership.yaml"))
  warn "[ownership] ownership.yaml exists but scripts/task-ownership.rb is missing; refusing the write."
  exit 9
end

# S6: an upstream that ends in a failed terminal state can never reach the
# unblock phase, so a dependent waiting on it would stay blocked forever.
terminal_failed = %w[aborted validation_failed]
failed_deps = []
pending = blocked_on.each_with_object([]) do |dep_task_id, memo|
  dep_status_path = File.join(runs_dir, dep_task_id, "status.yaml")
  unless File.exist?(dep_status_path)
    memo << dep_task_id
    next
  end

  dep_status = YAML.safe_load(File.read(dep_status_path), permitted_classes: [Date, Time], aliases: true) || {}
  dep_phase = dep_status["state"].to_s.strip
  dep_phase = dep_status["phase"].to_s.strip if dep_phase.empty?
  if terminal_failed.include?(dep_phase)
    failed_deps << dep_task_id
  elsif dep_phase != unblock_phase
    memo << dep_task_id
  end
end

unless failed_deps.empty?
  # S6: route the wedged dependent to free-roam for re-planning instead of
  # leaving it blocked forever on a failed upstream.
  old_phase = status["phase"].to_s.strip
  old_phase = "blocked" if old_phase.empty?
  status["phase"] = "escalated"
  status["state"] = "escalated"
  status["current_agent"] = "free-roam"
  status["ready"] = true
  status["waiting_for"] = [] if clear_waiting_for == "true"
  status["updated_at"] = today
  status["history"] = [] unless status["history"].is_a?(Array)
  status["history"] << {
    "phase" => "#{old_phase} -> escalated",
    "agent" => "orchestrator",
    "reason" => "Upstream dependency failed (#{failed_deps.join(', ')}); cannot unblock by waiting.",
    "at" => Time.now.utc.strftime("%FT%TZ")  # N1
  }
  tmp_path = "#{status_path}.tmp.#{$$}"
  begin
    File.write(tmp_path, YAML.dump(status))
    File.rename(tmp_path, status_path)
  rescue => e
    File.delete(tmp_path) if File.exist?(tmp_path)
    raise e
  end
  puts "Status escalated: upstream dependency failed (#{failed_deps.join(', ')})"
  exit 0
end

if pending.empty?
  old_phase = status["phase"].to_s.strip
  old_phase = "pending" if old_phase.empty?
  primary = status.dig("assignment", "primary").to_s.strip
  route_from_assignment = route_from_assignment == "true"
  new_phase = old_phase

  if route_from_assignment
    new_phase =
      case primary
      when "dev", "dev-2" then "assigned"
      when "reviewer" then reviewer_queue_phase
      else "pending"
      end
  end

  status["phase"] = new_phase
  status["state"] = new_phase
  status["current_agent"] = primary.empty? ? "pm" : primary
  status["ready"] = true if set_ready == "true"
  status["waiting_for"] = [] if clear_waiting_for == "true"
  status["updated_at"] = today
  status["history"] = [] unless status["history"].is_a?(Array)
  status["history"] << {
    "phase" => "#{old_phase} -> #{new_phase}",
    "agent" => "orchestrator",
    "reason" => "Dependencies resolved: #{blocked_on.join(', ')}",
    "at" => Time.now.utc.strftime("%FT%TZ")  # N1
  }

  tmp_path = "#{status_path}.tmp.#{$$}"
  begin
    File.write(tmp_path, YAML.dump(status))
    File.rename(tmp_path, status_path)
  rescue => e
    File.delete(tmp_path) if File.exist?(tmp_path)
    raise e
  end
  puts "Status unblocked: #{old_phase} -> #{new_phase}"
else
  puts "Status remains blocked: waiting on #{pending.join(', ')}"
end
RUBY
}

sync_status_from_output() {
  local task_id="$1"
  local agent="$2"
  local status_file="$3"
  local output_file="$4"
  local today="$5"
  local reviewer_queue_phase="$6"

  ruby - "$task_id" "$agent" "$status_file" "$output_file" "$today" "$reviewer_queue_phase" <<'RUBY'
require "yaml"
require "time"
require "date"
require "digest"

task_id, actor_agent, status_path, output_path, today, reviewer_queue_phase = ARGV

unless File.exist?(output_path)
  warn "Status sync skipped: output file missing at #{output_path}"
  exit 0
end

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

# I3: ownership fence, INSIDE the lock so check and write are one critical
# section — a run that lost its lease can never overwrite the new owner's
# status (exits 9). No record on disk = ungoverned = allowed, so existing
# single-agent runs are unaffected. See docs/task-ownership.md.
__own = File.join(
  ENV["AI_DEV_OFFICE_HOME"].to_s.empty? ? File.expand_path("../..", File.dirname(status_path)) : ENV["AI_DEV_OFFICE_HOME"],
  "scripts", "task-ownership.rb"
)
if File.exist?(__own)
  require __own
  TaskOwnership.fence!(File.dirname(status_path))
elsif File.exist?(File.join(File.dirname(status_path), "ownership.yaml"))
  warn "[ownership] ownership.yaml exists but scripts/task-ownership.rb is missing; refusing the write."
  exit 9
end

# S1: a corrupt status.yaml must not crash the whole run with a raw backtrace.
status = begin
  if File.exist?(status_path)
    YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
  else
    {}
  end
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  warn "Refusing to sync against an unreadable status; inspect runs/#{task_id}/status.yaml."
  exit 4
end

# S1: malformed agent output routes to validation_failed (driver handles exit 3)
# instead of aborting the run after meta.yaml was already mutated.
output = begin
  YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "#{actor_agent} output is malformed YAML for #{task_id}: #{e.message}"
  exit 3
end

# M2: idempotency. If this exact output artifact was already synced, do not
# re-apply the transition or re-increment iteration — a retried/duplicate
# dispatch (flaky run, timeout retry, codex exiting 0 without rewriting) must
# not advance the state machine twice.
output_digest = Digest::SHA256.hexdigest(File.read(output_path))
last_synced = status["last_synced_output"]
if last_synced.is_a?(Hash) && last_synced["digest"].to_s == output_digest && last_synced["file"].to_s == File.basename(output_path)
  puts "Output #{File.basename(output_path)} already synced (idempotent skip)."
  exit 0
end

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
    when "dev", "dev-2"
      assignment = output["assignment"].is_a?(Hash) ? output["assignment"] : {}
      assignment["parallel"] == true ? "assigned_parallel" : "assigned"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "dev", "dev-2"
    case next_agent
    when "reviewer" then reviewer_queue_phase
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
    when "reviewer" then reviewer_queue_phase
    when "dev", "dev-2" then "debugging_complete"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "devops"
    case next_agent
    when "reviewer" then reviewer_queue_phase
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
      "reviewer" => reviewer_queue_phase,
      "debugger" => "debugging",
      "devops" => "devops_needed",
      "free-roam" => "escalated",
      "done" => "done"
    }
    fallback_phase_map.fetch(next_agent, old_phase)
  end

work_agents = ["dev", "dev-2", "reviewer", "debugger", "devops"]
# M3: do NOT reset the work-agent budget on free-roam. Zeroing `iteration` made
# the loop guard defeatable (infinite dev<->reviewer<->free-roam). Instead count
# completed free-roam passes in a separate, non-resettable counter the guard reads.
if actor_agent == "free-roam"
  status["free_roam_entries"] = status["free_roam_entries"].to_i + 1
end

if work_agents.include?(next_agent)
  iteration = status["iteration"].to_i
  status["iteration"] = iteration + 1
end

status["task_id"] ||= task_id
status["phase"] = new_phase
status["state"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["ready"] = (new_phase != "blocked" && next_agent != "done")
status["waiting_for"] = [] if status.key?("waiting_for")
status["handoff"] = {
  "from" => actor_agent,
  "to" => next_agent,
  "artifact" => "runs/#{task_id}/#{File.basename(output_path)}"
}
status["history"] = [] unless status["history"].is_a?(Array)

if reason.empty?
  summary = output["summary"].to_s.strip
  reason = summary.lines.first.to_s.strip
end
reason = "Transitioned by #{actor_agent} output." if reason.empty?

status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason,
  "at" => Time.now.utc.strftime("%FT%TZ")  # N1
}

# M2: record what we just processed so a retried dispatch of the same artifact
# is a no-op (see the idempotency check above).
status["last_synced_output"] = {
  "file" => File.basename(output_path),
  "digest" => output_digest,
  "next" => next_agent
}

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end
puts "Status synced: #{old_phase} -> #{new_phase} (next: #{next_agent})"
RUBY
}

next_agent_from_output() {
  local actor_agent="$1"
  local output_file="$2"

  ruby - "$actor_agent" "$output_file" <<'RUBY'
require "yaml"
require "date"
require "time"

actor_agent, output_path = ARGV

unless File.exist?(output_path)
  exit 0
end

output = YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true) || {}
next_action = output["next_action"].is_a?(Hash) ? output["next_action"] : {}
next_agent = next_action["agent"]&.to_s&.strip

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

print next_agent.to_s
RUBY
}

parallel_plan_agents() {
  local pm_output_file="$1"

  ruby - "$pm_output_file" <<'RUBY'
require "yaml"
require "date"
require "time"

pm_output_path = ARGV.fetch(0)
exit 0 unless File.exist?(pm_output_path)

data = YAML.safe_load(File.read(pm_output_path), permitted_classes: [Date, Time], aliases: true) || {}
assignment = data["assignment"].is_a?(Hash) ? data["assignment"] : {}
exit 0 unless assignment["parallel"] == true

plan = data["plan"].is_a?(Hash) ? data["plan"] : {}
subtasks = plan["subtasks"].is_a?(Array) ? plan["subtasks"] : []
errors = []

if subtasks.length < 2
  errors << "parallel assignment requires at least 2 subtasks"
end

allowed_agents = %w[dev dev-2]
agents = []
owned_by_path = {}
shared_by_agent = Hash.new { |hash, key| hash[key] = [] }

def shared_file?(path)
  normalized = path.to_s.strip
  basename = File.basename(normalized)
  return true if %w[go.mod go.sum].include?(basename)
  return true if normalized.end_with?(".proto")
  return true if normalized.end_with?(".pb.go") || normalized.end_with?("_grpc.pb.go")
  return true if normalized == "shared-lib" || normalized.start_with?("shared-lib/")
  return true if normalized.include?("/shared-lib/")
  false
end

subtasks.each_with_index do |subtask, index|
  unless subtask.is_a?(Hash)
    errors << "subtask #{index + 1} must be a map"
    next
  end

  agent = subtask["agent"].to_s.strip
  unless allowed_agents.include?(agent)
    errors << "subtask #{index + 1} has unsupported parallel agent: #{agent.empty? ? '(empty)' : agent}"
  end
  agents << agent if allowed_agents.include?(agent)

  unless subtask["parallel_safe"] == true
    errors << "subtask #{index + 1} must set parallel_safe: true"
  end

  owned_files = Array(subtask["owned_files"]).map(&:to_s).map(&:strip).reject(&:empty?)
  if owned_files.empty?
    errors << "subtask #{index + 1} must list owned_files"
  end

  owned_files.each do |path|
    if owned_by_path.key?(path)
      errors << "owned file assigned to multiple parallel subtasks: #{path}"
    else
      owned_by_path[path] = agent
    end

    shared_by_agent[agent] << path if allowed_agents.include?(agent) && shared_file?(path)
  end
end

unique_agents = agents.uniq
if unique_agents.length < 2
  errors << "parallel assignment requires at least 2 distinct agents: dev and dev-2"
end

shared_agents = shared_by_agent.select { |_agent, paths| !paths.empty? }
if shared_agents.length > 1
  details = shared_agents.map { |agent, paths| "#{agent}=#{paths.uniq.join(',')}" }.join(" ")
  errors << "shared file cannot be modified by multiple parallel agents: #{details}"
end

if errors.any?
  warn errors.join("\n")
  exit 2
end

puts unique_agents.sort_by { |agent| allowed_agents.index(agent) }
RUBY
}

parallel_delay_seconds() {
  if [[ -n "${AI_DEV_OFFICE_PARALLEL_DELAY_SECONDS:-}" ]]; then
    echo "$AI_DEV_OFFICE_PARALLEL_DELAY_SECONDS"
  else
    ruby -e 'puts rand(1..3)'
  fi
}

run_parallel_dev_agents() {
  local agents_text="$1"
  local agents_label
  local agent
  local index=0
  local delay
  local status=0
  local pids=()
  local pid_agents=()
  local pid_logs=()

  agents_label="$(printf '%s\n' "$agents_text" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  echo "Running parallel dev agents: $agents_label"

  while IFS= read -r agent; do
    [[ -n "$agent" ]] || continue
    local log_file="$TASK_DIR/${agent}-parallel.log"
    rm -f "$log_file"

    (
      if [[ "$index" -gt 0 ]]; then
        delay="$(parallel_delay_seconds)"
        sleep "$delay"
      fi
      AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true run_agent_invocation "$TASK_ID" "$agent" "$RUNNER"
    ) >"$log_file" 2>&1 &

    pids+=("$!")
    pid_agents+=("$agent")
    pid_logs+=("$log_file")
    index=$((index + 1))
  done <<<"$agents_text"

  index=0
  for pid in "${pids[@]}"; do
    agent="${pid_agents[$index]}"
    local log_file="${pid_logs[$index]}"
    if wait "$pid"; then
      echo "Parallel agent $agent completed successfully (log: $log_file)"
    else
      local exit_code=$?
      echo "Parallel agent $agent failed with exit $exit_code (log: $log_file)"
      tail -40 "$log_file" || true
      status=1
    fi
    index=$((index + 1))
  done

  return "$status"
}

mark_parallel_dev_complete() {
  force_status_route "$TASK_ID" "$STATUS_FILE" "$TODAY" "reviewer" "$REVIEWER_QUEUE_PHASE" "orchestrator" "Parallel dev lanes completed."
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

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

# I3: same ownership fence as sync_status_from_output — a forced route is still
# a status write, so a run that lost its lease must not land one either.
__own = File.join(
  ENV["AI_DEV_OFFICE_HOME"].to_s.empty? ? File.expand_path("../..", File.dirname(status_path)) : ENV["AI_DEV_OFFICE_HOME"],
  "scripts", "task-ownership.rb"
)
if File.exist?(__own)
  require __own
  TaskOwnership.fence!(File.dirname(status_path))
elsif File.exist?(File.join(File.dirname(status_path), "ownership.yaml"))
  warn "[ownership] ownership.yaml exists but scripts/task-ownership.rb is missing; refusing the write."
  exit 9
end

status = if File.exist?(status_path)
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

old_phase = status["phase"].to_s.strip
old_phase = "pending" if old_phase.empty?

status["task_id"] ||= task_id
status["phase"] = new_phase
status["state"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["ready"] = (new_phase != "blocked" && next_agent != "done")
status["handoff"] = {
  "from" => actor_agent,
  "to" => next_agent,
  "artifact" => "forced-route"
}
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason,
  "at" => Time.now.utc.strftime("%FT%TZ")  # N1
}

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end
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

ownership_apply_config_switch

if [[ "$AGENT" != "pm" && -f "$STATUS_FILE" && "$AUTO_RECONCILE_BEFORE_DISPATCH" == "true" ]]; then
  reconcile_blocked_status "$TASK_ID" "$STATUS_FILE" "$RUNS_DIR" "$TODAY" "$UNBLOCK_WHEN_UPSTREAM_PHASE" "$REVIEWER_QUEUE_PHASE" "$UNBLOCK_CLEAR_WAITING_FOR" "$UNBLOCK_SET_READY" "$UNBLOCK_ROUTE_FROM_ASSIGNMENT"
fi

# Apply any pending human decision (decision.yaml) before reading phase. The
# dashboard only writes decision.yaml; this driver step is the only writer that
# reconciles it into status.yaml (single-writer invariant preserved).
if [[ "$AGENT" != "pm" && -f "$STATUS_FILE" ]]; then
  DECISION_ERR="$(mktemp)"
  DECISION_RC=0
  DECISION_RESULT="$(ruby "$OFFICE_DIR/scripts/reconcile-decision.rb" "$TASK_ID" 2>"$DECISION_ERR")" || DECISION_RC=$?
  # S3: surface a malformed/unreadable decision.yaml instead of silently dropping it.
  [[ -s "$DECISION_ERR" ]] && cat "$DECISION_ERR" >&2
  rm -f "$DECISION_ERR"
  if [[ "$DECISION_RC" -eq 3 ]]; then
    echo "A human decision is pending but unreadable; refusing to dispatch. Fix runs/$TASK_ID/decision.yaml (or remove it)."
    exit 1
  fi
  if [[ "$DECISION_RESULT" == applied:* ]]; then
    echo "Applied human decision (${DECISION_RESULT#applied:})."
    log_meta_event "$TASK_ID" "$META_FILE" "decision_applied" "$AGENT" "task=$TASK_LABEL ${DECISION_RESULT#applied:}"
    case "$DECISION_RESULT" in
      applied:approve:*|applied:reject:*)
        echo "Task reached a terminal state by human decision; not dispatching $AGENT."
        exit 0
        ;;
      applied:*)
        # S5: a non-terminal decision (request_changes->debugger, escalate->free-roam)
        # reassigned the task. Dispatch the agent it routed to, regardless of the
        # route-enforcement flag — a just-applied human decision is authoritative.
        DECISION_AGENT="$(status_value "$STATUS_FILE" "current_agent")"
        if [[ -n "$DECISION_AGENT" && "$DECISION_AGENT" != "done" && "$DECISION_AGENT" != "$AGENT" ]]; then
          echo "Human decision routed this task to '$DECISION_AGENT'; dispatching that instead of '$AGENT'."
          AGENT="$DECISION_AGENT"
        fi
        ;;
    esac
  fi
fi

CURRENT_ITERATION="$(effective_iteration "$STATUS_FILE")"
CURRENT_FREE_ROAM_ENTRIES="$(effective_free_roam_entries "$STATUS_FILE")"
CURRENT_PHASE="$(status_value "$STATUS_FILE" "phase")"
CURRENT_STATE="$(status_value "$STATUS_FILE" "state")"
CURRENT_READY="$(status_value "$STATUS_FILE" "ready")"
CURRENT_AGENT="$(status_value "$STATUS_FILE" "current_agent")"
CURRENT_BLOCKED_ON="$(status_list_values "$STATUS_FILE" "blocked_on")"
CURRENT_WAITING_FOR="$(status_list_values "$STATUS_FILE" "waiting_for")"

if [[ -z "$CURRENT_STATE" ]]; then
  CURRENT_STATE="$CURRENT_PHASE"
fi

# M4: validation_failed is a bounded, route-out state. Don't silently re-dispatch
# the failing agent against unchanged input, and hard-halt after repeated failures.
if [[ "$AGENT" != "pm" && -f "$STATUS_FILE" && ( "$CURRENT_PHASE" == "validation_failed" || "$CURRENT_STATE" == "validation_failed" ) ]]; then
  VF_RETRIES="$(status_value "$STATUS_FILE" "validation_failed_retries")"
  [[ "$VF_RETRIES" =~ ^[0-9]+$ ]] || VF_RETRIES=0
  if [[ "${AI_DEV_OFFICE_FORCE:-false}" != "true" ]]; then
    if [[ "$VF_RETRIES" -ge "$VALIDATION_FAILED_RETRY_LIMIT" ]]; then
      echo "Task $TASK_LABEL failed validation $VF_RETRIES times (limit $VALIDATION_FAILED_RETRY_LIMIT). Halting — needs human intervention."
      echo "Set AI_DEV_OFFICE_FORCE=true to override."
      log_meta_event "$TASK_ID" "$META_FILE" "loop_guard" "$AGENT" "task=$TASK_LABEL phase=validation_failed validation_failed_retries=$VF_RETRIES limit=$VALIDATION_FAILED_RETRY_LIMIT reason=validation_failed_exhausted"
      exit 1
    fi
    if [[ "$AGENT" != "free-roam" && "$AGENT" != "auto" ]]; then
      echo "Task $TASK_LABEL is in validation_failed; refusing to re-dispatch '$AGENT' against unchanged input."
      echo "Routed to 'free-roam' for remediation: ./run-agent.sh $TASK_ID free-roam   (AI_DEV_OFFICE_FORCE=true to override)"
      exit 1
    fi
  fi
fi

# M6: don't silently re-open a finished task. pm/auto skip the other guards, so
# re-running them on a done/aborted task would re-drive the whole machine and
# undo a terminal decision (e.g. a human reject -> aborted).
if [[ ( "$AGENT" == "pm" || "$AGENT" == "auto" ) && -f "$STATUS_FILE" && "${AI_DEV_OFFICE_FORCE:-false}" != "true" ]]; then
  if [[ "$CURRENT_PHASE" == "done" || "$CURRENT_PHASE" == "aborted" || "$CURRENT_STATE" == "done" || "$CURRENT_STATE" == "aborted" ]]; then
    echo "Task $TASK_LABEL is already ${CURRENT_PHASE:-$CURRENT_STATE}; refusing to re-open it with '$AGENT'."
    echo "Set AI_DEV_OFFICE_FORCE=true to reopen."
    log_meta_event "$TASK_ID" "$META_FILE" "reopen_blocked" "$AGENT" "task=$TASK_LABEL phase=${CURRENT_PHASE:-unknown} state=${CURRENT_STATE:-unknown}"
    exit 1
  fi
fi

if [[ "$AGENT" != "pm" && "$AGENT" != "free-roam" && "$AGENT" != "auto" && -f "$STATUS_FILE" ]]; then
  if [[ "$BLOCKED_DISPATCH_GUARD" == "true" && ( "$CURRENT_STATE" == "blocked" || "$CURRENT_PHASE" == "blocked" ) ]]; then
    echo "Task $TASK_LABEL is blocked and cannot be dispatched."
    [[ -n "$CURRENT_BLOCKED_ON" ]] && echo "Blocked on: $CURRENT_BLOCKED_ON"
    [[ -n "$CURRENT_WAITING_FOR" ]] && echo "Waiting for: $CURRENT_WAITING_FOR"
    exit 1
  fi

  if [[ "$ENFORCE_CURRENT_AGENT_ROUTE" == "true" && -n "$CURRENT_AGENT" && "$CURRENT_AGENT" != "$AGENT" && "$CURRENT_AGENT" != "done" && ! ( "${AI_DEV_OFFICE_PARALLEL_AUTO:-false}" == "true" && ( "$AGENT" == "dev" || "$AGENT" == "dev-2" ) ) ]]; then
    echo "Task $TASK_LABEL is currently routed to '$CURRENT_AGENT', not '$AGENT'."
    echo "Current phase/state: ${CURRENT_PHASE:-unknown}/${CURRENT_STATE:-unknown}"
    exit 1
  fi
fi

if [[ "$AGENT" == "auto" && -f "$STATUS_FILE" && "$BLOCKED_DISPATCH_GUARD" == "true" ]] && [[ "$CURRENT_STATE" == "blocked" || "$CURRENT_PHASE" == "blocked" ]]; then
  echo "Task $TASK_LABEL is blocked and cannot run in auto mode."
  [[ -n "$CURRENT_BLOCKED_ON" ]] && echo "Blocked on: $CURRENT_BLOCKED_ON"
  [[ -n "$CURRENT_WAITING_FOR" ]] && echo "Waiting for: $CURRENT_WAITING_FOR"
  exit 1
fi

if [[ "$DEPENDENCY_GUARD_ENABLED" == "true" ]] && should_run_dependency_guard "$AGENT"; then
  if ! run_dependency_guard; then
    echo "Dependency guard failed. Fix dependency consistency before continuing."
    exit 1
  fi
fi

if [[ "$AGENT" != "pm" && -f "$STATUS_FILE" && "$CURRENT_ITERATION" =~ ^[0-9]+$ ]]; then
  if [[ "$AGENT" == "free-roam" && "$CURRENT_FREE_ROAM_ENTRIES" =~ ^[0-9]+$ && "$CURRENT_FREE_ROAM_ENTRIES" -ge "$FREE_ROAM_LOOP_LIMIT" ]]; then
    # M3: halt on completed free-roam passes, not on the (now-non-reset) iteration.
    LOOP_REASON="Free-roam loop guard triggered: exceeded free_roam_max_entries (${CURRENT_FREE_ROAM_ENTRIES}/${FREE_ROAM_LOOP_LIMIT})."
    echo "Free-roam loop guard triggered for $TASK_LABEL after $CURRENT_FREE_ROAM_ENTRIES free-roam passes. Halting."
    log_meta_event "$TASK_ID" "$META_FILE" "loop_guard" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} phase=${CURRENT_PHASE:-unknown} free_roam_entries=$CURRENT_FREE_ROAM_ENTRIES limit=$FREE_ROAM_LOOP_LIMIT agent=free-roam"
    exit 1
  elif [[ "$AGENT" != "free-roam" && "$CURRENT_ITERATION" -ge "$LOOP_LIMIT" ]]; then
    LOOP_REASON="Loop guard triggered: exceeded max_iterations (${CURRENT_ITERATION}/${LOOP_LIMIT}) while attempting ${AGENT}."
    echo "Loop guard triggered for $TASK_LABEL at iteration $CURRENT_ITERATION. Routing to free-roam."
    force_status_route "$TASK_ID" "$STATUS_FILE" "$TODAY" "free-roam" "escalated" "$AGENT" "$LOOP_REASON"
    log_meta_event "$TASK_ID" "$META_FILE" "loop_guard" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} phase=${CURRENT_PHASE:-unknown} iteration=$CURRENT_ITERATION limit=$LOOP_LIMIT routed_to=free-roam"
    exit 1
  fi
fi

if [[ "$AGENT" == "auto" ]]; then
  echo "=== Auto Pipeline for $TASK_ID ==="
  STEP="pm"
  while [[ -n "$STEP" ]]; do
    echo ""
    echo ">>> Running $STEP ..."
    run_agent_invocation "$TASK_ID" "$STEP" "$RUNNER"
    STEP_OUTPUT="$TASK_DIR/${STEP}-output.yaml"
    NEXT="$(next_agent_from_output "$STEP" "$STEP_OUTPUT")"

    if [[ "$STEP" == "pm" ]]; then
      PARALLEL_PLAN_OUTPUT=""
      PARALLEL_PLAN_STATUS=0
      PARALLEL_PLAN_OUTPUT="$(parallel_plan_agents "$PM_OUTPUT_FILE" 2>&1)" || PARALLEL_PLAN_STATUS=$?
      if [[ "$PARALLEL_PLAN_STATUS" -eq 2 ]]; then
        echo "Parallel plan invalid:"
        printf '%s\n' "$PARALLEL_PLAN_OUTPUT"
        exit 1
      elif [[ "$PARALLEL_PLAN_STATUS" -ne 0 ]]; then
        printf '%s\n' "$PARALLEL_PLAN_OUTPUT"
        exit "$PARALLEL_PLAN_STATUS"
      elif [[ -n "$PARALLEL_PLAN_OUTPUT" ]]; then
        if run_parallel_dev_agents "$PARALLEL_PLAN_OUTPUT"; then
          mark_parallel_dev_complete
          STEP="reviewer"
          echo ">>> Next agent: reviewer"
          continue
        fi
        echo "Parallel dev agents failed. Review the parallel logs before continuing."
        exit 1
      fi
    fi

    if [[ -z "$NEXT" ]]; then
      case "$STEP" in
        pm)
          NEXT="dev"
          ;;
        dev|dev-2|debugger|devops)
          NEXT="reviewer"
          ;;
        reviewer|free-roam)
          NEXT=""
          ;;
      esac
    fi

    if [[ "$NEXT" == "done" ]]; then
      echo ""
      echo "=== Task $TASK_ID completed! ==="
      exit 0
    fi

    if [[ -n "$NEXT" && "$NEXT" != "$STEP" ]]; then
      echo ">>> Next agent: $NEXT"
    fi

    STEP="$NEXT"
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

# issue #12: risk-based review depth. The reviewer is TOLD the level the
# deterministic path rules produce for the artifacts under review, so depth is
# never a matter of how important the change felt to the model. The path set
# comes from the SAME resolver the gate enforces with — the prompt and the rule
# cannot diverge.
reviewed_artifact_paths() {
  ruby "$OFFICE_DIR/scripts/review-gate.rb" --upstream-paths "$TASK_DIR"
}

REVIEW_DEPTH_SECTION=""
if [[ "$AGENT" == "reviewer" ]]; then
  REVIEW_PATHS=()
  while IFS= read -r reviewed_path; do
    [[ -n "$reviewed_path" ]] && REVIEW_PATHS+=("$reviewed_path")
  done < <(reviewed_artifact_paths)
  if [[ ${#REVIEW_PATHS[@]} -gt 0 ]]; then
    REVIEW_DEPTH_SECTION="
--- REVIEW DEPTH (office.config.yaml reviewer.risk_rules) ---
$(ruby "$OFFICE_DIR/scripts/classify-risk.rb" "$OFFICE_DIR" --explain "${REVIEW_PATHS[@]}")
Report this level in risk_level. You may raise it and say why; never lower it."
  fi
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

CONTEXT_SECTION=""
if [[ "$AGENT" != "auto" && "$AGENT" != "scaffold" ]]; then
  if ! CONTEXT_SECTION="$(build_context_index_section "$AGENT" "$TASK_FILE" "$STATUS_FILE" "$PM_OUTPUT_FILE" "$CONTEXT_PROVIDER_NAME" "$CONTEXT_PROVIDER_MODE" "$CONTEXT_PROVIDER_FALLBACK")"; then
    echo "Context provider failed and mode is required."
    exit 1
  fi
  CONTEXT_PROVIDER_STATUS="$(printf '%s\n' "$CONTEXT_SECTION" | grep -E '^status:' | head -1 | sed 's/^status:[[:space:]]*//' || true)"
  CONTEXT_PROVIDER_FRESHNESS="$(printf '%s\n' "$CONTEXT_SECTION" | grep -E '^freshness:' | head -1 | sed 's/^freshness:[[:space:]]*//' || true)"
  CONTEXT_PROVIDER_CONFIDENCE="$(printf '%s\n' "$CONTEXT_SECTION" | grep -E '^confidence:' | head -1 | sed 's/^confidence:[[:space:]]*//' || true)"
  [[ -n "$CONTEXT_PROVIDER_STATUS" ]] || CONTEXT_PROVIDER_STATUS="skipped"
  [[ -n "$CONTEXT_PROVIDER_FRESHNESS" ]] || CONTEXT_PROVIDER_FRESHNESS="unknown"
  [[ -n "$CONTEXT_PROVIDER_CONFIDENCE" ]] || CONTEXT_PROVIDER_CONFIDENCE="low"
  CONTEXT_PROVIDER_NOTE="$(printf '%s\n' "$CONTEXT_SECTION" | grep -E '^note:' | head -1 | sed 's/^note:[[:space:]]*//' | tr -d '"' || true)"
  log_meta_event "$TASK_ID" "$META_FILE" "context_provider" "$AGENT" "provider=$CONTEXT_PROVIDER_NAME status=$CONTEXT_PROVIDER_STATUS freshness=$CONTEXT_PROVIDER_FRESHNESS confidence=$CONTEXT_PROVIDER_CONFIDENCE policy=$CONTEXT_PROVIDER_POLICY fallback=$CONTEXT_PROVIDER_FALLBACK note=${CONTEXT_PROVIDER_NOTE:-none}"
fi

PROMPT="$(cat "$AGENT_FILE")
${CONTEXT_SECTION}${REVIEW_DEPTH_SECTION}
${TASK_SECTION}${STATUS_SECTION}${PM_SECTION}${PREV_SECTION}

--- OUTPUT PERSISTENCE REQUIREMENT ---
Before you finish, write the complete, valid YAML output to this exact path:
${OUTPUT_FILE}
Overwrite the prior artifact for this role if one exists. Do not merely print the
YAML or verdict in your terminal response: the orchestrator reads the file above
for its handoff. After writing it, validate it with:
ruby \"${OFFICE_DIR}/validate-yaml.rb\" \"${OUTPUT_FILE}\"

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

# Allocate the run id BEFORE the first dispatch event, so prompt_assembly and
# everything after it is attributable to this run.
record_run_start

# --- ownership lease (docs/task-ownership.md) --------------------------------
# Acquire immediately after the run id exists (ownership is keyed to it) and
# before any state is touched. Refusal exits here, leaving the task untouched.
ownership_acquire "$AGENT"
log_meta_event "$TASK_ID" "$META_FILE" "ownership_acquired" "$AGENT" "task=$TASK_LABEL run=${AI_DEV_OFFICE_RUN_ID:-none}"
# -----------------------------------------------------------------------------

log_meta_event "$TASK_ID" "$META_FILE" "prompt_assembly" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$RUNNER phase=${CURRENT_PHASE:-unknown} iteration=$CURRENT_ITERATION sources=$PROMPT_SOURCES"

echo "=== Running $AGENT for $TASK_LABEL (runner: $RUNNER) ==="

RUN_STARTED_AT_EPOCH="$(date +%s)"
INTERACTIVE_RUNNER="false"

RUNNER_STATUS=0
run_runner_with_fallback "$RUNNER" || RUNNER_STATUS=$?
if [[ "$RUNNER_STATUS" -ne 0 ]]; then
  # Blame the runner that actually ran last, not the one we started with.
  record_run_update finish "outcome.status=failed" "outcome.exit_code=$RUNNER_STATUS" "client=${RUNNER_LAST_ATTEMPTED:-$RUNNER}"
  ownership_release "runner failed (exit $RUNNER_STATUS)"
  exit "$RUNNER_STATUS"
fi
# $RUNNER now names the runner that actually succeeded (fallback may have switched it).
record_run_update finish "outcome.status=completed" "outcome.exit_code=0" "client=$RUNNER"

log_meta_event "$TASK_ID" "$META_FILE" "runner_complete" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$RUNNER exit_code=0 output_expected=runs/$TASK_ID/$(basename "$OUTPUT_FILE")"

echo ""
echo "=== $AGENT completed for $TASK_LABEL ==="
echo "Save output to: $OUTPUT_FILE"
if [[ -f "$OUTPUT_FILE" ]]; then
  # S2: portable mtime — BSD/macOS uses `stat -f %m`, GNU/Linux uses `stat -c %Y`.
  OUTPUT_MTIME_EPOCH="$(stat -f "%m" "$OUTPUT_FILE" 2>/dev/null || stat -c "%Y" "$OUTPUT_FILE" 2>/dev/null || echo 0)"
  if [[ "$INTERACTIVE_RUNNER" == "true" && "$OUTPUT_MTIME_EPOCH" -le "$RUN_STARTED_AT_EPOCH" ]]; then
    echo "Output file exists but was not updated in this interactive run."
    echo "Skipping status sync to avoid replaying stale artifacts."
    echo "Complete the run in IDE chat, then re-run this command to sync."
  elif [[ "${AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS:-false}" == "true" ]]; then
    echo "Parallel auto lane output saved; parent auto runner will route to reviewer after all lanes finish."
  else
    # issue #12: record the evidence/risk gate outcome in the run history BEFORE
    # the contract gate, so a `required`-mode block always has its reason logged.
    # This call only reports; validate-yaml.rb is what blocks.
    if [[ "$AGENT" == "reviewer" ]]; then
      GATE_RC=0
      GATE_SUMMARY="$(ruby "$OFFICE_DIR/scripts/review-gate.rb" "$TASK_ID" 2>/dev/null)" || GATE_RC=$?
      if [[ -n "$GATE_SUMMARY" ]]; then
        [[ "$GATE_RC" -eq 1 ]] && GATE_BLOCKING="true" || GATE_BLOCKING="false"
        echo "Review gate: $GATE_SUMMARY"
        log_meta_event "$TASK_ID" "$META_FILE" "reviewer_evidence_policy" "$AGENT" "task=$TASK_LABEL $GATE_SUMMARY blocking=$GATE_BLOCKING"
      fi
    fi
    echo "Enforcing $AGENT output contract..."
    if ruby "$OFFICE_DIR/scripts/enforce-output-contract.rb" "$TASK_ID" "$AGENT"; then
      echo "Syncing status.yaml from $AGENT output..."
      SYNC_RC=0
      sync_status_from_output "$TASK_ID" "$AGENT" "$STATUS_FILE" "$OUTPUT_FILE" "$TODAY" "$REVIEWER_QUEUE_PHASE" || SYNC_RC=$?
      if [[ "$SYNC_RC" -eq 3 ]]; then
        # S1: malformed agent output — route to validation_failed, don't crash/propagate.
        echo "Agent output is malformed YAML; routing to validation_failed (not propagating)."
        force_status_route "$TASK_ID" "$STATUS_FILE" "$TODAY" "free-roam" "validation_failed" "$AGENT" "output could not be parsed during sync"
        record_run_update update "outcome.validation=failed"
        log_meta_event "$TASK_ID" "$META_FILE" "validation_failed" "$AGENT" "task=$TASK_LABEL reason=sync_parse_error output=runs/$TASK_ID/$(basename "$OUTPUT_FILE")"
      elif [[ "$SYNC_RC" -ne 0 ]]; then
        echo "Status sync aborted (rc=$SYNC_RC); see messages above. Not propagating downstream."
        record_run_update update "outcome.validation=failed"
      else
        echo "Validating runtime files..."
        if ruby "$OFFICE_DIR/validate-yaml.rb" "$TASK_ID"; then
          echo "Validation passed."
          record_run_update update "outcome.validation=passed"
        else
          echo "Validation failed. Review the messages above before continuing."
          record_run_update update "outcome.validation=failed"
        fi
      fi
    else
      echo "Output contract failed; phase set to validation_failed. Not propagating downstream."
      record_run_update update "outcome.validation=failed"
      log_meta_event "$TASK_ID" "$META_FILE" "validation_failed" "$AGENT" "task=$TASK_LABEL epic=${TASK_EPIC:-none} runner=$RUNNER phase=${CURRENT_PHASE:-unknown} output=runs/$TASK_ID/$(basename "$OUTPUT_FILE")"
    fi
  fi
else
  echo "Output file not found yet; save it first, then run: ruby \"$OFFICE_DIR/validate-yaml.rb\" \"$TASK_ID\""
  if [[ "$AGENT" == "reviewer" ]]; then
    echo "Reviewer did not produce a fresh reviewer-output.yaml; refusing to reuse a prior verdict or route a handoff."
    log_meta_event "$TASK_ID" "$META_FILE" "reviewer_output_missing" "$AGENT" "task=$TASK_LABEL output=runs/$TASK_ID/reviewer-output.yaml"
    ownership_release "reviewer produced no output"
    exit 1
  fi
fi
ownership_release "dispatch complete"
echo "Validate runtime files with: ruby \"$OFFICE_DIR/validate-yaml.rb\" \"$TASK_ID\""
echo "Then run next agent or use: ./run-agent.sh $TASK_ID auto"
