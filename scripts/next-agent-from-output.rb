#!/usr/bin/env ruby
# frozen_string_literal: true

# Standalone extraction of run-agent.sh's `next_agent_from_output` Ruby
# heredoc (Phase 2 of issue #23 — see docs/orchestration-boundary.md §6,
# recommendation 1). Behavior is unchanged: same ARGV, same stdout, same exit
# code when run as a CLI.
#
# Structured as a library module (`NextAgentFromOutput.compute`) with a thin
# CLI wrapper below, so `scripts/decide-next-step.rb` (recommendation 2 — the
# auto loop's decision half) can call it in-process without spawning a
# subprocess, while `ruby scripts/next-agent-from-output.rb <AGENT> <FILE>`
# keeps working exactly as before for any other caller.
#
# Pure reader: extracts next_action.agent from a role's <role>-output.yaml
# (or, for the reviewer, falls back to review_verdict when next_action is
# absent). No status.yaml write, no runner invocation — decision logic only.

require "yaml"
require "date"

module NextAgentFromOutput
  module_function

  # Returns the next agent as a String (possibly empty), or nil if the output
  # file does not exist yet.
  def compute(actor_agent, output_path)
    return nil unless File.exist?(output_path)

    output = YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true) || {}
    next_action = output["next_action"].is_a?(Hash) ? output["next_action"] : {}
    next_agent = next_action["agent"]&.to_s&.strip

    if (next_agent.nil? || next_agent.empty?) && actor_agent == "reviewer"
      verdict = output["review_verdict"].to_s.strip
      next_agent = case verdict
                   when "approved" then "done"
                   when "changes_requested" then "debugger"
                   when "escalate" then "free-roam"
                   when "infra_failure" then "devops"
                   else nil
                   end
    end

    next_agent.to_s
  end
end

if $PROGRAM_NAME == __FILE__
  # Usage:
  #   ruby scripts/next-agent-from-output.rb <ACTOR_AGENT> <OUTPUT_FILE>
  #
  # Prints the next agent (possibly empty) to stdout, no trailing newline, to
  # match the original heredoc's `print`. Exit: always 0.
  actor_agent, output_path = ARGV
  if actor_agent.nil? || output_path.nil?
    warn "Usage: next-agent-from-output.rb <ACTOR_AGENT> <OUTPUT_FILE>"
    exit 2
  end

  print(NextAgentFromOutput.compute(actor_agent, output_path) || "")
end
