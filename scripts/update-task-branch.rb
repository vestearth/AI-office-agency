#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed Phase 1C branch writer. Branches describe independent portions of a
# task; they do not select a runner or authorize an action. A blocked branch is
# local to that branch while another is ready. Use this writer for branch
# updates so they take the task lock and ownership fence and leave an audit trail.
#
# ruby scripts/update-task-branch.rb TASK-123 declare BRANCH --actor A --reason R [--state ready|blocked] [--waiting-for TEXT]
# ruby scripts/update-task-branch.rb TASK-123 block|ready|done|na BRANCH --actor A --reason R [--waiting-for TEXT]

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"

def refuse(message, code = 2)
  warn "update-task-branch: #{message}"
  exit code
end

task_id, action, name, *args = ARGV
refuse("expected TASK_ID declare|block|ready|done|na BRANCH --actor A --reason R") unless task_id && action && name
refuse("invalid task id") unless task_id.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/)
refuse("invalid branch name") unless name.match?(CompletionGuard::BRANCH_NAME_PATTERN)
refuse("unknown action #{action.inspect}") unless %w[declare block ready done na].include?(action)

opts = { "waiting_for" => [] }
until args.empty?
  flag = args.shift
  value = args.shift
  refuse("#{flag} needs a value") if value.nil?
  case flag
  when "--actor", "--reason", "--state"
    refuse("duplicate #{flag}") if opts.key?(flag.delete_prefix("--"))
    opts[flag.delete_prefix("--")] = value.strip
  when "--waiting-for"
    opts["waiting_for"] << value.strip
  else
    refuse("unknown flag #{flag.inspect}")
  end
end
refuse("--actor and --reason are required") if opts["actor"].to_s.empty? || opts["reason"].to_s.empty?
refuse("--state is only valid with declare") if action != "declare" && opts.key?("state")
state = action == "declare" ? opts.fetch("state", "ready") : (action == "block" ? "blocked" : action)
refuse("declare state must be ready or blocked") if action == "declare" && !%w[ready blocked].include?(state)
if state == "blocked"
  refuse("blocked branch needs --waiting-for") if opts["waiting_for"].empty? || opts["waiting_for"].any?(&:empty?)
else
  refuse("--waiting-for is only valid for a blocked branch") unless opts["waiting_for"].empty?
end

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, task_id)
status_path = File.join(task_dir, "status.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)

lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true)
rescue StandardError => e
  refuse("cannot read status.yaml: #{e.message}", 3)
end
refuse("status.yaml must be a map for #{task_id}", 3) unless status.is_a?(Hash) && status["task_id"] == task_id
phase = status["phase"]
refuse("branch updates require a non-terminal task (got #{phase.inspect})") unless BranchProjection::UPDATABLE_PHASES.include?(phase)
refuse("status.yaml branches must be a map", 3) if status.key?("branches") && !status["branches"].is_a?(Hash)
branches = (status["branches"] ||= {})
branches.each do |id, branch|
  valid = id.is_a?(String) && id.match?(CompletionGuard::BRANCH_NAME_PATTERN) && branch.is_a?(Hash) &&
          CompletionGuard::BRANCH_STATES.include?(branch["state"]) &&
          CompletionGuard::RESOLUTION_METADATA_KEYS.all? { |key| branch[key].is_a?(String) && !branch[key].strip.empty? } &&
          (branch.keys - %w[state actor reason updated_at waiting_for]).empty? &&
          (branch["state"] == "blocked" ?
            branch["waiting_for"].is_a?(Array) && !branch["waiting_for"].empty? &&
              branch["waiting_for"].all? { |item| item.is_a?(String) && !item.strip.empty? } :
            !branch.key?("waiting_for"))
  refuse("malformed existing branch #{id.inspect}", 3) unless valid
end
refuse("status.yaml waiting_for must be a list", 3) if status.key?("waiting_for") && !status["waiting_for"].is_a?(Array)
refuse("status.yaml blocked_on must be a list", 3) if status.key?("blocked_on") && !status["blocked_on"].is_a?(Array)
refuse("status.yaml waiting_for must contain reasons", 3) if Array(status["waiting_for"]).any? { |item| !item.is_a?(String) || item.strip.empty? }
existing = branches[name]
if action == "declare"
  refuse("branch #{name} already exists") if branches.key?(name)
else
  refuse("branch #{name} is not declared") unless existing.is_a?(Hash)
  old_state = existing["state"]
  allowed = {
    "ready" => %w[blocked done na],
    "blocked" => %w[ready na]
  }
  refuse("cannot transition #{name} from #{old_state.inspect} to #{state}") unless allowed.fetch(old_state, []).include?(state)
end

now = Time.now.utc.strftime("%FT%TZ")
record = { "state" => state, "actor" => opts["actor"], "reason" => opts["reason"], "updated_at" => now }
record["waiting_for"] = opts["waiting_for"] if state == "blocked"
branches[name] = record

old_phase = phase
BranchProjection.apply!(status)
status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "#{old_phase} -> #{status['phase']}",
  "agent" => CompletionGuard.event_agent(opts["actor"]),
  "reason" => "Branch #{name}: #{action == 'declare' ? 'declared' : existing['state']} -> #{state}; #{opts['reason']}",
  "at" => now
}

tmp = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp, YAML.dump(status))
  File.rename(tmp, status_path)
rescue StandardError => e
  File.delete(tmp) if File.exist?(tmp)
  refuse("cannot save status.yaml: #{e.message}", 3)
end
CompletionGuard.append_meta_event!(task_dir, type: "branch_updated", agent: CompletionGuard.event_agent(opts["actor"]),
                                   details: "branch=#{name} state=#{state} task_phase=#{status['phase']}")
puts "Branch #{name}: #{state} (task #{status['phase']})"
