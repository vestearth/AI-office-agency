#!/usr/bin/env ruby
require "yaml"
require "digest"
require "time"

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
# Execution evidence (schemas/evidence.schema.yaml, docs/evidence-contract.md).
# Ids are ev-NNN, allocated by scripts/record-evidence.sh, unique per task.
EVIDENCE_TYPES = %w[command test build static_check artifact].freeze
EVIDENCE_ID_PATTERN = /^ev-\d{3,}$/.freeze
EVIDENCE_ID_HINT = "ev-NNN (e.g. ev-001)".freeze
# Portable repo identity from the origin remote (owner/repo, subgroups kept).
# Nullable: a repo with no origin has no identity to record.
REPO_ORIGIN_PATTERN = %r{^[^\s/]+(/[^\s/]+)+$}.freeze
REPO_ORIGIN_HINT = "owner/repo (e.g. SparqLab/missions), or null".freeze

# Run identity (see docs/run-records.md). Records live in
# runs/<task-id>/run-records/<run_id>.yaml, one per agent execution.
# Grammar: run-<YYYYMMDDTHHMMSSZ>-<task-id>-<role>-<nonce>. Keep in sync with
# scripts/record-run.rb, schemas/run-record.schema.yaml and the docs.
RUN_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
RUN_OUTCOME_STATUSES = %w[running completed failed].freeze
RUN_VALIDATION_RESULTS = %w[passed failed].freeze
RUN_USAGE_KEYS = %w[input_tokens output_tokens cache_read cache_write tool_calls validation_rounds].freeze
RUN_ID_PATTERN = /
  ^run-\d{8}T\d{6}Z-
  (TASK(?:-[A-Z][A-Z0-9]*)?-\d+)-
  (pm|dev-2|dev|reviewer|debugger|devops|free-roam)-
  [0-9a-z]{6}$
/x.freeze
RUN_ID_HINT = "run-<YYYYMMDDTHHMMSSZ>-<task-id>-<role>-<6 char nonce>".freeze

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

  # Optional — existing outputs carry no evidence_refs and must keep validating.
  # Shape only here; the ids are resolved against evidence.yaml in
  # validate_output_file, which knows the task dir.
  validate_evidence_ref_shape(data["evidence_refs"], "#{label}.evidence_refs", errors) if data.key?("evidence_refs")

  return unless data.key?("claims")
  expect_array(data["claims"], "#{label}.claims", errors)
  Array(data["claims"]).each_with_index do |claim, i|
    expect_hash(claim, "#{label}.claims[#{i}]", errors)
    next unless claim.is_a?(Hash) && claim.key?("evidence_refs")
    validate_evidence_ref_shape(claim["evidence_refs"], "#{label}.claims[#{i}].evidence_refs", errors)
  end
end

def validate_evidence_ref_shape(value, label, errors)
  expect_string_array(value, label, errors)
  Array(value).each_with_index do |ref, index|
    next unless ref.is_a?(String)
    errors << "#{label}[#{index}] must match #{EVIDENCE_ID_HINT}" unless ref.match?(EVIDENCE_ID_PATTERN)
  end
end

# Every evidence_refs entry (top level or per claim) must resolve to an id in
# THIS task's evidence.yaml — a ref to a missing or foreign task's evidence is a
# fabricated citation and fails validation.
def validate_evidence_refs_resolve(data, label, task_dir, errors)
  return unless data.is_a?(Hash)

  refs = Array(data["evidence_refs"]).select { |r| r.is_a?(String) }
  Array(data["claims"]).each do |claim|
    refs.concat(Array(claim["evidence_refs"]).select { |r| r.is_a?(String) }) if claim.is_a?(Hash)
  end
  return if refs.empty?

  evidence_path = File.join(task_dir, "evidence.yaml")
  unless File.exist?(evidence_path)
    errors << "#{label}.evidence_refs references evidence but #{evidence_path} does not exist"
    return
  end

  ledger = load_yaml(evidence_path)
  known = (ledger.is_a?(Hash) ? Array(ledger["evidence"]) : []).map { |e| e["id"] if e.is_a?(Hash) }.compact
  refs.uniq.each do |ref|
    errors << "#{label}.evidence_refs: unknown evidence id '#{ref}' (not in evidence.yaml)" unless known.include?(ref)
  end
end

# runs/<task>/evidence.yaml — see schemas/evidence.schema.yaml. The hash of every
# artifact is RECOMPUTED here: that is what makes a fabricated or edited log fail
# instead of being taken on trust.
def validate_evidence(data, label, task_dir, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end

  unless data["evidence"].is_a?(Array)
    errors << "#{label}.evidence must be a list"
    return
  end

  strict_sha = ENV["EVIDENCE_STRICT_SHA"] == "1"
  seen = {}

  data["evidence"].each_with_index do |entry, i|
    entry_label = "#{label}.evidence[#{i}]"
    expect_hash(entry, entry_label, errors)
    next unless entry.is_a?(Hash)

    %w[id type command exit_code repo repo_origin repo_sha working_tree_dirty executed_at artifact_path artifact_sha256].each do |key|
      errors << "#{entry_label}.#{key} is required" unless entry.key?(key)
    end

    if entry.key?("id")
      if entry["id"].is_a?(String) && entry["id"].match?(EVIDENCE_ID_PATTERN)
        errors << "#{entry_label}.id '#{entry['id']}' is duplicated (ids must be unique within a task)" if seen.key?(entry["id"])
        seen[entry["id"]] = true
      else
        errors << "#{entry_label}.id must match #{EVIDENCE_ID_HINT}"
      end
    end

    # Foreign key into this task's run-records/. Optional and nullable: records
    # written before the join carry no key, and a wrapper invoked outside a
    # dispatch records null — both keep validating. A non-null id must resolve to
    # a real record of THIS task, exactly as a dangling evidence_refs id fails.
    # The store not existing is not an excuse: it is only tolerated while nothing
    # points into it (a legacy task predating run records).
    if entry.key?("run_id") && !entry["run_id"].nil?
      if entry["run_id"].is_a?(String) && entry["run_id"].match?(RUN_ID_PATTERN)
        record_path = File.join(task_dir, "run-records", "#{entry['run_id']}.yaml")
        unless File.file?(record_path)
          errors << "#{entry_label}.run_id: unknown run id '#{entry['run_id']}' (no #{record_path})"
        end
      else
        errors << "#{entry_label}.run_id must match #{RUN_ID_HINT}, or be null"
      end
    end

    expect_enum(entry["type"], EVIDENCE_TYPES, "#{entry_label}.type", errors) if entry.key?("type")
    expect_string(entry["command"], "#{entry_label}.command", errors) if entry.key?("command")
    errors << "#{entry_label}.exit_code must be an integer" if entry.key?("exit_code") && !entry["exit_code"].is_a?(Integer)
    expect_string(entry["repo"], "#{entry_label}.repo", errors) if entry.key?("repo")
    if entry.key?("repo_origin") && !entry["repo_origin"].nil?
      unless entry["repo_origin"].is_a?(String) && entry["repo_origin"].match?(REPO_ORIGIN_PATTERN)
        errors << "#{entry_label}.repo_origin must be #{REPO_ORIGIN_HINT}"
      end
    end
    expect_string(entry["repo_sha"], "#{entry_label}.repo_sha", errors) if entry.key?("repo_sha")
    expect_boolean(entry["working_tree_dirty"], "#{entry_label}.working_tree_dirty", errors) if entry.key?("working_tree_dirty")

    if entry.key?("executed_at")
      begin
        Time.iso8601(entry["executed_at"].to_s)
      rescue ArgumentError, TypeError
        errors << "#{entry_label}.executed_at must be an ISO-8601 timestamp (e.g. 2026-08-15T04:05:06Z)"
      end
    end

    if entry["artifact_path"].is_a?(String) && !entry["artifact_path"].strip.empty?
      artifact = File.expand_path(entry["artifact_path"], task_dir)
      if File.file?(artifact)
        actual = Digest::SHA256.file(artifact).hexdigest
        if entry["artifact_sha256"] != actual
          errors << "#{entry_label}.artifact_sha256 does not match #{entry['artifact_path']} " \
                    "(recorded #{entry['artifact_sha256']}, actual #{actual}) — the artifact was " \
                    "modified or the record was fabricated"
        end
      else
        errors << "#{entry_label}.artifact_path not found: #{entry['artifact_path']}"
      end
    elsif entry.key?("artifact_path")
      expect_string(entry["artifact_path"], "#{entry_label}.artifact_path", errors)
    end

    # Staleness is provenance drift, not corruption: checked only under the
    # strict flag so re-validating a finished task later never starts failing.
    next unless strict_sha
    # An empty repo already emits its own error; without this guard `git -C ""`
    # resolves against the validator's cwd and reports an unrelated repo's sha.
    next unless entry["repo"].is_a?(String) && !entry["repo"].strip.empty?
    next unless entry["repo_sha"].is_a?(String)
    next if entry["repo_sha"] == "unknown"
    head = begin
      IO.popen(["git", "-C", entry["repo"], "rev-parse", "HEAD"], err: File::NULL, &:read).to_s.strip
    rescue SystemCallError
      ""
    end
    next if head.empty?
    if head != entry["repo_sha"]
      errors << "#{entry_label}.repo_sha #{entry['repo_sha']} is stale (HEAD of #{entry['repo']} is #{head}) [EVIDENCE_STRICT_SHA=1]"
    end
  end
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

    # Attribution to the run that emitted the event. Absent on events logged
    # outside a dispatch (and on every event predating run identity).
    next unless event.key?("run_id") && !event["run_id"].nil?
    unless event["run_id"].is_a?(String) && event["run_id"].match?(RUN_ID_PATTERN)
      errors << "#{label}.events[#{index}].run_id must match #{RUN_ID_HINT}"
    end
  end
end

# One canonical record per agent execution: runs/<task-id>/run-records/<id>.yaml.
# Identity fields are required but nullable — the harness records what it can
# observe and leaves the rest null rather than guessing. `usage` is optional
# because the Codex/Cursor CLIs do not report token telemetry; a missing usage
# block is a normal run, never an error.
def validate_run_record(data, label, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  (%w[run_id task_id role started_at outcome] + %w[
    completed_at client model_requested model_observed harness_version
    skill_version instruction_sha repo_sha mcp_profile
  ]).each do |key|
    errors << "#{label}.#{key} is required" unless data.key?(key)
  end

  match = data["run_id"].is_a?(String) ? RUN_ID_PATTERN.match(data["run_id"]) : nil
  if match.nil?
    errors << "#{label}.run_id must match #{RUN_ID_HINT}"
  else
    errors << "#{label}.run_id must embed task_id (#{data['task_id']})" if data["task_id"] != match[1]
    errors << "#{label}.run_id must embed role (#{data['role']})" if data["role"] != match[2]
  end

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end
  expect_enum(data["role"], RUN_ROLES, "#{label}.role", errors) if data.key?("role")
  expect_string(data["started_at"], "#{label}.started_at", errors) if data.key?("started_at")

  # Nullable identity fields: present-and-null is the contract for "not observable".
  (%w[completed_at] + %w[
    client model_requested model_observed harness_version skill_version
    instruction_sha repo_sha mcp_profile
  ]).each do |key|
    next unless data.key?(key) && !data[key].nil?
    expect_string(data[key], "#{label}.#{key}", errors)
  end

  if data.key?("outcome")
    expect_hash(data["outcome"], "#{label}.outcome", errors)
    if data["outcome"].is_a?(Hash)
      expect_enum(data["outcome"]["status"], RUN_OUTCOME_STATUSES, "#{label}.outcome.status", errors)
      if !data["outcome"]["exit_code"].nil? && !data["outcome"]["exit_code"].is_a?(Integer)
        errors << "#{label}.outcome.exit_code must be an integer or null"
      end
      unless data["outcome"]["validation"].nil?
        expect_enum(data["outcome"]["validation"], RUN_VALIDATION_RESULTS, "#{label}.outcome.validation", errors)
      end
    end
  end

  return unless data.key?("usage")

  expect_hash(data["usage"], "#{label}.usage", errors)
  return unless data["usage"].is_a?(Hash)

  data["usage"].each do |key, value|
    unless RUN_USAGE_KEYS.include?(key)
      errors << "#{label}.usage.#{key} is not a known usage field (#{RUN_USAGE_KEYS.join(', ')})"
      next
    end
    next if value.nil?
    errors << "#{label}.usage.#{key} must be a non-negative integer" unless value.is_a?(Integer) && value >= 0
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
    validate_knowledge_provenance(data, label, File.dirname(path), errors)
  else
    validate_base_output(data, label, errors)
  end

  validate_evidence_refs_resolve(data, label, File.dirname(path), errors)
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

# --- knowledge provenance & stale-evidence invalidation (issue #15) ---------
#
# Two additions, both OPTIONAL and both inert on every run that predates them:
#
#   1. knowledge-capture-output.yaml may carry a `provenance:` block naming the
#      task / run / evidence the captured claim rests on. Field names and the
#      freshness vocabulary are consumed VERBATIM from the canonical vault
#      contract (knowledge-base "Knowledge Base/Provenance And Freshness.md") so
#      the block survives promotion into a note's frontmatter untransformed.
#      No provenance block at all reads as `unknown`, never as a rejection.
#
#   2. runs/<task-id>/evidence-freshness.yaml is an append-only ledger of
#      operator marks that degrade a piece of evidence. It is the ONLY thing
#      that can move evidence out of the unmarked default — there is no clock
#      and no HEAD comparison here. `repo_sha` stays provenance, not liveness
#      (see docs/evidence-contract.md); EVIDENCE_STRICT_SHA=1 remains the only
#      opt-in sha check and this feature does not touch it.
#
# The one enforcement: a capture output may not declare `freshness: current`
# while citing evidence a mark has degraded. Everything else about the record is
# left alone — degraded knowledge is surfaced, never deleted or hidden.
# Docs: docs/knowledge-provenance.md   Schema: schemas/evidence-freshness.schema.yaml
FRESHNESS_STATES = %w[current unknown maybe_stale stale invalid historical].freeze
FRESHNESS_MARK_STATES = %w[maybe_stale stale invalid].freeze
FRESHNESS_CONFIDENCE = %w[high medium low].freeze
PROVENANCE_KEYS = %w[freshness verified_at task_id run_id evidence_refs repo_origin repo_sha confidence].freeze
VERIFIED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/.freeze
PROV_REPO_SHA_PATTERN = /^(?:[0-9a-f]{40}|unknown)$/.freeze

# runs/<task-id>/evidence-freshness.yaml — written only by
# scripts/mark-evidence-stale.rb. Absent on every task that never marked
# anything, which is the overwhelming majority; absence is not an error.
def validate_evidence_freshness(data, label, task_dir, errors)
  expect_hash(data, label, errors)
  return unless data.is_a?(Hash)

  if data["task_id"]
    errors << "#{label}.task_id must match #{TASK_ID_HINT}" unless data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN)
  end

  unless data["marks"].is_a?(Array)
    errors << "#{label}.marks must be a list"
    return
  end

  known = known_evidence_ids(task_dir)

  data["marks"].each_with_index do |mark, i|
    mark_label = "#{label}.marks[#{i}]"
    expect_hash(mark, mark_label, errors)
    next unless mark.is_a?(Hash)

    %w[evidence_id state marked_at marked_by reason].each do |key|
      errors << "#{mark_label}.#{key} is required" unless mark.key?(key)
    end

    # A mark names evidence of THIS task — ev-NNN ids are task-scoped, so a
    # dangling id fails exactly as a dangling evidence_refs id does.
    if mark.key?("evidence_id")
      if mark["evidence_id"].is_a?(String) && mark["evidence_id"].match?(EVIDENCE_ID_PATTERN)
        unless known.include?(mark["evidence_id"])
          errors << "#{mark_label}.evidence_id: unknown evidence id '#{mark['evidence_id']}' (not in evidence.yaml)"
        end
      else
        errors << "#{mark_label}.evidence_id must match #{EVIDENCE_ID_HINT}"
      end
    end

    # Only degrading states are markable. There is deliberately no `current`
    # mark: re-verification produces a NEW evidence record, it does not rewrite
    # the standing of an old one.
    expect_enum(mark["state"], FRESHNESS_MARK_STATES, "#{mark_label}.state", errors) if mark.key?("state")
    expect_string(mark["marked_at"], "#{mark_label}.marked_at", errors) if mark.key?("marked_at")
    expect_string(mark["marked_by"], "#{mark_label}.marked_by", errors) if mark.key?("marked_by")
    if mark.key?("reason")
      expect_string(mark["reason"], "#{mark_label}.reason", errors)
      errors << "#{mark_label}.reason must say why (a mark with no reason is not reviewable)" if mark["reason"].is_a?(String) && mark["reason"].strip.empty?
    end

    next unless mark.key?("run_id") && !mark["run_id"].nil?

    if mark["run_id"].is_a?(String) && mark["run_id"].match?(RUN_ID_PATTERN)
      record_path = File.join(task_dir, "run-records", "#{mark['run_id']}.yaml")
      errors << "#{mark_label}.run_id: unknown run id '#{mark['run_id']}' (no #{record_path})" unless File.file?(record_path)
    else
      errors << "#{mark_label}.run_id must match #{RUN_ID_HINT}, or be null"
    end
  end
end

def known_evidence_ids(task_dir)
  path = File.join(task_dir, "evidence.yaml")
  return [] unless File.exist?(path)

  ledger = load_yaml(path)
  (ledger.is_a?(Hash) ? Array(ledger["evidence"]) : []).map { |e| e["id"] if e.is_a?(Hash) }.compact
rescue StandardError
  []
end

# The mark that is in force for each evidence id: last write wins, because the
# ledger is append-only history and a later operator judgment supersedes an
# earlier one. Pure function of the file — no repo I/O, no clock.
def evidence_freshness_marks(task_dir)
  path = File.join(task_dir, "evidence-freshness.yaml")
  return {} unless File.exist?(path)

  doc = load_yaml(path)
  return {} unless doc.is_a?(Hash) && doc["marks"].is_a?(Array)

  doc["marks"].each_with_object({}) do |mark, acc|
    next unless mark.is_a?(Hash) && mark["evidence_id"].is_a?(String)
    next unless FRESHNESS_MARK_STATES.include?(mark["state"])
    acc[mark["evidence_id"]] = mark
  end
rescue StandardError
  {}
end

def validate_knowledge_provenance(data, label, task_dir, errors)
  return unless data.is_a?(Hash) && data.key?("provenance")

  prov = data["provenance"]
  expect_hash(prov, "#{label}.provenance", errors)
  return unless prov.is_a?(Hash)

  (prov.keys - PROVENANCE_KEYS).each do |key|
    errors << "#{label}.provenance.#{key} is not a provenance field (allowed: #{PROVENANCE_KEYS.join(', ')})"
  end

  expect_enum(prov["freshness"], FRESHNESS_STATES, "#{label}.provenance.freshness", errors) if prov.key?("freshness")

  if prov.key?("verified_at")
    unless prov["verified_at"].to_s.match?(VERIFIED_AT_PATTERN)
      errors << "#{label}.provenance.verified_at must be YYYY-MM-DD (the day the claim was actually re-checked)"
    end
  end

  # The block mirrors the vault's, which repeats task_id so a promoted note is
  # self-contained. Here the output already carries one, so the two must agree.
  if prov.key?("task_id") && prov["task_id"] != data["task_id"]
    errors << "#{label}.provenance.task_id '#{prov['task_id']}' must equal #{label}.task_id '#{data['task_id']}'"
  end
  effective_task = prov["task_id"] || data["task_id"]

  if prov.key?("run_id") && !prov["run_id"].nil?
    if prov["run_id"].is_a?(String) && (m = RUN_ID_PATTERN.match(prov["run_id"]))
      if effective_task.is_a?(String) && m[1] != effective_task
        errors << "#{label}.provenance.run_id embeds task '#{m[1]}' but the output is for '#{effective_task}'"
      end
    else
      errors << "#{label}.provenance.run_id must match #{RUN_ID_HINT}, or be null"
    end
  end

  refs = []
  if prov.key?("evidence_refs")
    expect_string_array(prov["evidence_refs"], "#{label}.provenance.evidence_refs", errors)
    if prov["evidence_refs"].is_a?(Array)
      known = known_evidence_ids(task_dir)
      prov["evidence_refs"].each_with_index do |ref, i|
        next unless ref.is_a?(String)
        if ref.match?(EVIDENCE_ID_PATTERN)
          refs << ref
          errors << "#{label}.provenance.evidence_refs: unknown evidence id '#{ref}' (not in evidence.yaml)" unless known.include?(ref)
        else
          errors << "#{label}.provenance.evidence_refs[#{i}] must match #{EVIDENCE_ID_HINT}"
        end
      end
    end
  end

  if prov.key?("repo_origin") && !prov["repo_origin"].nil?
    unless prov["repo_origin"].is_a?(String) && prov["repo_origin"].match?(REPO_ORIGIN_PATTERN)
      errors << "#{label}.provenance.repo_origin must be #{REPO_ORIGIN_HINT}"
    end
  end

  if prov.key?("repo_sha") && !prov["repo_sha"].to_s.match?(PROV_REPO_SHA_PATTERN)
    errors << "#{label}.provenance.repo_sha must be a 40-hex commit sha, or \"unknown\""
  end

  if prov.key?("confidence")
    expect_enum(prov["confidence"], FRESHNESS_CONFIDENCE, "#{label}.provenance.confidence", errors)
    # Vault rule, verbatim: confidence describes the check, so it may only be
    # recorded when there IS a check behind it.
    earned = prov["verified_at"] && (prov["run_id"] || (prov["evidence_refs"].is_a?(Array) && !prov["evidence_refs"].empty?))
    unless earned
      errors << "#{label}.provenance.confidence requires verified_at plus run_id or evidence_refs (omit it when no check backs the claim)"
    end
  end

  # The invalidation rule. Conservative by design and deliberately narrow: a
  # degraded source makes the claim POTENTIALLY stale, so only the positive
  # assertion `current` is refused. `unknown` (including an absent freshness
  # key), `maybe_stale`, `stale` and `invalid` all pass, and `historical` is
  # exempt because a note that records the past on purpose never goes stale.
  return unless prov["freshness"] == "current"

  marks = evidence_freshness_marks(task_dir)
  degraded = refs.filter_map { |ref| marks[ref] }
  return if degraded.empty?

  cited = degraded.map { |m| "#{m['evidence_id']} (#{m['state']})" }.join(", ")
  errors << "#{label}.provenance.freshness is 'current' but it cites evidence marked in " \
            "evidence-freshness.yaml: #{cited}. Declare maybe_stale (or stale/invalid) until the " \
            "claim is re-checked. Do not delete the capture — degraded knowledge stays discoverable."
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

  Dir.glob(File.join(task_dir, "run-records", "*.yaml")).sort.each do |path|
    label = File.join("run-records", File.basename(path))
    record = load_yaml(path)
    validate_run_record(record, label, errors)
    if record.is_a?(Hash) && record["run_id"].is_a?(String) && record["run_id"] != File.basename(path, ".yaml")
      errors << "#{label}: filename must be <run_id>.yaml"
    end
  end

  decision_file = File.join(task_dir, "decision.yaml")
  validate_decision(load_yaml(decision_file), "decision.yaml", errors) if File.exist?(decision_file)

  evidence_file = File.join(task_dir, "evidence.yaml")
  if File.exist?(evidence_file)
    begin
      validate_evidence(load_yaml(evidence_file), "evidence.yaml", task_dir, errors)
    rescue => e
      errors << e.message
    end
  end

  # issue #15 — absent on every task that never marked evidence; absence is normal.
  freshness_file = File.join(task_dir, "evidence-freshness.yaml")
  if File.exist?(freshness_file)
    begin
      validate_evidence_freshness(load_yaml(freshness_file), "evidence-freshness.yaml", task_dir, errors)
    rescue => e
      errors << e.message
    end
  end

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
  elsif basename == "evidence.yaml"
    validate_evidence(load_yaml(target_path), basename, File.dirname(target_path), errors)
  elsif basename == "evidence-freshness.yaml" # issue #15
    validate_evidence_freshness(load_yaml(target_path), basename, File.dirname(target_path), errors)
  elsif File.basename(File.dirname(target_path)) == "run-records"
    validate_run_record(load_yaml(target_path), basename, errors)
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
