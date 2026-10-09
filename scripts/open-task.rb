#!/usr/bin/env ruby
# frozen_string_literal: true

# Issue #55: open a task with a completion-gate decision.
#
# A conductor opens a new task with this instead of hand-writing status.yaml.
# It creates runs/<TASK_ID>/task.md, status.yaml and meta.yaml, and requires a
# decision about completion gates: presets (tasks/templates/gate-presets.yaml),
# custom gates, or --no-gates "<reason>". Gates are declared with the PM
# gate-plan reconcile (#28 Phase 2E), so every record and history row is
# byte-identical to scripts/update-completion-gate.rb declare.
#
# Usage:
#   ruby scripts/open-task.rb <TASK_ID> --title "<title>" [--agent <role>] [--actor <role>]
#     [--description "<text>"] ( --preset <name> ... | --gate <name>:<reason> ... | --no-gates "<reason>" )
#
# Exit: 0 opened; 1 namespace refused; 2 usage error; 3 the presets file is
# unreadable or malformed; 4 the task directory already exists; 5 a write failed
# after the directory was created (the directory was removed). Nothing is
# written unless the exit is 0.

require "yaml"
require "date"
require "fileutils"
require_relative "completion-guard"
require_relative "authorization-ledger"
require_relative "gate-presets"
require_relative "task-namespace"
require_relative "resolve-office-config"

OFFICE_DIR = File.expand_path("..", __dir__)
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
# validate-yaml.rb's TASK_ID_PATTERN.
TASK_ID_PATTERN = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/.freeze
# Roles that can take work: the validator forbids `done` as assignment.primary.
ASSIGNABLE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
FAIL_STEPS = %w[task_md status meta].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: open-task.rb <TASK_ID> --title \"<title>\" [--agent <role>] [--actor <role>] [--description \"<text>\"] " \
       "( --preset <name> ... | --gate <name>:<reason> ... | --no-gates \"<reason>\" )"
  exit 2
end

args, not_utf8 = CompletionGuard.utf8_argv(ARGV)
usage!("argument #{not_utf8.scrub.inspect} is not valid UTF-8") if not_utf8
task_id = args.shift.to_s.strip
usage! if task_id.empty? || task_id.start_with?("--")

opts = { presets: [], gates: [] }
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--title", "--description", "--agent", "--actor", "--no-gates"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    usage!("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
  when "--preset" then opts[:presets] << value.strip
  when "--gate"
    name, separator, reason = value.partition(":")
    usage!("--gate needs <name>:<reason>, got #{value.inspect}") if separator.empty?
    opts[:gates] << [name, reason]
  else usage!("unknown flag #{flag}")
  end
end

usage!("task id '#{task_id}' must match #{TASK_ID_PATTERN.inspect}") unless task_id.match?(TASK_ID_PATTERN)
usage!("--title is required") if opts[:title].to_s.empty?
agent = opts.fetch(:agent, "pm")
actor = opts.fetch(:actor, "pm")
usage!("--agent must be one of #{ASSIGNABLE_ROLES.join(', ')}") unless ASSIGNABLE_ROLES.include?(agent)
usage!("--actor must be one of #{ASSIGNABLE_ROLES.join(', ')}") unless ASSIGNABLE_ROLES.include?(actor)
gate_flags = !opts[:presets].empty? || !opts[:gates].empty?
if opts.key?(:no_gates)
  usage!("--no-gates cannot be combined with --preset or --gate") if gate_flags
  usage!("--no-gates needs a reason") if opts[:no_gates].empty?
elsif !gate_flags
  usage!("choose the task's completion gates: --preset <name> (#{%w[staging production backfill].join(', ')}), " \
         "--gate <name>:<reason>, or --no-gates \"<reason>\"")
end

# AI_OFFICE_OPEN_FAIL_AT is a TEST HOOK (the AI_OFFICE_NOW rule): it puts an
# obstacle where that file is about to be written, so the real write fails.
fail_at = ENV["AI_OFFICE_OPEN_FAIL_AT"].to_s
unless fail_at.empty?
  unless AuthorizationLedger.clock_override_allowed?
    usage!("AI_OFFICE_OPEN_FAIL_AT is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory")
  end
  usage!("AI_OFFICE_OPEN_FAIL_AT must be one of #{FAIL_STEPS.join(', ')}") unless FAIL_STEPS.include?(fail_at)
end

plan = nil
if gate_flags
  begin
    presets = opts[:presets].empty? ? {} : GatePresets.load(GatePresets.path)
    plan = GatePresets.compose(presets, opts[:presets], opts[:gates])
  rescue GatePresets::PlanError => e
    usage!(e.message)
  rescue GatePresets::Error => e
    warn e.message
    exit 3
  end
end

prefix = ENV["OFFICE_TASK_PREFIX"].to_s
if prefix.empty?
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  prefix = OfficeConfigResolver.new(OFFICE_DIR, profile: profile.empty? ? nil : profile).get("office.task_prefix", "").to_s
end
begin
  TaskNamespace.check_new_task!(task_id, prefix, File.join(OFFICE_DIR, "office.team.yaml"))
rescue TaskNamespace::Refused => e
  warn e.message
  exit 1
end

at = begin
  AuthorizationLedger.format_time(AuthorizationLedger.now_utc)
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
phase = agent == "pm" ? "pending" : "assigned"
gates = nil
changes = []
if plan
  gates, changes, conflict = CompletionGuard.reconcile_gate_plan({}, plan, actor: actor, at: at)
  usage!("the gate plan cannot be declared: #{conflict}") if conflict
end
gate_names = plan ? plan.map { |item| item["name"] } : []
opened_reason = if plan
                  "opened with completion gates: #{gate_names.join(', ')}"
                else
                  "opened without completion gates: #{opts[:no_gates]}"
                end
today = Date.today.to_s
status = {
  "task_id" => task_id,
  "task_label" => opts[:title],
  "phase" => phase,
  "state" => phase,
  "iteration" => 0,
  "current_agent" => agent,
  "ready" => true,
  "blocked_on" => [],
  "waiting_for" => [],
  "assignment" => { "primary" => agent, "parallel" => false },
  "created_at" => today,
  "updated_at" => today,
  "history" => [{ "phase" => "created -> #{phase}", "agent" => CompletionGuard.event_agent(actor),
                  "reason" => opened_reason, "at" => at }] + changes.map(&:first)
}
status["completion_gates"] = gates if plan
description = opts[:description].to_s.empty? ? "Describe the scope and acceptance criteria here before work starts." : opts[:description]
task_md = "# #{task_id}: #{opts[:title]}\n\n#{description}\n"
opened_details = plan ? "gates=#{gate_names.join(',')}" : "gates=none reason=#{opts[:no_gates]}"

FileUtils.mkdir_p(RUNS_DIR)
task_dir = File.join(RUNS_DIR, task_id)
begin
  Dir.mkdir(task_dir)
rescue Errno::EEXIST
  warn "#{task_id} already exists at #{task_dir}; open a new id (run intake for the next one)."
  exit 4
end

# From here the directory is ours: any failure removes it, so a half-opened
# task is never left behind.
begin
  lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)
  obstacle = ->(step, path) { Dir.mkdir(path) if fail_at == step }

  task_md_path = File.join(task_dir, "task.md")
  obstacle.call("task_md", task_md_path)
  File.write(task_md_path, task_md)

  status_path = File.join(task_dir, "status.yaml")
  obstacle.call("status", status_path)
  tmp_path = "#{status_path}.tmp.#{$$}"
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)

  obstacle.call("meta", File.join(task_dir, "meta.yaml"))
  # append_meta_event! warns and returns false on a write error; here that is a
  # failure, so every event goes through this one check.
  record_event = lambda do |type, details|
    recorded = CompletionGuard.append_meta_event!(task_dir, type: type, agent: CompletionGuard.event_agent(actor), details: details)
    raise IOError, "could not record the #{type} event in meta.yaml" unless recorded
  end
  record_event.call("task_opened", opened_details)
  changes.each { |_row, details| record_event.call("completion_gate_updated", details) }
  lock.close
rescue Exception => e # rubocop:disable Lint/RescueException -- a signal must roll back too
  lock&.close
  FileUtils.rm_rf(task_dir)
  if e.is_a?(SignalException) || e.is_a?(SystemExit)
    warn "Interrupted while opening #{task_id}. The task directory was removed."
    raise
  end
  warn "Could not open #{task_id}: #{e.message}. The task directory was removed."
  exit 5
end

puts "Opened #{task_id} (#{phase}, #{agent})" + (plan ? " with completion gates: #{gate_names.join(', ')}" : " without completion gates: #{opts[:no_gates]}")
puts "Next: ./run-agent.sh status #{task_id}"
