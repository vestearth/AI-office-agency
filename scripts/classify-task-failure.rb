#!/usr/bin/env ruby
# frozen_string_literal: true

# Records an explicit, source-backed failure judgment and routes recovery.
# The classifier chooses the class; this writer checks its allowed route and
# writes the status transition plus structured meta event under the task lock.
#
# ruby scripts/classify-task-failure.rb TASK-123 CLASS --actor A --reason R \
#   [--history-index N] [--evidence ev-001,ev-002] [--route AGENT] \
#   [--invalidates TEXT] [--waiting-for TEXT]

require "yaml"
require "date"
require "time"
require "optparse"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"
require_relative "failure-recovery"

def refuse(message, code = 2)
  warn "classify-task-failure: #{message}"
  exit code
end

task_id, classification, *args = ARGV
refuse("expected TASK_ID CLASS --actor A --reason R with a history index or evidence id") unless task_id && classification
refuse("invalid task id") unless task_id.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/)
refuse("unknown classification #{classification.inspect}") unless FailureRecovery::CLASSES.include?(classification)

opts = { invalidates: [], waiting_for: [], evidence: [] }
parser = OptionParser.new do |o|
  o.on("--actor ACTOR") { |value| opts[:actor] = value.strip }
  o.on("--reason TEXT") { |value| opts[:reason] = value.strip }
  o.on("--history-index N") { |value| opts[:history_index] = value }
  o.on("--route AGENT") { |value| opts[:route] = value.strip }
  o.on("--evidence IDS") { |value| opts[:evidence].concat(value.split(",").map(&:strip)) }
  o.on("--invalidates TEXT") { |value| opts[:invalidates] << value.strip }
  o.on("--waiting-for TEXT") { |value| opts[:waiting_for] << value.strip }
end
begin
  parser.parse!(args)
rescue OptionParser::ParseError => e
  refuse(e.message)
end
refuse("unexpected argument(s): #{args.join(' ')}") unless args.empty?
refuse("--actor and --reason are required") if opts[:actor].to_s.empty? || opts[:reason].to_s.empty?
refuse("a --history-index or --evidence is required") if opts[:history_index].nil? && opts[:evidence].empty?
refuse("--history-index must be a zero-based integer") if opts[:history_index] && !opts[:history_index].match?(/\A\d+\z/)
refuse("empty evidence id, invalidated assumption or wait") if (opts[:evidence] + opts[:invalidates] + opts[:waiting_for]).any?(&:empty?)
refuse("invalid evidence id") unless opts[:evidence].all? { |id| id.match?(/\Aev-\d{3,}\z/) }
refuse("duplicate evidence id") unless opts[:evidence].uniq == opts[:evidence]
if classification == "invalid_assumption"
  refuse("invalid_assumption requires --invalidates") if opts[:invalidates].empty?
else
  refuse("--invalidates is only valid for invalid_assumption") unless opts[:invalidates].empty?
end
if classification == "permission_authority"
  refuse("permission_authority requires --waiting-for") if opts[:waiting_for].empty?
else
  refuse("--waiting-for is only valid for permission_authority") unless opts[:waiting_for].empty?
end
route = FailureRecovery.route(classification, opts[:route])
refuse("route is not allowed for #{classification}") unless route

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, task_id)
status_path = File.join(task_dir, "status.yaml")
meta_path = File.join(task_dir, "meta.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)

lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status_original = File.read(status_path)
meta_original = File.file?(meta_path) ? File.read(meta_path) : nil
begin
  status = YAML.safe_load(status_original, permitted_classes: [Date, Time], aliases: true)
  meta = meta_original ? YAML.safe_load(meta_original, permitted_classes: [Date, Time], aliases: true) : {}
rescue StandardError => e
  refuse("cannot read task state: #{e.message}", 3)
end
refuse("status.yaml task_id mismatch or non-map", 3) unless status.is_a?(Hash) && status["task_id"] == task_id
refuse("task is terminal or has an unknown phase", 3) unless BranchProjection::UPDATABLE_PHASES.include?(status["phase"])
refuse("meta.yaml task_id mismatch or non-map", 3) unless meta.is_a?(Hash) && (!meta.key?("task_id") || meta["task_id"] == task_id)
refuse("meta.yaml events must be a list", 3) if meta.key?("events") && !meta["events"].is_a?(Array)
refuse("meta.yaml events must contain maps", 3) if Array(meta["events"]).any? { |event| !event.is_a?(Hash) }
history = status["history"]
refuse("status.yaml history must be a list", 3) if status.key?("history") && !history.is_a?(Array)
if opts[:history_index]
  index = opts[:history_index].to_i
  source = history[index] if history.is_a?(Array)
  refuse("source status history entry #{index} is missing or has no reason", 3) unless source.is_a?(Hash) && source["reason"].is_a?(String) && !source["reason"].strip.empty?
end
refuse("status.yaml waiting_for must be a list", 3) if status.key?("waiting_for") && !status["waiting_for"].is_a?(Array)
if Array(status["waiting_for"]).any? { |wait| !wait.is_a?(String) || wait.strip.empty? }
  refuse("status.yaml waiting_for must contain non-empty strings", 3)
end

unless opts[:evidence].empty?
  evidence_path = File.join(task_dir, "evidence.yaml")
  ledger = begin
    YAML.safe_load(File.read(evidence_path), permitted_classes: [Date, Time], aliases: true)
  rescue StandardError => e
    refuse("cannot read evidence.yaml: #{e.message}", 3)
  end
  known = Array(ledger.is_a?(Hash) ? ledger["evidence"] : nil).map { |entry| entry["id"] if entry.is_a?(Hash) }.compact
  missing = opts[:evidence] - known
  refuse("unknown evidence id(s): #{missing.join(', ')}", 3) unless missing.empty?
end

previous = Array(meta["events"]).reverse.find do |event|
  event.is_a?(Hash) && event["type"] == "failure_classified" &&
    event["classification"] == classification && event["details"] == opts[:reason] &&
    event["source_history_index"] == index && Array(event["evidence_refs"]) == opts[:evidence] &&
    Array(event["invalidates"]) == opts[:invalidates] && Array(event["waiting_for"]) == opts[:waiting_for] &&
    event["recovery"].is_a?(Hash) && event["recovery"]["to_agent"] == route["agent"]
end
if previous
  puts "Failure classification already recorded (idempotent skip)."
  exit 0
end

actor = CompletionGuard.event_agent(opts[:actor])
now = Time.now.utc.strftime("%FT%TZ")
old_phase = status["phase"]
status["phase"] = status["state"] = route["phase"]
status["current_agent"] = route["agent"]
status["ready"] = route["phase"] != "blocked"
status["waiting_for"] = Array(status["waiting_for"]) + opts[:waiting_for] unless opts[:waiting_for].empty?
BranchProjection.apply!(status)
status["updated_at"] = Date.today.to_s
status["history"] ||= []
status["history"] << {
  "phase" => "#{old_phase} -> #{status['phase']}",
  "agent" => actor,
  "reason" => "#{classification} -> #{route['action']}: #{opts[:reason]}",
  "at" => now
}

event = {
  "type" => "failure_classified",
  "agent" => actor,
  "details" => opts[:reason],
  "timestamp" => now,
  "classification" => classification,
  "recovery" => {
    "action" => route["action"],
    "from_phase" => old_phase,
    "to_phase" => status["phase"],
    "to_agent" => status["current_agent"]
  }
}
event["source_history_index"] = index if opts[:history_index]
event["evidence_refs"] = opts[:evidence] unless opts[:evidence].empty?
event["invalidates"] = opts[:invalidates] unless opts[:invalidates].empty?
event["waiting_for"] = opts[:waiting_for] unless opts[:waiting_for].empty?
run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
event["run_id"] = run_id unless run_id.empty?
meta["task_id"] ||= task_id
meta["events"] ||= []
meta["events"] << event
meta["updated_at"] = now

# Both files are prepared before the first rename. If the meta rename fails,
# restore the prior status while still holding the task lock.
status_tmp = "#{status_path}.tmp.#{$$}"
meta_tmp = "#{meta_path}.tmp.#{$$}"
begin
  File.write(status_tmp, YAML.dump(status))
  File.write(meta_tmp, YAML.dump(meta))
  File.rename(status_tmp, status_path)
  File.rename(meta_tmp, meta_path)
rescue StandardError => e
  if !File.exist?(status_tmp)
    begin
      File.write(status_tmp, status_original)
      File.rename(status_tmp, status_path)
    rescue StandardError => restore_error
      warn "classify-task-failure: could not restore status.yaml: #{restore_error.message}"
    end
  end
  refuse("cannot save classified failure: #{e.message}", 3)
ensure
  File.delete(status_tmp) if File.exist?(status_tmp)
  File.delete(meta_tmp) if File.exist?(meta_tmp)
end

puts "Failure classified: #{classification} -> #{route['action']} (task #{status['phase']})"
