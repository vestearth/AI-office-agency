#!/usr/bin/env ruby
require "yaml"

OFFICE_DIR = File.expand_path(__dir__)
RUNS_DIR = File.join(OFFICE_DIR, "runs")
AGENTS = %w[pm dev dev-2 reviewer debugger devops free-roam done].freeze
STATUS_ACTORS = (AGENTS + %w[orchestrator]).freeze
PHASES = %w[
  pending blocked assigned assigned_parallel review in_review debugging
  debugging_complete devops_needed devops_complete escalated
  free_roam_complete validation_failed done aborted
].freeze
WORKSTREAMS = %w[frontend backend devops framework docs general].freeze
# Task ids: TASK-NNN (legacy/unprefixed) or TASK-<NS>-NNN where <NS> is an
# uppercase namespace — PKG for package tasks, or a per-user prefix from
# office.config.local.yaml (multi-user git mode). Keep in sync with
# run-agent.sh dir scans, schemas/*.yaml patterns, and dashboard runScanner.
TASK_ID_PATTERN = /^TASK(?:-[A-Z][A-Z0-9]*)?-\d+$/.freeze
TASK_ID_HINT = "TASK-NNN or TASK-<NS>-NNN (e.g. TASK-PKG-001, TASK-EA-001)".freeze

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
rescue Psych::SyntaxError => e
  raise "#{path}: YAML syntax error: #{e.message}"
end

def expect_hash(value, label, errors)
  errors << "#{label} must be a map" unless value.is_a?(Hash)
end

def expect_array(value, label, errors)
  errors << "#{label} must be a list" unless value.is_a?(Array)
end

def expect_string(value, label, errors)
  errors << "#{label} must be a string" unless value.is_a?(String) && !value.strip.empty?
end

def expect_boolean(value, label, errors)
  errors << "#{label} must be a boolean" unless value == true || value == false
end

def expect_string_array(value, label, errors)
  expect_array(value, label, errors)
  Array(value).each_with_index do |entry, index|
    expect_string(entry, "#{label}[#{index}]", errors)
  end
end

def expect_enum(value, allowed, label, errors)
  errors << "#{label} must be one of: #{allowed.join(', ')}" unless allowed.include?(value)
end

def validate_base_output(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  %w[summary artifacts next_action blockers].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  expect_string(data["summary"], "#{label}.summary", errors) if data.key?("summary")

  if data.key?("artifacts")
    expect_array(data["artifacts"], "#{label}.artifacts", errors)
    Array(data["artifacts"]).each_with_index do |artifact, i|
      expect_hash(artifact, "#{label}.artifacts[#{i}]", errors)
      next unless artifact.is_a?(Hash)

      expect_string(artifact["path"], "#{label}.artifacts[#{i}].path", errors)
      if artifact.key?("action")
        expect_enum(artifact["action"], %w[created modified deleted unchanged], "#{label}.artifacts[#{i}].action", errors)
      end
      expect_string(artifact["description"], "#{label}.artifacts[#{i}].description", errors) if artifact.key?("description")

      next unless artifact.key?("issues")
      expect_array(artifact["issues"], "#{label}.artifacts[#{i}].issues", errors)
      Array(artifact["issues"]).each_with_index do |issue, j|
        expect_hash(issue, "#{label}.artifacts[#{i}].issues[#{j}]", errors)
        next unless issue.is_a?(Hash)
        expect_enum(issue["severity"], %w[error warning suggestion], "#{label}.artifacts[#{i}].issues[#{j}].severity", errors)
        expect_string(issue["description"], "#{label}.artifacts[#{i}].issues[#{j}].description", errors)
      end
    end
  end

  if data.key?("next_action")
    expect_hash(data["next_action"], "#{label}.next_action", errors)
    if data["next_action"].is_a?(Hash)
      expect_enum(data["next_action"]["agent"], AGENTS, "#{label}.next_action.agent", errors)
      expect_string(data["next_action"]["reason"], "#{label}.next_action.reason", errors)
    end
  end

  if data.key?("blockers")
    expect_array(data["blockers"], "#{label}.blockers", errors)
  end

  validate_context_sources(data["context_sources"], "#{label}.context_sources", errors) if data.key?("context_sources")
end

def validate_context_sources(value, label, errors)
  expect_hash(value, label, errors)
  return unless value.is_a?(Hash)

  if value.key?("github")
    expect_hash(value["github"], "#{label}.github", errors)
    if value["github"].is_a?(Hash)
      expect_string(value["github"]["branch"], "#{label}.github.branch", errors) if value["github"].key?("branch") && !value["github"]["branch"].to_s.empty?
      expect_string(value["github"]["pr"], "#{label}.github.pr", errors) if value["github"].key?("pr") && !value["github"]["pr"].to_s.empty?
    end
  end

  return unless value.key?("socraticode")

  expect_hash(value["socraticode"], "#{label}.socraticode", errors)
  return unless value["socraticode"].is_a?(Hash)

  expect_enum(value["socraticode"]["status"], %w[used unavailable failed fallback skipped], "#{label}.socraticode.status", errors) if value["socraticode"].key?("status")
  expect_string_array(value["socraticode"]["queries"], "#{label}.socraticode.queries", errors) if value["socraticode"].key?("queries")
  expect_string_array(value["socraticode"]["relevant_symbols"], "#{label}.socraticode.relevant_symbols", errors) if value["socraticode"].key?("relevant_symbols")
  expect_string(value["socraticode"]["notes"], "#{label}.socraticode.notes", errors) if value["socraticode"].key?("notes") && !value["socraticode"]["notes"].to_s.empty?
end

def validate_status(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  %w[task_id phase iteration current_agent].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end
  expect_enum(data["phase"], PHASES, "#{label}.phase", errors) if data["phase"]
  expect_enum(data["state"], PHASES, "#{label}.state", errors) if data.key?("state")
  errors << "#{label}.iteration must be a non-negative integer" unless data["iteration"].is_a?(Integer) && data["iteration"] >= 0

  if data.key?("current_agent") && !data["current_agent"].nil?
    expect_enum(data["current_agent"], AGENTS, "#{label}.current_agent", errors)
  end

  expect_string(data["created_at"], "#{label}.created_at", errors) if data.key?("created_at")
  expect_string(data["updated_at"], "#{label}.updated_at", errors) if data.key?("updated_at")
  expect_string(data["decision_applied_at"], "#{label}.decision_applied_at", errors) if data.key?("decision_applied_at")
  expect_boolean(data["ready"], "#{label}.ready", errors) if data.key?("ready")

  if data.key?("blocked_on")
    expect_string_array(data["blocked_on"], "#{label}.blocked_on", errors)
    Array(data["blocked_on"]).each_with_index do |task_id, index|
      next unless task_id.is_a?(String) && !task_id.strip.empty?
      unless task_id.match?(TASK_ID_PATTERN)
        errors << "#{label}.blocked_on[#{index}] must match #{TASK_ID_HINT}"
      end
    end
  end

  expect_string_array(data["waiting_for"], "#{label}.waiting_for", errors) if data.key?("waiting_for")

  # N4: history is the only place transitions are recorded — validate its shape.
  if data.key?("history")
    expect_array(data["history"], "#{label}.history", errors)
    Array(data["history"]).each_with_index do |entry, index|
      if entry.is_a?(Hash)
        %w[phase agent reason].each do |key|
          expect_string(entry[key], "#{label}.history[#{index}].#{key}", errors)
        end
      else
        errors << "#{label}.history[#{index}] must be a map"
      end
    end
  end

  if data.key?("handoff")
    expect_hash(data["handoff"], "#{label}.handoff", errors)
    if data["handoff"].is_a?(Hash)
      expect_enum(data["handoff"]["from"], STATUS_ACTORS, "#{label}.handoff.from", errors)
      expect_enum(data["handoff"]["to"], AGENTS, "#{label}.handoff.to", errors)
      expect_string(data["handoff"]["artifact"], "#{label}.handoff.artifact", errors)
    end
  end

  return unless data.key?("assignment")
  expect_hash(data["assignment"], "#{label}.assignment", errors)
  return unless data["assignment"].is_a?(Hash)

  expect_enum(data["assignment"]["primary"], AGENTS - ["done"], "#{label}.assignment.primary", errors)
  expect_boolean(data["assignment"]["parallel"], "#{label}.assignment.parallel", errors)
end

def validate_meta(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  %w[task_id events].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end

  expect_string(data["updated_at"], "#{label}.updated_at", errors) if data.key?("updated_at")

  expect_array(data["events"], "#{label}.events", errors) if data.key?("events")
  Array(data["events"]).each_with_index do |event, index|
    expect_hash(event, "#{label}.events[#{index}]", errors)
    next unless event.is_a?(Hash)

    expect_string(event["type"], "#{label}.events[#{index}].type", errors)
    expect_enum(event["agent"], STATUS_ACTORS, "#{label}.events[#{index}].agent", errors)
    expect_string(event["details"], "#{label}.events[#{index}].details", errors)
    expect_string(event["timestamp"], "#{label}.events[#{index}].timestamp", errors)
  end
end

def validate_pm_output(data, label, errors)
  validate_base_output(data, label, errors)
  %w[task scope description acceptance_criteria plan assignment].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task"].is_a?(Hash)
    expect_string(data["task"]["id"], "#{label}.task.id", errors)
    expect_string(data["task"]["title"], "#{label}.task.title", errors)
    expect_string(data["task"]["short_name"], "#{label}.task.short_name", errors) if data["task"].key?("short_name")
    if data["task"].key?("parent")
      expect_string(data["task"]["parent"], "#{label}.task.parent", errors)
      unless data["task"]["parent"].to_s.match?(TASK_ID_PATTERN)
        errors << "#{label}.task.parent must match #{TASK_ID_HINT}"
      end
    end
    expect_string(data["task"]["epic"], "#{label}.task.epic", errors) if data["task"].key?("epic")
    expect_enum(data["task"]["type"], %w[feature bugfix refactor investigation devops], "#{label}.task.type", errors)
    expect_enum(data["task"]["workstream"], WORKSTREAMS, "#{label}.task.workstream", errors) if data["task"].key?("workstream")
    expect_enum(data["task"]["priority"], %w[low medium high critical], "#{label}.task.priority", errors)
  else
    errors << "#{label}.task must be a map"
  end

  if data["assignment"].is_a?(Hash)
    expect_enum(data["assignment"]["primary"], %w[dev dev-2], "#{label}.assignment.primary", errors)
    expect_boolean(data["assignment"]["parallel"], "#{label}.assignment.parallel", errors)
    expect_string(data["assignment"]["reason"], "#{label}.assignment.reason", errors)
  else
    errors << "#{label}.assignment must be a map"
  end

  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[dev dev-2 free-roam], "#{label}.next_action.agent", errors)
  end
end

def validate_dev_output(data, label, errors)
  validate_base_output(data, label, errors)
  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[reviewer dev-2 free-roam], "#{label}.next_action.agent", errors)
  end
end

def validate_dev_2_output(data, label, errors)
  validate_base_output(data, label, errors)
  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[reviewer free-roam], "#{label}.next_action.agent", errors)
  end
end

def validate_reviewer_output(data, label, errors)
  if data.is_a?(Hash) && data.key?("checks") && !data.key?("build_check")
    errors << "#{label} uses a legacy reviewer format; expected build_check and artifacts per reviewer-output.schema.yaml"
    return
  end

  validate_base_output(data, label, errors)
  expect_enum(data["review_verdict"], %w[approved changes_requested escalate infra_failure], "#{label}.review_verdict", errors)

  if data["build_check"].is_a?(Hash)
    expect_enum(data["build_check"]["compile"], %w[pass fail skipped], "#{label}.build_check.compile", errors)
    expect_enum(data["build_check"]["tests"], %w[pass fail skipped], "#{label}.build_check.tests", errors)
    expect_string(data["build_check"]["details"], "#{label}.build_check.details", errors)
  else
    errors << "#{label}.build_check must be a map"
  end

  if data.key?("transition")
    if data["transition"].is_a?(Hash)
      expect_enum(data["transition"]["from_phase"], %w[review in_review], "#{label}.transition.from_phase", errors)
      expect_enum(data["transition"]["to_phase"], %w[done debugging escalated devops_needed], "#{label}.transition.to_phase", errors)
    else
      errors << "#{label}.transition must be a map"
    end
  end
end

def validate_debugger_output(data, label, errors)
  validate_base_output(data, label, errors)

  if data["diagnosis"].is_a?(Hash)
    expect_string(data["diagnosis"]["root_cause"], "#{label}.diagnosis.root_cause", errors)
    expect_enum(data["diagnosis"]["confidence"], %w[high medium low], "#{label}.diagnosis.confidence", errors)
    expect_array(data["diagnosis"]["affected_files"], "#{label}.diagnosis.affected_files", errors)
  else
    errors << "#{label}.diagnosis must be a map"
  end

  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[dev reviewer free-roam], "#{label}.next_action.agent", errors)
  end
end

def validate_devops_output(data, label, errors)
  validate_base_output(data, label, errors)
  expect_array(data["infra_checks"], "#{label}.infra_checks", errors)
  Array(data["infra_checks"]).each_with_index do |check, i|
    expect_hash(check, "#{label}.infra_checks[#{i}]", errors)
    next unless check.is_a?(Hash)
    expect_string(check["check"], "#{label}.infra_checks[#{i}].check", errors)
    expect_enum(check["result"], %w[pass fail], "#{label}.infra_checks[#{i}].result", errors)
    expect_string(check["details"], "#{label}.infra_checks[#{i}].details", errors)
  end

  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[reviewer done free-roam], "#{label}.next_action.agent", errors)
  end
end

def validate_free_roam_output(data, label, errors)
  validate_base_output(data, label, errors)

  if data["decision"].is_a?(Hash)
    expect_enum(data["decision"]["action"], %w[fix split reroute abort], "#{label}.decision.action", errors)
    expect_string(data["decision"]["details"], "#{label}.decision.details", errors)
    if data["decision"].key?("sub_tasks")
      expect_array(data["decision"]["sub_tasks"], "#{label}.decision.sub_tasks", errors)
      Array(data["decision"]["sub_tasks"]).each_with_index do |sub_task, i|
        expect_hash(sub_task, "#{label}.decision.sub_tasks[#{i}]", errors)
        next unless sub_task.is_a?(Hash)
        expect_string(sub_task["id"], "#{label}.decision.sub_tasks[#{i}].id", errors)
        expect_string(sub_task["title"], "#{label}.decision.sub_tasks[#{i}].title", errors)
        expect_enum(sub_task["assigned_agent"], %w[dev dev-2], "#{label}.decision.sub_tasks[#{i}].assigned_agent", errors)
      end
    end
  else
    errors << "#{label}.decision must be a map"
  end

  if data["next_action"].is_a?(Hash)
    expect_enum(data["next_action"]["agent"], %w[dev dev-2 reviewer debugger devops pm done], "#{label}.next_action.agent", errors)
  end
end

def validate_output_file(path, errors)
  data = load_yaml(path)
  label = File.basename(path)
  case label
  when "pm-output.yaml"
    validate_pm_output(data, label, errors)
  when "dev-output.yaml"
    validate_dev_output(data, label, errors)
  when "dev-2-output.yaml"
    validate_dev_2_output(data, label, errors)
  when "reviewer-output.yaml"
    validate_reviewer_output(data, label, errors)
  when "debugger-output.yaml"
    validate_debugger_output(data, label, errors)
  when "devops-output.yaml"
    validate_devops_output(data, label, errors)
  when "free-roam-output.yaml"
    validate_free_roam_output(data, label, errors)
  when "knowledge-capture-output.yaml"
    validate_knowledge_capture(data, label, errors)
  else
    validate_base_output(data, label, errors)
  end
rescue => e
  errors << e.message
end

DECISION_ACTIONS = %w[approve request_changes escalate reject].freeze
DECISION_VERDICTS = %w[approved changes_requested escalate infra_failure].freeze

CAPTURE_TYPES = %w[decision lesson concept flow project_note inbox].freeze
CAPTURE_ACTIONS = %w[create_note update_note add_to_inbox skip].freeze

# Suggest-only knowledge-base capture proposal produced by the knowledge-capturer
# agent / knowledge-capture workflow. Mirrors
# schemas/knowledge-capture-output.schema.json; kept as a shape check (no JSON
# Schema gem) to match the rest of this validator. The two invariants that keep
# the contract honest are enforced explicitly: at least one source, and
# requires_human_review must stay true (no auto-write path).
def validate_knowledge_capture(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  %w[task_id capture_type target_repo target_note summary sources recommended_action requires_human_review note_patch].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end
  expect_enum(data["capture_type"], CAPTURE_TYPES, "#{label}.capture_type", errors) if data.key?("capture_type")
  if data.key?("target_repo") && data["target_repo"] != "knowledge-base"
    errors << "#{label}.target_repo must be \"knowledge-base\""
  end
  expect_string(data["target_note"], "#{label}.target_note", errors) if data.key?("target_note")
  expect_string(data["summary"], "#{label}.summary", errors) if data.key?("summary")
  if data.key?("sources")
    expect_string_array(data["sources"], "#{label}.sources", errors)
    errors << "#{label}.sources must list at least one source" if data["sources"].is_a?(Array) && data["sources"].empty?
  end
  expect_enum(data["recommended_action"], CAPTURE_ACTIONS, "#{label}.recommended_action", errors) if data.key?("recommended_action")
  if data.key?("requires_human_review") && data["requires_human_review"] != true
    errors << "#{label}.requires_human_review must be true (capture output is suggest-only)"
  end
  # note_patch may be an empty string (e.g. a recorded skip), so allow "" but require a string.
  if data.key?("note_patch") && !data["note_patch"].is_a?(String)
    errors << "#{label}.note_patch must be a string"
  end
end

def validate_decision(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  expect_string(data["task_id"], "#{label}.task_id", errors)
  expect_array(data["decisions"], "#{label}.decisions", errors)
  Array(data["decisions"]).each_with_index do |entry, i|
    expect_hash(entry, "#{label}.decisions[#{i}]", errors)
    next unless entry.is_a?(Hash)
    expect_enum(entry["decision"], DECISION_ACTIONS, "#{label}.decisions[#{i}].decision", errors)
    expect_string(entry["actor"], "#{label}.decisions[#{i}].actor", errors)
    expect_string(entry["decided_at"], "#{label}.decisions[#{i}].decided_at", errors)
    if entry.key?("against_verdict") && !entry["against_verdict"].nil?
      expect_enum(entry["against_verdict"], DECISION_VERDICTS, "#{label}.decisions[#{i}].against_verdict", errors)
    end
  end
end

def validate_task_dir(task_dir, errors)
  status_file = File.join(task_dir, "status.yaml")
  if File.exist?(status_file)
    validate_status(load_yaml(status_file), "status.yaml", errors)
  else
    errors << "#{task_dir}: missing status.yaml"
  end

  meta_file = File.join(task_dir, "meta.yaml")
  validate_meta(load_yaml(meta_file), "meta.yaml", errors) if File.exist?(meta_file)

  Dir.glob(File.join(task_dir, "*-output.yaml")).sort.each do |path|
    validate_output_file(path, errors)
  end

  decision_file = File.join(task_dir, "decision.yaml")
  validate_decision(load_yaml(decision_file), "decision.yaml", errors) if File.exist?(decision_file)

  return unless File.exist?(status_file)

  status = load_yaml(status_file)
  if status.is_a?(Hash) && status["state"] && status["phase"] && status["state"] != status["phase"]
    errors << "status.yaml.state must match status.yaml.phase when both are present"
  end

  # A `blocked` task must say WHAT it is waiting on, otherwise the phase is
  # incoherent (blocked on nothing). This also stops finished work from sitting
  # in `blocked`: completed work awaiting a human merge/review is `in_review`
  # (then `done` once merged), and `blocked` is reserved for genuinely stuck /
  # dependency-gated tasks. The message carries the convention so any runner
  # agent — regardless of which AI executes it — learns it on the spot.
  if status.is_a?(Hash) && [status["phase"], status["state"]].include?("blocked")
    blocked_on = Array(status["blocked_on"]).reject { |x| x.to_s.strip.empty? }
    waiting_for = Array(status["waiting_for"]).reject { |x| x.to_s.strip.empty? }
    if blocked_on.empty? && waiting_for.empty?
      errors << "status.yaml: phase/state 'blocked' requires a non-empty blocked_on or " \
                "waiting_for (blocked must name what it is waiting on). Finished work " \
                "awaiting a human merge/review is 'in_review' (then 'done' once merged), " \
                "not 'blocked'."
    end
  end
end

target = ARGV[0]
if target.nil? || target.strip.empty?
  warn "Usage: ruby ai-dev-office/validate-yaml.rb <TASK_ID | path-to-task-dir | path-to-yaml>"
  exit 1
end

target_path =
  if File.exist?(target)
    File.expand_path(target)
  else
    File.expand_path(File.join(RUNS_DIR, target))
  end

errors = []

if File.directory?(target_path)
  validate_task_dir(target_path, errors)
elsif File.file?(target_path)
  basename = File.basename(target_path)
  if basename == "status.yaml"
    validate_status(load_yaml(target_path), basename, errors)
  elsif basename == "meta.yaml"
    validate_meta(load_yaml(target_path), basename, errors)
  elsif basename == "decision.yaml"
    validate_decision(load_yaml(target_path), basename, errors)
  else
    validate_output_file(target_path, errors)
  end
else
  warn "Target not found: #{target}"
  exit 1
end

if errors.empty?
  puts "Validation passed: #{target}"
  exit 0
end

warn "Validation failed: #{target}"
errors.each { |error| warn " - #{error}" }
exit 1
