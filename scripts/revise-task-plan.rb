#!/usr/bin/env ruby
# frozen_string_literal: true

# Governed Phase 2A writer (issue #28). Records a change of plan or scope as
# an append-only `revisions` entry in status.yaml and, in the SAME write,
# declares the completion gates and branches the change implies, or records
# why it implies none. A bare revision cannot be recorded. Gates and branches
# it declares are ordinary records, built exactly as update-completion-gate.rb
# and update-task-branch.rb build them; their existing guards give the teeth.
# This is not an authority system: actor and reason are unverified free text.
# See docs/plan-revisions.md.
#
# Usage:
#   ruby scripts/revise-task-plan.rb <TASK_ID> <kind> --actor A --reason R
#       ( [--gate NAME[:ACTION]]... [--branch NAME:ready | --branch NAME:blocked:WAITING]...
#         | --no-new-gates WHY )
#
# Exit: 0 recorded, or the identical last revision is already recorded;
# 2 usage error or refused revision; 3 unreadable or malformed status.yaml,
# revisions, completion_gates or branches; 9 ownership fence refused (raised
# by TaskOwnership.fence!, see docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "branch-projection"
require_relative "authorization-ledger"
require_relative "plan-revisions"

FINISHED_PHASES = %w[done aborted].freeze

def refuse(message, code = 2)
  warn "revise-task-plan: #{message}"
  exit code
end

task_id, kind, *args = ARGV
refuse("expected TASK_ID KIND --actor A --reason R (--gate ... | --branch ... | --no-new-gates WHY)") unless task_id && kind
refuse("invalid task id") unless task_id.match?(/\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/)
refuse("unknown kind #{kind.inspect} (expected #{PlanRevisions::KINDS.join(', ')})") unless PlanRevisions::KINDS.include?(kind)

opts = { gates: [], branches: [] }
until args.empty?
  flag = args.shift
  value = args.shift
  refuse("#{flag} needs a value") if value.nil?
  case flag
  when "--actor", "--reason", "--no-new-gates"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    refuse("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
  when "--gate"
    name, action, extra = value.strip.split(":", 3)
    if extra || name.to_s.empty? || (value.include?(":") && action.to_s.empty?)
      refuse("--gate takes NAME or NAME:ACTION, got #{value.inspect}")
    end
    refuse("gate name #{name.inspect} must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless name.match?(CompletionGuard::GATE_NAME_PATTERN)
    if action && !AuthorizationLedger::ACTIONS.include?(action)
      refuse("unknown authorization action #{action.inspect} (expected #{AuthorizationLedger::ACTIONS.join(', ')})")
    end
    opts[:gates] << { "name" => name, "action" => action }
  when "--branch"
    # Everything after the second colon is the waiting text; it may contain colons.
    name, state, waiting = value.split(":", 3)
    unless name.to_s.match?(CompletionGuard::BRANCH_NAME_PATTERN)
      refuse("branch name #{name.inspect} must match #{CompletionGuard::BRANCH_NAME_PATTERN.inspect}")
    end
    case state
    when "ready"
      refuse("--branch #{name}:ready takes no waiting text") unless waiting.nil?
      opts[:branches] << { "name" => name, "state" => "ready", "waiting_for" => [] }
    when "blocked"
      refuse("--branch #{name}:blocked needs waiting text: NAME:blocked:TEXT") if waiting.to_s.strip.empty?
      opts[:branches] << { "name" => name, "state" => "blocked", "waiting_for" => [waiting.strip] }
    else
      refuse("--branch takes NAME:ready or NAME:blocked:TEXT, got #{value.inspect}")
    end
  else
    refuse("unknown flag #{flag.inspect}")
  end
end

refuse("--actor and --reason are required") if opts[:actor].to_s.empty? || opts[:reason].to_s.empty?
declares = !(opts[:gates].empty? && opts[:branches].empty?)
if opts.key?(:no_new_gates)
  refuse("--no-new-gates needs a reason") if opts[:no_new_gates].empty?
  refuse("pass either --gate/--branch or --no-new-gates, not both") if declares
elsif !declares
  refuse("a revision must declare --gate/--branch or say --no-new-gates WHY")
end
gate_names = opts[:gates].map { |gate| gate["name"] }
branch_names = opts[:branches].map { |branch| branch["name"] }
refuse("gate declared twice in one revision") unless gate_names.uniq.size == gate_names.size
refuse("branch declared twice in one revision") unless branch_names.uniq.size == branch_names.size

runs_dir = ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
task_dir = File.join(runs_dir, task_id)
status_path = File.join(task_dir, "status.yaml")
refuse("missing #{status_path}", 3) unless File.file?(status_path)

# Same critical section as every other status writer: per-task lock, then the
# ownership fence inside it. Everything below is checked before anything changes.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

# ONE clock read: every record and history row of this revision carries it.
now = begin
  AuthorizationLedger.format_time(AuthorizationLedger.now_utc)
rescue AuthorizationLedger::Error => e
  refuse(e.message)
end

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true)
rescue StandardError => e
  refuse("cannot read status.yaml: #{e.message}", 3)
end
refuse("status.yaml must be a map for #{task_id}", 3) unless status.is_a?(Hash) && status["task_id"] == task_id
refuse("status.yaml completion_gates must be a map", 3) if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
if !opts[:branches].empty? || status.key?("branches")
  branch_error = CompletionGuard.branch_state_error(status)
  refuse(branch_error, 3) if branch_error
end
revision_errors = PlanRevisions.stored_errors(status, "status.yaml")
refuse("cannot build on malformed revisions: #{revision_errors.first}", 3) unless revision_errors.empty?

phase = status["phase"].to_s
refuse("cannot revise the plan of a #{phase} task") if FINISHED_PHASES.include?(phase)

revisions = status["revisions"] || []
gates = status["completion_gates"] || {}
content = PlanRevisions.content(kind: kind, actor: opts[:actor], reason: opts[:reason],
                                gates: gate_names, branches: branch_names, no_new_gates: opts[:no_new_gates])
# A retry after a crash between "wrote" and "printed" must not fail on
# "already declared": checked before any gate or branch is created. Bindings
# are compared too, because the entry stores gate names only.
same_bindings = opts[:gates].all? do |gate|
  gates[gate["name"]].is_a?(Hash) && gates[gate["name"]]["requires_authorization"] == gate["action"]
end
if same_bindings && PlanRevisions.same_content?(revisions.last, content)
  puts "plan revision #{revisions.last['id']} already recorded"
  exit 0
end

if !opts[:branches].empty? && !BranchProjection::UPDATABLE_PHASES.include?(phase)
  refuse("branches cannot be declared on a #{phase} task")
end
taken = gate_names.select { |name| gates.key?(name) }
refuse("gate(s) already declared: #{taken.join(', ')}; resolve them with update-completion-gate.rb") unless taken.empty?
existing_branches = status["branches"] || {}
taken = branch_names.select { |name| existing_branches.key?(name) }
refuse("branch(es) already declared: #{taken.join(', ')}; update them with update-task-branch.rb") unless taken.empty?

# Build. Key insertion order matches the existing writers run in sequence.
gates = (status["completion_gates"] ||= {}) unless opts[:gates].empty?
branches = (status["branches"] ||= {}) unless opts[:branches].empty?
status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
opts[:gates].each do |gate|
  gates[gate["name"]] = CompletionGuard.gate_record(status: "pending", actor: opts[:actor], reason: opts[:reason],
                                                    updated_at: now, requires_authorization: gate["action"])
  status["history"] << CompletionGuard.gate_history_row(gate["name"], "absent", "pending",
                                                        actor: opts[:actor], reason: opts[:reason], at: now)
end
opts[:branches].each do |branch|
  branches[branch["name"]] = CompletionGuard.branch_record(state: branch["state"], actor: opts[:actor], reason: opts[:reason],
                                                           updated_at: now, waiting_for: branch["waiting_for"])
  old_phase = status["phase"]
  BranchProjection.apply!(status)
  status["history"] << CompletionGuard.branch_history_row(
    branch["name"], from: "declared", to: branch["state"], old_phase: old_phase, new_phase: status["phase"],
    actor: opts[:actor], reason: opts[:reason], at: now
  )
end
id = PlanRevisions.next_id(revisions)
status["revisions"] = revisions + [PlanRevisions.build_entry(id: id, at: now, content: content)]
status["history"] << {
  "phase" => "plan revision #{id}: #{kind}",
  "agent" => CompletionGuard.event_agent(opts[:actor]),
  "reason" => opts[:reason],
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

effects = opts.key?(:no_new_gates) ? "no_new_gates" : "gates=#{gate_names.join(',')} branches=#{branch_names.join(',')}"
CompletionGuard.append_meta_event!(task_dir, type: "plan_revised", agent: CompletionGuard.event_agent(opts[:actor]),
                                   details: "revision=#{id} kind=#{kind} #{effects} task_phase=#{status['phase']}")
puts "plan revision #{id}: #{kind} (task #{status['phase']})"
