#!/usr/bin/env ruby
# frozen_string_literal: true

# The workflow-kernel half of run-agent.sh's `auto` pipeline loop (Phase 2 of
# issue #23, recommendation 2 — see docs/orchestration-boundary.md §4/§6 and
# docs/run-agent-classification.md "Boundary/glue: the auto loop").
#
# The auto loop's `while` body used to interleave, every iteration:
#   - a runtime action:  run_agent_invocation (re-exec run-agent.sh as a
#     subprocess, i.e. "execute role X")
#   - a workflow decision: next_agent_from_output + a fallback phase map +
#     a terminal ("done") check
# in one loop body with no interface between the two. This file IS that
# interface's decision half: `decide(step, output_path) -> {next, terminal}`,
# reachable and testable without spawning anything — it only reads a file
# already on disk. run-agent.sh's `auto` loop is now the runtime adapter: it
# calls run_agent_invocation to execute a role, reports back the resulting
# output file, and calls this script to decide what happens next.
#
# What this file deliberately does NOT absorb: the PM parallel-plan
# validity check (`parallel_plan_agents`) and the parallel dev-lane launch
# (`run_parallel_dev_agents` / `mark_parallel_dev_complete`) stay exactly
# where they are in run-agent.sh, untouched. Two reasons: (1) they are
# already decision-only / already side-effect-scoped the same way this file
# is — `parallel_plan_agents` reads pm-output.yaml and validates, no
# subprocess, no status write — so folding them in here would not close any
# additional workflow/runtime gap; (2) tests/integration/auto-parallel.sh
# asserts byte-for-byte stdout text ("Parallel plan invalid:", "owned file
# assigned to multiple parallel subtasks: ...", "shared file cannot be
# modified by multiple parallel agents") produced by that exact code path —
# reimplementing it here would risk a wording drift that breaks the test for
# no behavioral gain. See the Phase 2 completion report for the full
# reasoning.
#
# Usage:
#   ruby scripts/decide-next-step.rb <STEP> <STEP_OUTPUT_FILE> [STATUS_FILE]
#
# Prints one line: `next=<agent-or-empty> terminal=<true|false>` and always
# exits 0 (this is a pure decision, never a failure — an empty `next` simply
# means the loop ends here, exactly like the original heredoc's behavior).

require "yaml"
require "date"
require_relative "next-agent-from-output"
require_relative "completion-guard"

# Fallback phase map for when a role's own next_action.agent is absent —
# byte-for-byte the same table the auto loop's `case "$STEP"` implemented
# inline before this extraction.
FALLBACK_NEXT = {
  "pm" => "dev",
  "dev" => "reviewer",
  "dev-2" => "reviewer",
  "debugger" => "reviewer",
  "devops" => "reviewer",
  "reviewer" => "",
  "free-roam" => ""
}.freeze

step, output_path, status_path = ARGV
if step.nil? || output_path.nil?
  warn "Usage: decide-next-step.rb <STEP> <STEP_OUTPUT_FILE> [STATUS_FILE]"
  exit 2
end

next_agent = NextAgentFromOutput.compute(step, output_path).to_s
next_agent = FALLBACK_NEXT.fetch(step, "") if next_agent.empty?

terminal = (next_agent == "done")

# Issue #28: this decision reads only the role output, so on its own it would
# declare the task complete even when the status writer refused `done` because a
# declared completion gate is unresolved. When the caller supplies status.yaml,
# ask the same guard. Fail closed: an unreadable status is not terminal.
if terminal && status_path && File.exist?(status_path)
  begin
    status = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
    verdict = CompletionGuard.can_transition_to_done_in(status, File.dirname(status_path))
    unless verdict.allowed
      warn CompletionGuard.blocked_message(verdict.unresolved)
      terminal = false
      next_agent = ""
    end
  rescue StandardError => e
    warn "decide-next-step: could not read #{status_path} to check completion gates: #{e.message}"
    terminal = false
    next_agent = ""
  end
end

puts "next=#{next_agent} terminal=#{terminal}"
