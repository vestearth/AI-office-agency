# frozen_string_literal: true

# Issue #55: completion-gate presets for `./run-agent.sh open`
# (tasks/templates/gate-presets.yaml). A preset is a list of gates in the PM
# gate-plan format (#28 Phase 2E). Names, reasons and bindings are stripped
# exactly as scripts/update-completion-gate.rb strips its flags, so a gate
# declared from a preset has the same bytes as one declared by the writer.

require "yaml"
require_relative "completion-guard"
require_relative "authorization-ledger"

module GatePresets
  module_function

  # The presets file itself is broken (open exits 3).
  class Error < StandardError; end
  # The requested plan is invalid (open exits 2).
  class PlanError < StandardError; end

  DEFAULT_PATH = File.expand_path("../tasks/templates/gate-presets.yaml", __dir__)

  # AI_OFFICE_GATE_PRESETS is a TEST HOOK, honoured only when AI_OFFICE_RUNS_DIR
  # points at a non-live runs directory (the AI_OFFICE_NOW rule).
  def path
    override = ENV["AI_OFFICE_GATE_PRESETS"].to_s
    return DEFAULT_PATH if override.empty?
    unless AuthorizationLedger.clock_override_allowed?
      raise PlanError, "AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory"
    end

    override
  end

  # A copy of one plan entry with its strings stripped; other values are kept
  # as they are for CompletionGuard.plan_gate_errors to judge.
  def normalize(item)
    return item unless item.is_a?(Hash)

    item.each_with_object({}) do |(key, value), out|
      out[key] = if value.is_a?(String) then value.strip
                 elsif key == "after" && value.is_a?(Array) then value.map { |dep| dep.is_a?(String) ? dep.strip : dep }
                 else value
                 end
    end
  end

  def load(file)
    data = begin
      YAML.safe_load(File.read(file, encoding: "UTF-8"))
    rescue SystemCallError => e
      raise Error, "presets file #{file} cannot be read: #{e.message}"
    rescue Psych::Exception => e
      raise Error, "presets file #{file} cannot be parsed: #{e.message.lines.first.to_s.strip}"
    end
    unless data.is_a?(Hash) && !data.empty?
      raise Error, "presets file #{file} must be a map of preset name to a list of gates"
    end

    data.each_with_object({}) do |(name, plan), presets|
      raise Error, "preset #{name.inspect}: the name must be a lowercase word" unless name.is_a?(String) && name.match?(/\A[a-z][a-z0-9_-]*\z/)
      raise Error, "preset #{name}: must be a non-empty list of gates" unless plan.is_a?(Array) && !plan.empty?

      entries = plan.map { |item| normalize(item) }
      problems = CompletionGuard.plan_gate_errors(entries)
      raise Error, "preset #{name}: #{problems.first}" unless problems.empty?

      names = entries.map { |item| item["name"] }
      entries.each do |item|
        missing = Array(item["after"]) - names
        raise Error, "preset #{name}: gate #{item['name']} waits on #{missing.join(', ')}, which is not in the preset" unless missing.empty?
      end
      presets[name] = entries
    end
  end

  # The plan for `open`: the named presets in order, then the custom gates
  # ([name, reason] pairs), merged by gate name. A repeated name must carry an
  # identical definition.
  def compose(presets, names, custom)
    plan = []
    by_name = {}
    add = lambda do |item, source|
      existing = by_name[item["name"]]
      if existing.nil?
        by_name[item["name"]] = item
        plan << item
      elsif existing != item
        raise PlanError, "gate #{item['name']} is defined differently by #{source} and an earlier preset or gate"
      end
    end
    names.each do |name|
      raise PlanError, "unknown preset '#{name}' (known: #{presets.keys.join(', ')})" unless presets.key?(name)

      presets[name].each { |item| add.call(item, "preset #{name}") }
    end
    custom.each do |name, reason|
      add.call(normalize({ "name" => name, "reason" => reason }), "--gate #{name.to_s.strip}")
    end
    raise PlanError, "no gates to declare" if plan.empty?

    problems = CompletionGuard.plan_gate_errors(plan)
    raise PlanError, problems.first unless problems.empty?

    plan
  end
end
