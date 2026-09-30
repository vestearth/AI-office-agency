#!/usr/bin/env ruby
# frozen_string_literal: true

# The one governed writer for completion gates (issue #28, Phase 1A).
#
# Agents and operators must not hand-edit `completion_gates` in status.yaml:
# every declaration and every resolution goes through here so it is locked,
# ownership-fenced, validated, and recorded in status history AND meta.yaml.
# This is not a general authority system. `actor` is free text; Phase 1A does
# not verify identity or independence (see docs/completion-gates.md).
#
# Usage:
#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>]
#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002]
#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
#
# Exit: 0 ok; 2 usage error or invalid transition; 3 unreadable status.yaml or
# an evidence id that does not resolve; 9 ownership fence refused (raised by
# TaskOwnership.fence!, see docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
EVIDENCE_ID_PATTERN = /\Aev-\d{3,}\z/.freeze
ACTIONS = { "declare" => "pending", "pass" => "pass", "na" => "na" }.freeze
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na> <GATE> --actor <A> [--reason <R>] [--evidence ev-001,ev-002]"
  exit 2
end

args = ARGV.dup
task_id = args.shift
action = args.shift
gate_name = args.shift
usage! if task_id.nil? || action.nil? || gate_name.nil?
usage!("unknown action '#{action}' (expected declare, pass or na)") unless ACTIONS.key?(action)
usage!("gate name '#{gate_name}' must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless gate_name.match?(CompletionGuard::GATE_NAME_PATTERN)

opts = {}
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--actor" then opts[:actor] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--evidence" then opts[:evidence] = value.split(",").map(&:strip).reject(&:empty?)
  else usage!("unknown flag #{flag}")
  end
end

usage!("--actor is required") if opts[:actor].to_s.empty?
usage!("--reason is required for #{action}") if %w[pass na].include?(action) && opts[:reason].to_s.empty?
usage!("--evidence is only valid with pass") if opts.key?(:evidence) && action != "pass"
Array(opts[:evidence]).each do |ref|
  usage!("evidence id '#{ref}' must match ev-NNN") unless ref.match?(EVIDENCE_ID_PATTERN)
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
existing = gates[gate_name]
new_status = ACTIONS.fetch(action)

if action == "declare"
  usage!("gate '#{gate_name}' is already declared; resolve it with pass or na") unless existing.nil?
else
  usage!("gate '#{gate_name}' is not declared for #{task_id}; declare it first") unless existing.is_a?(Hash)
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
now = Time.now.utc.strftime("%FT%TZ")

record = { "status" => new_status, "actor" => opts[:actor] }
record["reason"] = opts[:reason] unless opts[:reason].to_s.empty?
record["updated_at"] = now
record["evidence_refs"] = Array(opts[:evidence])
gates[gate_name] = record

status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "gate #{gate_name}: #{old_status} -> #{new_status}",
  "agent" => CompletionGuard.event_agent(opts[:actor]),
  "reason" => opts[:reason].to_s.empty? ? "completion gate declared" : opts[:reason],
  "at" => now
}

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
  details: "gate=#{gate_name} #{old_status}->#{new_status} actor=#{opts[:actor]}"
)

puts "gate #{gate_name}: #{old_status} -> #{new_status}"
