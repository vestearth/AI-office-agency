#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2D/2E (issue #28): the plain-text gate view, rendered from the read-only
# CompletionGuard.gate_view. Shared by `run-agent.sh status` and the dispatched
# prompt's --- COMPLETION GATES --- block, so both show the same lines.
#
# As a script: ruby scripts/gate-status-text.rb <task_dir> prints the
# Gates/Revisions lines (nothing for a task without completion_gates or
# revisions), or "Gates: unavailable" when the task cannot be rendered. It never
# writes and always exits 0, so it can never fail a dispatch.

require "yaml"
require "date"
require_relative "completion-guard"

module GateStatusText
  module_function

  # The Gates/Revisions lines for one task.
  def lines(status, task_dir)
    return [] unless status.is_a?(Hash) && (status.key?("completion_gates") || status.key?("revisions"))

    view = CompletionGuard.gate_view(status, task_dir)
    lines = []
    if status.key?("completion_gates")
      if view["readable"]
        lines << "Gates: #{view['summary']['resolved']}/#{view['summary']['total']} resolved"
        view["gates"].each { |gate| lines << "  #{gate['name']}: #{gate['status']}#{suffix(gate, view['finished_phase'])}" }
      else
        lines << "Gates: unreadable (#{view['problem']}; run validate-yaml.rb)"
      end
    end
    revisions = view["revisions"]
    lines << if revisions["count"].zero? then "Revisions: none"
             elsif revisions["latest"] then "Revisions: #{revisions['count']}, latest #{revisions['latest'].values_at('id', 'kind').join(' ')} @#{revisions['latest']['at']}"
             else "Revisions: #{revisions['count']}"
             end
    lines
  end

  def suffix(gate, finished_phase = nil)
    case gate["status"]
    when "pass", "na"
      return " — NOT resolved: #{gate['unresolved_reason']}" unless gate["resolved"]
      return "" unless gate["ran"].is_a?(Hash)

      " — ran: #{gate['ran']['by']} #{gate['ran']['ref'] || gate['ran']['url']}"
    when "pending"
      if finished_phase
        " — task is #{finished_phase}"
      elsif gate["passable"]
        " — can pass now#{gate['requires_record'] ? ' (needs --ran-by and --ran-ref/--ran-url)' : ''}"
      elsif !gate["waits_on"].empty?
        " — waits on #{gate['waits_on'].join(', ')}"
      elsif gate["requires_authorization"]
        " — waits for a #{gate['requires_authorization']} grant#{gate['grant'] == 'unknown' ? ' (authorization ledger unreadable)' : ''}"
      else
        ""
      end
    else
      ""
    end
  end

  # The all-tasks part, e.g. "gates=pass:2,pending:2,ready:1"; nil without gates.
  def part(status, task_dir)
    return nil unless status.is_a?(Hash) && status.key?("completion_gates")

    view = CompletionGuard.gate_view(status, task_dir)
    return "gates=unreadable" unless view["readable"]

    counts = view["summary"]["by_status"].map { |state, count| "#{state}:#{count}" }
    "gates=#{(counts + ["ready:#{view['summary']['passable']}"]).join(',')}"
  end
end

if $PROGRAM_NAME == __FILE__
  task_dir = ARGV[0].to_s
  begin
    status = YAML.safe_load(File.read(File.join(task_dir, "status.yaml")), permitted_classes: [Date, Time], aliases: true)
    text = GateStatusText.lines(status, task_dir)
    puts text unless text.empty?
  rescue StandardError
    puts "Gates: unavailable"
  end
end
