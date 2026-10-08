#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2F (issue #28): the gate view as JSON, for the dashboard. Prints
# CompletionGuard.gate_view for one task, adding to each gate its CLI text
# ("detail", from GateStatusText.suffix), so the dashboard shows the same words
# as `run-agent.sh status` and the prompt's COMPLETION GATES block.
#
# Usage: ruby scripts/gate-view-json.rb <task_dir>
#
# Read-only, and always exits 0. A view that cannot be built prints
# readable=false with the problem and no gates, never an empty "all clear".

require "json"
require "yaml"
require "date"
require_relative "completion-guard"
require_relative "gate-status-text"

module GateViewJson
  module_function

  def unreadable(problem)
    {
      "readable" => false, "problem" => problem, "finished_phase" => nil,
      "summary" => { "total" => 0, "resolved" => 0, "passable" => 0, "by_status" => {} },
      "gates" => []
    }
  end

  def view(task_dir)
    status = YAML.safe_load(File.read(File.join(task_dir, "status.yaml")), permitted_classes: [Date, Time], aliases: true)
    view = CompletionGuard.gate_view(status, task_dir)
    return unreadable(view["problem"]) unless view["readable"]

    finished = view["finished_phase"]
    gates = view["gates"].map { |gate| gate.merge("detail" => GateStatusText.suffix(gate, finished).sub(/\A — /, "")) }
    { "readable" => true, "problem" => nil, "finished_phase" => finished, "summary" => view["summary"], "gates" => gates }
  end
end

if $PROGRAM_NAME == __FILE__
  output = begin
    JSON.generate(GateViewJson.view(ARGV[0].to_s))
  rescue StandardError => e
    JSON.generate(GateViewJson.unreadable("gate view failed: #{e.class}"))
  end
  puts output
  exit 0
end
