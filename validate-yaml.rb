#!/usr/bin/env ruby
require "yaml"

OFFICE_DIR = File.expand_path(__dir__)
RUNS_DIR = File.join(OFFICE_DIR, "runs")
AGENTS = %w[pm dev dev-2 reviewer debugger devops free-roam done].freeze
PHASES = %w[
  pending assigned assigned_parallel review debugging debugging_complete
  devops_needed devops_complete escalated free_roam_complete done aborted
].freeze

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
end

def validate_status(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  %w[task_id phase iteration current_agent].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task_id"]
    errors << "#{label}.task_id must match TASK-NNN or TASK-PKG-NNN" unless data["task_id"].is_a?(String) && data["task_id"].match?(/^TASK(?:-PKG)?-\d+$/)
  end
  expect_enum(data["phase"], PHASES, "#{label}.phase", errors) if data["phase"]
  errors << "#{label}.iteration must be a non-negative integer" unless data["iteration"].is_a?(Integer) && data["iteration"] >= 0

  if data.key?("current_agent") && !data["current_agent"].nil?
    expect_enum(data["current_agent"], AGENTS, "#{label}.current_agent", errors)
  end

  return unless data.key?("assignment")
  expect_hash(data["assignment"], "#{label}.assignment", errors)
  return unless data["assignment"].is_a?(Hash)

  expect_enum(data["assignment"]["primary"], AGENTS - ["done"], "#{label}.assignment.primary", errors)
  expect_boolean(data["assignment"]["parallel"], "#{label}.assignment.parallel", errors)
end

def validate_pm_output(data, label, errors)
  validate_base_output(data, label, errors)
  %w[task scope description acceptance_criteria plan assignment].each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  if data["task"].is_a?(Hash)
    expect_string(data["task"]["id"], "#{label}.task.id", errors)
    expect_string(data["task"]["title"], "#{label}.task.title", errors)
    expect_enum(data["task"]["type"], %w[feature bugfix refactor investigation devops], "#{label}.task.type", errors)
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

def validate_reviewer_output(data, label, errors)
  if data.is_a?(Hash) && data.key?("checks") && !data.key?("build_check")
    errors << "#{label} uses a legacy reviewer format; expected build_check and artifacts per reviewer-output.schema.yaml"
    return
  end

  validate_base_output(data, label, errors)
  expect_enum(data["review_verdict"], %w[approved changes_requested escalate], "#{label}.review_verdict", errors)

  if data["build_check"].is_a?(Hash)
    expect_enum(data["build_check"]["compile"], %w[pass fail], "#{label}.build_check.compile", errors)
    expect_enum(data["build_check"]["tests"], %w[pass fail skipped], "#{label}.build_check.tests", errors)
    expect_string(data["build_check"]["details"], "#{label}.build_check.details", errors)
  else
    errors << "#{label}.build_check must be a map"
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
  when "reviewer-output.yaml"
    validate_reviewer_output(data, label, errors)
  when "debugger-output.yaml"
    validate_debugger_output(data, label, errors)
  when "devops-output.yaml"
    validate_devops_output(data, label, errors)
  when "free-roam-output.yaml"
    validate_free_roam_output(data, label, errors)
  else
    validate_base_output(data, label, errors)
  end
rescue => e
  errors << e.message
end

def validate_task_dir(task_dir, errors)
  status_file = File.join(task_dir, "status.yaml")
  if File.exist?(status_file)
    validate_status(load_yaml(status_file), "status.yaml", errors)
  else
    errors << "#{task_dir}: missing status.yaml"
  end

  Dir.glob(File.join(task_dir, "*-output.yaml")).sort.each do |path|
    validate_output_file(path, errors)
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
