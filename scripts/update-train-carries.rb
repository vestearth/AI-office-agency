#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed release-train membership writer. A release train (one task that
# promotes many features to production, e.g. TASK-EAR-402) records which tasks
# it carries in status.yaml `carries`. The dashboard's release ladder credits a
# carried task's production rungs from the train's own deploy_production /
# production_acceptance gates — never from prose. Membership only records
# intent; it authorizes nothing and resolves no gate.
#
# ruby scripts/update-train-carries.rb TASK-EAR-402 add|remove TASK-EAR-389 [TASK-…] --actor ROLE --reason R

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"

TASK_ID = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/

def refuse(message, code = 2)
  warn "update-train-carries: #{message}"
  exit code
end

argv, not_utf8 = CompletionGuard.utf8_argv(ARGV)
refuse("argument #{not_utf8.scrub.inspect} is not valid UTF-8") if not_utf8
train_id, action, *rest = argv
refuse("expected TRAIN_TASK_ID add|remove TASK_ID... --actor ROLE --reason R") unless train_id && action
refuse("invalid task id #{train_id.inspect}") unless train_id.match?(TASK_ID)
refuse("unknown action #{action.inspect}") unless %w[add remove].include?(action)

ids = []
opts = {}
until rest.empty?
  arg = rest.shift
  if arg.start_with?("--")
    value = rest.shift
    refuse("#{arg} needs a value") if value.nil?
    refuse("unknown flag #{arg.inspect}") unless %w[--actor --reason].include?(arg)
    refuse("duplicate #{arg}") if opts.key?(arg)
    opts[arg] = value.strip
  else
    ids << arg.strip
  end
end
refuse("--actor and --reason are required") if opts["--actor"].to_s.empty? || opts["--reason"].to_s.empty?
refuse("name at least one task to #{action}") if ids.empty?
ids.each { |id| refuse("invalid task id #{id.inspect}") unless id.match?(TASK_ID) }
refuse("a train cannot carry itself") if ids.include?(train_id)
refuse("duplicate task ids in the request") unless ids.uniq.size == ids.size

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, train_id)
status_path = File.join(task_dir, "status.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)
if action == "add"
  missing = ids.reject { |id| File.file?(File.join(runs_dir, id, "status.yaml")) }
  refuse("no such task: #{missing.join(', ')}") unless missing.empty?
end

lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true)
rescue StandardError => e
  refuse("cannot read status.yaml: #{e.message}", 3)
end
refuse("status.yaml must be a map for #{train_id}", 3) unless status.is_a?(Hash) && status["task_id"] == train_id
phase = status["phase"]
refuse("train membership changes require a non-terminal task (got #{phase.inspect})") unless BranchProjection::UPDATABLE_PHASES.include?(phase)

current = status["carries"].is_a?(Array) ? status["carries"].map(&:to_s) : []
if action == "add"
  already = ids & current
  refuse("already carried: #{already.join(', ')}") unless already.empty?
  updated = current + ids
else
  absent = ids - current
  refuse("not carried: #{absent.join(', ')}") unless absent.empty?
  updated = current - ids
end

now = Time.now.utc.strftime("%FT%TZ")
if updated.empty?
  status.delete("carries")
else
  status["carries"] = updated
end
# updated_at is not touched: membership is not progress on the train, and the
# review model's idle clock reads updated_at.
status["history"] = [] unless status["history"].is_a?(Array)
sign = action == "add" ? "+" : "-"
# No "a -> b" in this row: it is a membership change, not a phase transition.
status["history"] << {
  "phase" => "carries: #{ids.map { |id| "#{sign}#{id}" }.join(' ')}",
  "agent" => opts["--actor"],
  "reason" => opts["--reason"],
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
CompletionGuard.append_meta_event!(task_dir, type: "train_carries_updated", agent: CompletionGuard.event_agent(opts["--actor"]),
                                   details: "#{action} #{ids.join(',')} carries=#{updated.size}")
puts "#{train_id} carries #{updated.size} task#{updated.size == 1 ? '' : 's'}: #{updated.join(', ')}"
