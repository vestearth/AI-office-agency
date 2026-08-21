#!/usr/bin/env ruby
# frozen_string_literal: true

# Reference implementation of the runtime-adapter contract's "what's next"
# query (Phase 3 of issue #23 — see docs/runtime-adapter-contract.md).
#
# This is deliberately a thin, read-only wrapper around artifacts and scripts
# Phase 2 already built: it reads runs/<task-id>/status.yaml directly (same
# fields docs/task-transition-contract.md documents as the stable contract)
# and, when a role's output file already exists on disk but has not yet been
# synced into status.yaml (the exact "manual output waiting to be recorded"
# state docs/task-transition-contract.md's record/import section describes),
# it previews the next agent by calling `NextAgentFromOutput.compute` — the
# same library function scripts/next-agent-from-output.rb and
# scripts/decide-next-step.rb already use. No status.yaml write, no runner
# invocation, no ownership acquisition: this script only ever reads.
#
# Any external runtime/control-plane (Multica, a future dispatcher, a human
# with a script) can poll this to answer "what should happen next for
# TASK-X" as machine-readable JSON, without needing to understand
# run-agent.sh's internals or shell into it. It is optional: nothing in the
# workflow kernel calls this script, and the workflow works identically if
# it is never invoked (`./run-agent.sh status TASK-X` remains the
# human-readable equivalent).
#
# Usage:
#   ruby scripts/adapter-status.rb <TASK_ID> [--pretty]
#
# Exit: 0 on success (including a task with no pending output, or a
# terminal/blocked task); 1 if the task directory does not exist; 2 usage
# error.

require "yaml"
require "date"
require "json"
require "digest"
require "open3"
require_relative "next-agent-from-output"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
VALIDATOR = File.join(OFFICE_DIR, "validate-yaml.rb")

TERMINAL_AGENTS = %w[done].freeze

def die(message, code)
  warn message
  exit code
end

def load_yaml(path)
  return {} unless File.exist?(path)

  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError
  {}
end

def list_value(value)
  Array(value).map(&:to_s).map(&:strip).reject(&:empty?)
end

def validation_status(task_id)
  return "unknown" unless File.exist?(VALIDATOR)

  _stdout, _stderr, status = Open3.capture3("ruby", VALIDATOR, task_id)
  status.success? ? "pass" : "fail"
rescue StandardError
  "unknown"
end

task_id, *rest = ARGV
pretty = rest.include?("--pretty")
die "Usage: adapter-status.rb <TASK_ID> [--pretty]", 2 if task_id.nil? || task_id.empty?

task_dir = File.join(RUNS_DIR, task_id)
die "Task not found: #{task_id}", 1 unless File.directory?(task_dir)

status = load_yaml(File.join(task_dir, "status.yaml"))
phase = status["phase"].to_s
state = status["state"].to_s
current_agent = status["current_agent"].to_s
blocked_on = list_value(status["blocked_on"])
waiting_for = list_value(status["waiting_for"])
last_synced_output = status["last_synced_output"].is_a?(Hash) ? status["last_synced_output"] : nil

terminal = TERMINAL_AGENTS.include?(current_agent) || phase == "done" || state == "done"
blocked = phase == "blocked" || state == "blocked"

next_command = if terminal
                 nil
               elsif blocked
                 nil
               elsif current_agent.empty?
                 nil
               else
                 "./run-agent.sh #{task_id} #{current_agent}"
               end

pending_manual_output = nil
if !terminal && !current_agent.empty?
  output_path = File.join(task_dir, "#{current_agent}-output.yaml")
  if File.exist?(output_path)
    digest = Digest::SHA256.file(output_path).hexdigest
    basename = File.basename(output_path)
    already_synced = last_synced_output.is_a?(Hash) &&
                      last_synced_output["digest"] == digest &&
                      last_synced_output["file"] == basename

    pending_manual_output = {
      "path" => output_path,
      "exists" => true,
      "already_synced" => already_synced
    }
    pending_manual_output["next_agent_preview"] = NextAgentFromOutput.compute(current_agent, output_path) unless already_synced
  end
end

recent_history = Array(status["history"]).select { |h| h.is_a?(Hash) }.last(5)

result = {
  "task_id" => task_id,
  "phase" => phase.empty? ? nil : phase,
  "state" => state.empty? ? nil : state,
  "current_agent" => current_agent.empty? ? nil : current_agent,
  "iteration" => status["iteration"],
  "blocked_on" => blocked_on,
  "waiting_for" => waiting_for,
  "terminal" => terminal,
  "blocked" => blocked,
  "next_command" => next_command,
  "pending_manual_output" => pending_manual_output,
  "last_synced_output" => last_synced_output,
  "validation" => validation_status(task_id),
  "recent_history" => recent_history
}

puts(pretty ? JSON.pretty_generate(result) : JSON.generate(result))
exit 0
