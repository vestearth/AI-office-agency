#!/usr/bin/env ruby
# frozen_string_literal: true

# The one governed writer for completion gates (issue #28, Phase 1A + 1B.1).
#
# Agents and operators must not hand-edit `completion_gates` in status.yaml:
# every declaration and every resolution goes through here so it is locked,
# ownership-fenced, validated, and recorded in status history AND meta.yaml.
# This is not a general authority system. `actor` is free text; identity and
# independence are not verified (see docs/completion-gates.md).
#
# Phase 1B.1: a gate may be BOUND to an authorization at declare time
# (`--requires-authorization <action>`). The requirement is immutable and is
# carried forward on every transition — this script rebuilds the whole gate
# record each time, so forgetting it would silently downgrade the gate to
# Phase 1A semantics. Passing a bound gate needs `--authorization authz-NNN,…`:
# each must be a grant of this task, for exactly the required action, valid as
# of (T, S) where T is the pass time and S the ledger's high-water id. T and S
# are read ONCE under the task lock and are the values stored as `updated_at`
# and `authorization_through`, so the writer's decision and the guard's later
# re-evaluation always agree (see scripts/authorization-ledger.rb).
#
# Phase 2B: a gate may declare `after: [gates]` (`--after` on declare, or the
# `depend` action on a pending gate; add-only, acyclic). It cannot be passed
# until those gates are resolved, judged exactly as the done guard judges
# them. `after` is carried forward on every transition, like the binding.
#
# Phase 2C: a pass may record what actually ran (`--ran-by` plus `--ran-ref`
# and/or an https `--ran-url`). A gate may require that record
# (`--requires-record` on declare, or the `require-record` action on a
# pending gate; add-only, carried forward). `ran` is written only by pass.
#
# Usage:
#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>] [--after G1,G2] [--requires-record]
#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002] [--authorization authz-001,authz-002] [--ran-by B --ran-ref R --ran-url https://...]
#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
#   ruby scripts/update-completion-gate.rb <TASK_ID> depend  <GATE> --after G1,G2 --actor <A> --reason <R>
#   ruby scripts/update-completion-gate.rb <TASK_ID> require-record <GATE> --actor <A> --reason <R>
#
# Exit: 0 ok; 2 usage error or invalid transition; 3 unreadable or missing
# status.yaml / authorization ledger, non-map completion_gates, malformed
# stored ordering or run record, unknown evidence id; 9 ownership fence refused (raised by TaskOwnership.fence!, see
# docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "authorization-ledger"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
EVIDENCE_ID_PATTERN = /\Aev-\d{3,}\z/.freeze
TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na", "depend" => "pending", "require-record" => "pending" }.freeze
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na|depend|require-record> <GATE> --actor <A> [--reason <R>] " \
       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002] " \
       "[--after G1,G2] [--requires-record] [--ran-by B --ran-ref R --ran-url https://...]"
  exit 2
end

args = ARGV.dup
task_id = args.shift
action = args.shift
gate_name = args.shift
usage! if task_id.nil? || action.nil? || gate_name.nil?
usage!("unknown action '#{action}' (expected declare, pass, na, depend or require-record)") unless TRANSITIONS.key?(action)
usage!("gate name '#{gate_name}' must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless gate_name.match?(CompletionGuard::GATE_NAME_PATTERN)

opts = {}
until args.empty?
  flag = args.shift
  # The one switch: it takes no value.
  if flag == "--requires-record"
    usage!("duplicate --requires-record") if opts.key?(:requires_record)
    opts[:requires_record] = true
    next
  end
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  # The switch never stands in for a value: a bare --reason/--actor before it
  # would otherwise swallow it and silently drop the requirement.
  usage!("flag #{flag} needs a value, not --requires-record") if value == "--requires-record"
  case flag
  when "--actor" then opts[:actor] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--evidence" then opts[:evidence] = value.split(",").map(&:strip).reject(&:empty?)
  when "--requires-authorization" then opts[:requires_authorization] = value.strip
  when "--authorization" then opts[:authorization] = value.split(",").map(&:strip).reject(&:empty?).uniq
  when "--after" then (opts[:after] ||= []).concat(value.split(",", -1).map(&:strip))
  when "--ran-by", "--ran-ref", "--ran-url"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    usage!("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
  else usage!("unknown flag #{flag}")
  end
end

usage!("--actor is required") if opts[:actor].to_s.empty?
usage!("--reason is required for #{action}") if %w[pass na depend require-record].include?(action) && opts[:reason].to_s.empty?
usage!("--evidence is only valid with pass") if opts.key?(:evidence) && action != "pass"
Array(opts[:evidence]).each do |ref|
  usage!("evidence id '#{ref}' must match ev-NNN") unless ref.match?(EVIDENCE_ID_PATTERN)
end
usage!("--requires-authorization is only valid with declare") if opts.key?(:requires_authorization) && action != "declare"
if opts.key?(:requires_authorization) && !AuthorizationLedger::ACTIONS.include?(opts[:requires_authorization])
  usage!("--requires-authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}")
end
usage!("--authorization is only valid with pass") if opts.key?(:authorization) && action != "pass"
Array(opts[:authorization]).each do |ref|
  usage!("authorization id '#{ref}' must match authz-NNN") if AuthorizationLedger.id_number(ref).nil?
end
usage!("--after is only valid with declare or depend") if opts.key?(:after) && !%w[declare depend].include?(action)
usage!("depend needs --after <gate>[,<gate>]") if action == "depend" && !opts.key?(:after)
new_after = Array(opts[:after])
usage!("--after needs at least one gate") if opts.key?(:after) && new_after.empty?
new_after.each do |dep|
  usage!("gate name '#{dep}' in --after must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless dep.match?(CompletionGuard::GATE_NAME_PATTERN)
end
usage!("--after names a gate twice") unless new_after.uniq.size == new_after.size
usage!("gate '#{gate_name}' cannot wait on itself") if new_after.include?(gate_name)
usage!("--requires-record is only valid with declare") if opts.key?(:requires_record) && action != "declare"
ran_flags = %i[ran_by ran_ref ran_url].select { |key| opts.key?(key) }
usage!("--ran-by/--ran-ref/--ran-url are only valid with pass") if !ran_flags.empty? && action != "pass"
run_record = nil
unless ran_flags.empty?
  run_record = {}
  run_record["by"] = opts[:ran_by] if opts.key?(:ran_by)
  run_record["ref"] = opts[:ran_ref] if opts.key?(:ran_ref)
  run_record["url"] = opts[:ran_url] if opts.key?(:ran_url)
  record_problems = CompletionGuard.ran_errors(run_record)
  usage!("invalid run record: #{record_problems.join('; ')}") unless record_problems.empty?
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.exist?(status_path)
  warn "No status.yaml for #{task_id} at #{status_path}"
  exit 3
end

# Same critical section as every other status writer: per-task lock, then the
# ownership fence inside it.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

# ONE clock read for the whole critical section. T is used for the validity
# check AND stored as updated_at / the history timestamp: never read the clock
# twice (an expiry boundary could make the two disagree).
pass_time = begin
  AuthorizationLedger.now_utc
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
now = AuthorizationLedger.format_time(pass_time)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  exit 3
end

phase = status["phase"].to_s.strip
if FINISHED_PHASES.include?(phase)
  warn "Refusing to edit completion gates: #{task_id} is #{phase}."
  exit 2
end

if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
  warn "status.yaml completion_gates is not a map; fix it by hand before using this helper."
  exit 3
end
gates = (status["completion_gates"] ||= {})
ordering_problems = CompletionGuard.ordering_errors(gates) + CompletionGuard.run_record_errors(gates)
unless ordering_problems.empty?
  warn "status.yaml #{ordering_problems.first}; fix it by hand before using this helper."
  exit 3
end
existing = gates[gate_name]
new_status = TRANSITIONS.fetch(action)

if action == "declare"
  usage!("gate '#{gate_name}' is already declared; resolve it with pass or na") unless existing.nil?
else
  usage!("gate '#{gate_name}' is not declared for #{task_id}; declare it first") unless existing.is_a?(Hash)
end
if action == "depend" && existing["status"] != "pending"
  usage!("gate '#{gate_name}' is #{existing['status']}; an ordering can only be added to a pending gate")
end
if action == "require-record"
  if existing["status"] != "pending"
    usage!("gate '#{gate_name}' is #{existing['status']}; a record requirement can only be added to a pending gate")
  end
  usage!("gate '#{gate_name}' already requires a ran record") if existing["requires_record"] == true
end
if action == "pass" && existing["requires_record"] == true && run_record.nil?
  usage!("gate '#{gate_name}' requires a ran record: pass it with --ran-by and --ran-ref/--ran-url")
end
unknown_deps = new_after.reject { |dep| gates[dep].is_a?(Hash) }
usage!("--after names #{unknown_deps.join(', ')}, which is not a declared gate") unless unknown_deps.empty?
if action == "depend"
  present = new_after & CompletionGuard.gate_after(existing)
  usage!("gate '#{gate_name}' already waits on #{present.join(', ')}") unless present.empty?
  looped = new_after.select { |dep| CompletionGuard.gate_reaches?(gates, dep, gate_name) }
  usage!("--after #{looped.join(', ')} would create a cycle: it already waits on '#{gate_name}'") unless looped.empty?
end

# Ordered pass: every gate in `after` must be resolved, as the done guard
# judges it (a bound dependency needs its recorded grant to hold).
if action == "pass" && !CompletionGuard.gate_after(existing).empty?
  deps = CompletionGuard.gate_after(existing)
  dep_index = nil
  if deps.any? { |dep| gates[dep].is_a?(Hash) && gates[dep].key?("requires_authorization") }
    dep_index = begin
      AuthorizationLedger.load(task_dir)
    rescue AuthorizationLedger::Error => e
      warn e.message
      exit 3
    end
  end
  waiting = CompletionGuard.unresolved_dependencies(gates, existing, dep_index)
  unless waiting.empty?
    labels = waiting.map { |dep| CompletionGuard.dependency_label(gates, dep) }
    usage!("gate '#{gate_name}' waits on: #{labels.join(', ')}")
  end
end

# The requirement declared with the gate. Immutable: taken from the declare
# flag, or carried forward from the existing record on every later transition.
bound_action = action == "declare" ? opts[:requires_authorization] : (existing.is_a?(Hash) ? existing["requires_authorization"] : nil)
if action != "declare" && existing.is_a?(Hash) && existing.key?("requires_authorization") &&
   !AuthorizationLedger::ACTIONS.include?(bound_action)
  warn "gate '#{gate_name}' has an unknown requires_authorization #{bound_action.inspect}; fix it by hand before using this helper."
  exit 3
end

authorization_refs = nil
authorization_through = nil
if action == "pass"
  if bound_action
    usage!("gate '#{gate_name}' requires authorization '#{bound_action}': pass it with --authorization authz-NNN[,…]") if Array(opts[:authorization]).empty?
    index = begin
      AuthorizationLedger.load(task_dir)
    rescue AuthorizationLedger::Error => e
      warn e.message
      exit 3
    end
    authorization_through = index.high_water_id # S: read once, under the lock
    usage!("no authorization is recorded for #{task_id}; record a grant with scripts/record-authorization.rb first") if authorization_through.nil?
    invalid = opts[:authorization].reject do |ref|
      index.valid_grant?(ref, action: bound_action, at: pass_time, through: authorization_through)
    end
    unless invalid.empty?
      usage!("not a valid '#{bound_action}' grant as of #{now} (unknown id, wrong action, expired, revoked, or not yet granted): #{invalid.join(', ')}")
    end
    authorization_refs = opts[:authorization]
  elsif opts.key?(:authorization)
    usage!("gate '#{gate_name}' does not declare requires_authorization; --authorization is not valid for it")
  end
end

if action == "pass" && !Array(opts[:evidence]).empty?
  ledger_path = File.join(task_dir, "evidence.yaml")
  known = if File.exist?(ledger_path)
            ledger = YAML.safe_load(File.read(ledger_path), permitted_classes: [Date, Time], aliases: true)
            Array(ledger.is_a?(Hash) ? ledger["evidence"] : nil).map { |e| e["id"] if e.is_a?(Hash) }.compact
          else
            []
          end
  unknown = opts[:evidence] - known
  unless unknown.empty?
    warn "Unknown evidence id(s) for #{task_id}: #{unknown.join(', ')} (not in evidence.yaml)"
    exit 3
  end
end

old_status = existing.is_a?(Hash) ? existing["status"].to_s : "absent"

if action == "depend"
  # depend changes only `after`; the gate's own status and metadata stay.
  gates[gate_name] = existing.merge("after" => CompletionGuard.gate_after(existing) + new_after)
  history_row = {
    "phase" => "gate #{gate_name}: after += #{new_after.join(',')}",
    "agent" => CompletionGuard.event_agent(opts[:actor]),
    "reason" => opts[:reason],
    "at" => now
  }
  event_details = "gate=#{gate_name} after+=#{new_after.join(',')} actor=#{opts[:actor]}"
  summary = "gate #{gate_name}: after += #{new_after.join(',')}"
elsif action == "require-record"
  # require-record changes only `requires_record`; everything else stays.
  gates[gate_name] = existing.merge("requires_record" => true)
  history_row = {
    "phase" => "gate #{gate_name}: requires_record",
    "agent" => CompletionGuard.event_agent(opts[:actor]),
    "reason" => opts[:reason],
    "at" => now
  }
  event_details = "gate=#{gate_name} requires_record actor=#{opts[:actor]}"
  summary = "gate #{gate_name}: requires_record"
else
  # `after` is carried forward exactly like the binding: the record is rebuilt.
  carried_after = action == "declare" ? opts[:after] : existing["after"]
  gates[gate_name] = CompletionGuard.gate_record(
    status: new_status, actor: opts[:actor], reason: opts[:reason], updated_at: now,
    evidence_refs: opts[:evidence], requires_authorization: bound_action,
    authorization_refs: authorization_refs, authorization_through: authorization_through,
    after: carried_after,
    requires_record: action == "declare" ? opts[:requires_record] : existing["requires_record"] == true,
    ran: action == "pass" ? run_record : nil
  )
  history_row = CompletionGuard.gate_history_row(gate_name, old_status, new_status,
                                                 actor: opts[:actor], reason: opts[:reason], at: now)
  event_details = "gate=#{gate_name} #{old_status}->#{new_status} actor=#{opts[:actor]}"
  summary = "gate #{gate_name}: #{old_status} -> #{new_status}"
end

status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << history_row

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

CompletionGuard.append_meta_event!(
  task_dir,
  type: "completion_gate_updated",
  agent: CompletionGuard.event_agent(opts[:actor]),
  details: event_details
)

puts summary
