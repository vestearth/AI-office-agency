#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed scheduled-check writer. A task that must be looked at again after a
# point in time (e.g. "after 08:00 tomorrow, confirm the prod deploy's daily
# digest was sent") records it in status.yaml `check_after` {at, what}. The
# dashboard raises it in the Action Center once `at` has passed. Scheduling a
# check authorizes nothing and resolves no gate; clear it once it is done.
#
# ruby scripts/update-check-after.rb TASK-VS-054 set --at 2026-10-29T01:00:00Z --what TEXT --actor ROLE --reason R
# ruby scripts/update-check-after.rb TASK-VS-054 clear --actor ROLE --reason R
#
# --at is a date (midnight in the office's time zone) or a timestamp with Z or
# an offset; a time without a zone is refused rather than guessed.

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"

TASK_ID = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/
CHECK_AT = /\A\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?\z/

def refuse(message, code = 2)
  warn "update-check-after: #{message}"
  exit code
end

def check_at?(value)
  return false unless value.match?(CHECK_AT)

  value.length == 10 ? Date.strptime(value, "%Y-%m-%d") : Time.iso8601(value)
  true
rescue ArgumentError
  false
end

argv, not_utf8 = CompletionGuard.utf8_argv(ARGV)
refuse("argument #{not_utf8.scrub.inspect} is not valid UTF-8") if not_utf8
task_id, action, *rest = argv
refuse("expected TASK_ID set --at AT --what TEXT | clear, then --actor ROLE --reason R") unless task_id && action
refuse("invalid task id #{task_id.inspect}") unless task_id.match?(TASK_ID)
refuse("unknown action #{action.inspect}") unless %w[set clear].include?(action)

allowed = action == "set" ? %w[--at --what --actor --reason] : %w[--actor --reason]
opts = {}
until rest.empty?
  arg = rest.shift
  refuse("unexpected argument #{arg.inspect}") unless arg.start_with?("--")
  value = rest.shift
  refuse("#{arg} needs a value") if value.nil?
  refuse("unknown flag #{arg.inspect} for #{action}") unless allowed.include?(arg)
  refuse("duplicate #{arg}") if opts.key?(arg)
  opts[arg] = value.strip
end
missing = allowed.select { |flag| opts[flag].to_s.empty? }
refuse("#{missing.join(' and ')} required") unless missing.empty?
refuse("--at must be a date or a timestamp with Z or an offset (got #{opts['--at'].inspect})") if action == "set" && !check_at?(opts["--at"])

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
refuse("a scheduled check requires a non-terminal task (got #{phase.inspect})") unless BranchProjection::UPDATABLE_PHASES.include?(phase)
refuse("#{task_id} has no check_after to clear") if action == "clear" && !status.key?("check_after")

if action == "set"
  status["check_after"] = { "at" => opts["--at"], "what" => opts["--what"] }
else
  status.delete("check_after")
end
# updated_at is not touched: scheduling a check is not progress on the task, and
# the review model's idle clock reads updated_at.
status["history"] = [] unless status["history"].is_a?(Array)
# No "a -> b" in this row: it is a schedule change, not a phase transition.
status["history"] << CompletionGuard.with_operator({
  "phase" => action == "set" ? "check_after: #{opts['--at']}" : "check_after: cleared",
  "agent" => opts["--actor"],
  "reason" => opts["--reason"],
  "at" => Time.now.utc.strftime("%FT%TZ")
})

tmp = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp, YAML.dump(status))
  File.rename(tmp, status_path)
rescue StandardError => e
  File.delete(tmp) if File.exist?(tmp)
  refuse("cannot save status.yaml: #{e.message}", 3)
end
CompletionGuard.append_meta_event!(task_dir, type: "check_after_updated", agent: CompletionGuard.event_agent(opts["--actor"]),
                                   details: action == "set" ? "set #{opts['--at']}" : "cleared")
puts action == "set" ? "#{task_id} check after #{opts['--at']}: #{opts['--what']}" : "#{task_id} check cleared"
