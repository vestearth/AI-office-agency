#!/usr/bin/env ruby
# frozen_string_literal: true

# Deterministic, lane-neutral knowledge closeout router (issue #26). Any
# operator — Claude, Codex, Cursor, or a human — runs this once at the end of a
# non-trivial session to choose among the EXISTING knowledge mechanisms:
#
#   no durable delta                        -> skip
#   new durable task knowledge              -> capture
#   existing knowledge drift / conflict     -> librarian
#   new durable knowledge + existing impact -> capture, then librarian_reconcile
#
# The two judgment signals (durable delta, existing-knowledge impact) come from
# the operator. Everything else — same-scope reuse, capture create-vs-update,
# librarian spawn-vs-followup, and what must be inspected before proposing —
# is derived from artifacts already on disk. It never dispatches an agent,
# writes knowledge-base/, or mutates status.yaml. With --record it appends one
# closeout record so a deliberate skip is distinguishable from a forgotten one.
#
# Usage:
#   ruby scripts/knowledge-closeout.rb --scope <key> --durable-delta yes|no \
#     --existing-impact yes|no [--task TASK-ID] [--evidence REF]... \
#     [--note "Knowledge Base/..."]... [--comment TEXT] [--at ISO] [--record]
#   ruby scripts/knowledge-closeout.rb --validate <record.yaml>
# Exit: 0 ok; 1 invalid record; 2 usage error.
# Contract: workflows/knowledge-closeout.md

require "json"
require "optparse"
require "time"
require "yaml"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
REVIEWS_DIR = ENV.fetch("AI_OFFICE_REVIEWS_DIR", File.join(OFFICE_DIR, "knowledge-reviews"))
CLOSEOUTS_DIR = File.join(REVIEWS_DIR, "closeouts")
REVIEW_QUEUE = "knowledge-base/Knowledge Base/Review Queue.md"

SCHEMA = JSON.parse(File.read(File.join(OFFICE_DIR, "schemas/knowledge-closeout.schema.json"))).freeze
PROPS = SCHEMA.fetch("properties")
KC = PROPS.fetch("knowledge_closeout")
SIGNALS = PROPS.fetch("signals")
CAPTURE = KC.dig("properties", "capture", "oneOf", 1)
SCOPE_PATTERN = Regexp.new(PROPS.dig("scope", "pattern"))
TASK_PATTERN = Regexp.new(PROPS.dig("task_id", "pattern"))
ID_PATTERN = Regexp.new(PROPS.dig("closeout_id", "pattern"))

# The routing table. Reasons are the only way to reach an action set.
ACTIONS_FOR = {
  "no_durable_delta" => %w[skip],
  "new_durable_knowledge" => %w[capture],
  "existing_knowledge_drift" => %w[librarian],
  "new_knowledge_with_existing_impact" => %w[capture librarian_reconcile],
  "no_new_evidence" => %w[skip]
}.freeze
unless ACTIONS_FOR.keys.sort == KC.dig("properties", "reason", "enum").sort
  abort "knowledge-closeout.rb: routing table drifted from schemas/knowledge-closeout.schema.json"
end

def signal_reason(delta, impact)
  return "new_knowledge_with_existing_impact" if delta && impact
  return "new_durable_knowledge" if delta
  return "existing_knowledge_drift" if impact

  "no_durable_delta"
end

def librarian_needed?(action, capture)
  action.any? { |a| a.start_with?("librarian") } ||
    (capture.is_a?(Hash) && capture["via"] == "librarian_capture_trigger")
end

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], aliases: false)
end

# --- validation --------------------------------------------------------------

def validate(data)
  errors = []
  return ["document must be a map"] unless data.is_a?(Hash)

  missing = SCHEMA.fetch("required") - data.keys
  extra = data.keys - PROPS.keys
  errors << "missing field(s): #{missing.join(', ')}" unless missing.empty?
  errors << "unsupported field(s): #{extra.join(', ')}" unless extra.empty?
  errors << "artifact_type must be knowledge_closeout" unless data["artifact_type"] == "knowledge_closeout"
  errors << "schema_version must be 1" unless data["schema_version"] == 1
  errors << "closeout_id has invalid format" unless data["closeout_id"].to_s.match?(ID_PATTERN)
  begin
    Time.iso8601(data["generated_at"].to_s)
  rescue ArgumentError
    errors << "generated_at must be an ISO date-time"
  end
  scope = data["scope"].to_s
  errors << "scope must be a lowercase slug" unless scope.match?(SCOPE_PATTERN)
  errors << "closeout_id must end with the scope" unless data["closeout_id"].to_s.end_with?("Z-#{scope}")
  task = data["task_id"]
  errors << "task_id must be null or a TASK id" unless task.nil? || task.to_s.match?(TASK_PATTERN)

  signals = data["signals"]
  kc = data["knowledge_closeout"]
  return errors unless signals.is_a?(Hash) && kc.is_a?(Hash)

  missing = SIGNALS.fetch("required") - signals.keys
  extra = signals.keys - SIGNALS.fetch("properties").keys
  errors << "signals missing field(s): #{missing.join(', ')}" unless missing.empty?
  errors << "signals unsupported field(s): #{extra.join(', ')}" unless extra.empty?
  %w[durable_delta existing_knowledge_impact].each do |k|
    errors << "signals.#{k} must be a boolean" unless [true, false].include?(signals[k])
  end
  %w[evidence_refs new_evidence_refs touched_notes].each do |k|
    v = signals[k]
    ok = v.is_a?(Array) && v.all? { |i| i.is_a?(String) && !i.strip.empty? } && v.uniq.size == v.size
    errors << "signals.#{k} must be a unique array of non-empty strings" unless ok
  end

  missing = KC.fetch("required") - kc.keys
  extra = kc.keys - KC.fetch("properties").keys
  errors << "knowledge_closeout missing field(s): #{missing.join(', ')}" unless missing.empty?
  errors << "knowledge_closeout unsupported field(s): #{extra.join(', ')}" unless extra.empty?
  return errors unless errors.empty?

  delta = signals["durable_delta"]
  impact = signals["existing_knowledge_impact"]
  evidence = signals["evidence_refs"]
  new_evidence = signals["new_evidence_refs"]
  reason = kc["reason"]
  action = kc["action"]
  capture = kc["capture"]

  unless ACTIONS_FOR.key?(reason)
    errors << "knowledge_closeout.reason must be one of: #{ACTIONS_FOR.keys.join(', ')}"
    return errors
  end
  errors << "action #{action.inspect} does not match reason #{reason} (expected #{ACTIONS_FOR[reason].inspect})" unless action == ACTIONS_FOR[reason]
  errors << "new_evidence_refs must be a subset of evidence_refs" unless (new_evidence - evidence).empty?
  errors << "a durable delta or existing-knowledge impact needs at least one evidence ref" if (delta || impact) && evidence.empty?

  if reason == "no_new_evidence"
    errors << "no_new_evidence requires a prior same-scope closeout" if kc["prior_closeouts"].empty?
    errors << "no_new_evidence cannot list new evidence" unless new_evidence.empty?
    errors << "no_new_evidence only applies when a signal is set" unless delta || impact
  elsif reason != signal_reason(delta, impact)
    errors << "reason #{reason} contradicts the signals (expected #{signal_reason(delta, impact)})"
  end

  if action.include?("capture")
    if capture.is_a?(Hash)
      errors << "capture has unsupported or missing fields" unless capture.keys.sort == CAPTURE.fetch("required").sort
      errors << "capture.via must be one of: #{CAPTURE.dig('properties', 'via', 'enum').join(', ')}" unless CAPTURE.dig("properties", "via", "enum").include?(capture["via"])
      errors << "capture.step must be one of: #{CAPTURE.dig('properties', 'step', 'enum').join(', ')}" unless CAPTURE.dig("properties", "step", "enum").include?(capture["step"])
      errors << "capture via task_run requires task_id and artifact" if capture["via"] == "task_run" && (task.nil? || capture["artifact"].nil?)
      errors << "capture via librarian_capture_trigger is only for sessions without a task" if capture["via"] == "librarian_capture_trigger" && !task.nil?
    else
      errors << "capture details are required when action includes capture"
    end
  elsif !capture.nil?
    errors << "capture must be null when action does not include capture"
  end

  dispatch = kc["librarian_dispatch"]
  expected_none = !librarian_needed?(action, capture)
  errors << "librarian_dispatch must be one of: #{KC.dig('properties', 'librarian_dispatch', 'enum').join(', ')}" unless KC.dig("properties", "librarian_dispatch", "enum").include?(dispatch)
  errors << "librarian_dispatch must be none when no librarian step runs" if expected_none && dispatch != "none"
  errors << "librarian_dispatch must be spawn or followup when a librarian step runs" if !expected_none && dispatch == "none"
  # A prior same-scope audit means the librarian already exists for this scope.
  if dispatch == "spawn" && !kc["prior_librarian_audits"].empty?
    errors << "librarian_dispatch must be followup when a prior same-scope librarian audit exists"
  end
  if !expected_none && !kc["must_inspect"].include?(REVIEW_QUEUE)
    errors << "must_inspect must include the Review Queue before a librarian step"
  end
  if action.include?("librarian_reconcile") && capture.is_a?(Hash) && capture["artifact"] && !kc["must_inspect"].include?(capture["artifact"])
    errors << "librarian_reconcile must inspect the capture artifact first"
  end
  errors
end

if ARGV.first == "--validate"
  path = ARGV[1]
  abort "Usage: knowledge-closeout.rb --validate <record.yaml>" if path.nil? || ARGV.length != 2
  errors = begin
    validate(load_yaml(path))
  rescue Errno::ENOENT, Psych::Exception => e
    [e.message]
  end
  if errors.empty?
    puts "Knowledge closeout validation passed: #{path}"
    exit 0
  end
  warn "Knowledge closeout validation failed: #{path}"
  errors.each { |e| warn " - #{e}" }
  exit 1
end

# --- routing -----------------------------------------------------------------

opts = { evidence: [], notes: [] }
yes_no = lambda do |v|
  case v
  when "yes" then true
  when "no" then false
  else raise OptionParser::InvalidArgument, v
  end
end
parser = OptionParser.new do |o|
  o.banner = "Usage: knowledge-closeout.rb --scope KEY --durable-delta yes|no --existing-impact yes|no [options]"
  o.on("--scope KEY") { |v| opts[:scope] = v }
  o.on("--task ID") { |v| opts[:task] = v }
  o.on("--durable-delta YESNO") { |v| opts[:delta] = yes_no.call(v) }
  o.on("--existing-impact YESNO") { |v| opts[:impact] = yes_no.call(v) }
  o.on("--evidence REF") { |v| opts[:evidence] << v }
  o.on("--note PATH") { |v| opts[:notes] << v }
  o.on("--comment TEXT") { |v| opts[:comment] = v }
  o.on("--at ISO") { |v| opts[:at] = v }
  o.on("--record") { opts[:record] = true }
end
begin
  parser.parse!(ARGV)
rescue OptionParser::ParseError => e
  warn e.message
  warn parser.banner
  exit 2
end

usage_error = lambda do |msg|
  warn msg
  warn parser.banner
  exit 2
end
usage_error.call("unexpected argument(s): #{ARGV.join(' ')}") unless ARGV.empty?
usage_error.call("--scope must be a lowercase slug (parent thread + workstream)") unless opts[:scope].to_s.match?(SCOPE_PATTERN)
usage_error.call("--durable-delta and --existing-impact are both required") if opts[:delta].nil? || opts[:impact].nil?
usage_error.call("--task must be a TASK id") if opts[:task] && !opts[:task].match?(TASK_PATTERN)
evidence = opts[:evidence].uniq
if (opts[:delta] || opts[:impact]) && evidence.empty?
  usage_error.call("a durable delta or existing-knowledge impact needs at least one --evidence ref")
end

at = begin
  opts[:at] ? Time.iso8601(opts[:at]).utc : Time.now.utc
rescue ArgumentError
  usage_error.call("--at must be an ISO date-time")
end
stamp = at.strftime("%Y%m%dT%H%M%SZ")
scope = opts[:scope]
task = opts[:task]

# Same-scope history: prior closeout records and prior librarian audits, keyed by
# the `<stamp>-<scope>.yaml` file convention both artifacts already use.
same_scope = /\A[0-9]{8}T[0-9]{6}Z-#{Regexp.escape(scope)}\.yaml\z/
prior_closeout_files = Dir.exist?(CLOSEOUTS_DIR) ? Dir.children(CLOSEOUTS_DIR).grep(same_scope).sort : []
prior_audit_files = Dir.exist?(REVIEWS_DIR) ? Dir.children(REVIEWS_DIR).grep(same_scope).select { |f| File.file?(File.join(REVIEWS_DIR, f)) }.sort : []
prior_closeouts = prior_closeout_files.map { |f| "knowledge-reviews/closeouts/#{f}" }
prior_audits = prior_audit_files.map { |f| "knowledge-reviews/#{f}" }

prior_records = prior_closeout_files.map do |f|
  load_yaml(File.join(CLOSEOUTS_DIR, f))
rescue Psych::Exception
  nil
end.compact
known_evidence = prior_records.flat_map { |r| Array(r.dig("signals", "evidence_refs")) }.uniq
new_evidence = evidence - known_evidence
prior_librarian = !prior_audits.empty? ||
                  prior_records.any? { |r| %w[spawn followup].include?(r.dig("knowledge_closeout", "librarian_dispatch")) }

reason = signal_reason(opts[:delta], opts[:impact])
reason = "no_new_evidence" if reason != "no_durable_delta" && !prior_closeouts.empty? && new_evidence.empty?
action = ACTIONS_FOR.fetch(reason)

capture_artifact = task && "runs/#{task}/knowledge-capture-output.yaml"
capture_path = task && File.join(RUNS_DIR, task, "knowledge-capture-output.yaml")
existing_capture = capture_path && File.file?(capture_path) ? (load_yaml(capture_path) rescue {}) : nil
capture = nil
if action.include?("capture")
  capture = {
    "via" => task ? "task_run" : "librarian_capture_trigger",
    "step" => existing_capture ? "update" : "create",
    "artifact" => capture_artifact,
    "existing_recommended_action" => existing_capture.is_a?(Hash) ? existing_capture["recommended_action"] : nil
  }
end

librarian = librarian_needed?(action, capture)
dispatch = if !librarian then "none"
           elsif prior_librarian then "followup"
           else "spawn"
           end

touched = opts[:notes].map { |n| n.start_with?("Knowledge Base/") ? "knowledge-base/#{n}" : n }.uniq
must_inspect = []
unless action == %w[skip]
  must_inspect.concat(touched)
  must_inspect << capture_artifact if capture_artifact && (existing_capture || capture)
  if librarian
    must_inspect << REVIEW_QUEUE
    must_inspect.concat(prior_audits)
    must_inspect.concat(prior_closeouts)
  end
end

kc = {
  "action" => action,
  "reason" => reason,
  "capture" => capture,
  "librarian_dispatch" => dispatch,
  "prior_closeouts" => prior_closeouts,
  "prior_librarian_audits" => prior_audits,
  "must_inspect" => must_inspect.uniq
}
kc["note"] = opts[:comment] if opts[:comment]

record = {
  "artifact_type" => "knowledge_closeout",
  "schema_version" => 1,
  "closeout_id" => "KCO-#{stamp}-#{scope}",
  "generated_at" => at.iso8601,
  "scope" => scope,
  "task_id" => task,
  "signals" => {
    "durable_delta" => opts[:delta],
    "existing_knowledge_impact" => opts[:impact],
    "evidence_refs" => evidence,
    "new_evidence_refs" => new_evidence,
    "touched_notes" => touched
  },
  "knowledge_closeout" => kc
}

errors = validate(record)
abort "knowledge-closeout.rb produced an invalid record (bug): #{errors.join('; ')}" unless errors.empty?

yaml = YAML.dump(record)
if opts[:record]
  out = File.join(CLOSEOUTS_DIR, "#{stamp}-#{scope}.yaml")
  if File.exist?(out)
    warn "closeout record already exists (records are append-only): #{out}"
    exit 2
  end
  Dir.mkdir(REVIEWS_DIR) unless Dir.exist?(REVIEWS_DIR)
  Dir.mkdir(CLOSEOUTS_DIR) unless Dir.exist?(CLOSEOUTS_DIR)
  File.write(out, yaml)
  warn "recorded #{out}"
end
puts yaml
