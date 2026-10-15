#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed writer for status.yaml `waits_on`: the structured twin of the prose
# `waiting_for`, so tools can group waiting work ("4 tasks wait on prod_run")
# without reading prose. It records what blocks the task; it does not change
# phase, ready, waiting_for or any gate. The unblock reconcile clears it
# together with waiting_for.
#
# ruby scripts/update-waits-on.rb TASK-EAR-391 add|remove KIND [--ref TASK-EAR-402] --actor ROLE --reason R
#   KIND: prod_run aws_permission operator_decision operator_approval qa external

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"

TASK_ID = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/
KINDS = %w[prod_run aws_permission operator_decision operator_approval qa external].freeze

def refuse(message, code = 2)
  warn "update-waits-on: #{message}"
  exit code
end

argv, not_utf8 = CompletionGuard.utf8_argv(ARGV)
refuse("argument #{not_utf8.scrub.inspect} is not valid UTF-8") if not_utf8
task_id, action, kind, *rest = argv
refuse("expected TASK_ID add|remove KIND [--ref TASK_ID] --actor ROLE --reason R") unless task_id && action && kind
refuse("invalid task id #{task_id.inspect}") unless task_id.match?(TASK_ID)
refuse("unknown action #{action.inspect}") unless %w[add remove].include?(action)
refuse("unknown kind #{kind.inspect} (one of #{KINDS.join(', ')})") unless KINDS.include?(kind)

opts = {}
until rest.empty?
  flag = rest.shift
  value = rest.shift
  refuse("#{flag} needs a value") if value.nil?
  refuse("unknown flag #{flag.inspect}") unless %w[--ref --actor --reason].include?(flag)
  refuse("duplicate #{flag}") if opts.key?(flag)
  opts[flag] = value.strip
end
refuse("--actor and --reason are required") if opts["--actor"].to_s.empty? || opts["--reason"].to_s.empty?
ref = opts["--ref"]
if ref
  refuse("invalid --ref #{ref.inspect}") unless ref.match?(TASK_ID)
  refuse("--ref cannot be the task itself") if ref == task_id
end

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, task_id)
status_path = File.join(task_dir, "status.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)
refuse("no such task: #{ref}") if ref && action == "add" && !File.file?(File.join(runs_dir, ref, "status.yaml"))

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
refuse("waits can change only on a non-terminal task (got #{phase.inspect})") unless BranchProjection::UPDATABLE_PHASES.include?(phase)

entry = { "kind" => kind }
entry["ref"] = ref if ref
waits = status["waits_on"].is_a?(Array) ? status["waits_on"].select { |w| w.is_a?(Hash) } : []
if action == "add"
  refuse("already waits on #{kind}#{ref ? " (#{ref})" : ''}") if waits.include?(entry)
  waits += [entry]
else
  refuse("does not wait on #{kind}#{ref ? " (#{ref})" : ''}") unless waits.include?(entry)
  waits -= [entry]
end

now = Time.now.utc.strftime("%FT%TZ")
if waits.empty?
  status.delete("waits_on")
else
  status["waits_on"] = waits
end
# updated_at is not touched: recording what blocks a task is not progress, and
# the review model's idle clock reads updated_at.
status["history"] = [] unless status["history"].is_a?(Array)
# No "a -> b": recording a wait is not a phase transition.
status["history"] << {
  "phase" => "waits_on: #{action == 'add' ? '+' : '-'}#{kind}#{ref ? " (#{ref})" : ''}",
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
CompletionGuard.append_meta_event!(task_dir, type: "waits_on_updated", agent: CompletionGuard.event_agent(opts["--actor"]),
                                   details: "#{action} #{kind}#{ref ? " ref=#{ref}" : ''} waits=#{waits.size}")
puts "#{task_id} waits on: #{waits.empty? ? 'nothing recorded' : waits.map { |w| w['ref'] ? "#{w['kind']} (#{w['ref']})" : w['kind'] }.join(', ')}"
