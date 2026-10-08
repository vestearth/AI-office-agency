#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2A plan revision record (issue #28). The one definition of a
# `revisions` entry in status.yaml: its id arithmetic, the entry the writer
# (scripts/revise-task-plan.rb) appends, and the stored-state rules
# validate-yaml.rb enforces. Writer and validator both require this file so
# they cannot drift. A revision authorizes nothing and decides nothing; it
# records a change and names the gates/branches it added (docs/plan-revisions.md).

require_relative "completion-guard"
require_relative "authorization-ledger"

module PlanRevisions
  KINDS = %w[scope_expanded scope_narrowed plan_changed acceptance_changed].freeze
  ID_PATTERN = /\Arev-(\d{3,})\z/.freeze
  ENTRY_KEYS = %w[id at kind actor reason effects no_new_gates].freeze
  EFFECT_KEYS = %w[branches_declared gates_declared].freeze

  module_function

  # Ids are ordered by their numeric suffix, never as strings ("rev-1000" < "rev-999").
  def id_number(id)
    match = id.is_a?(String) ? ID_PATTERN.match(id) : nil
    match ? match[1].to_i : nil
  end

  def format_id(number)
    format("rev-%03d", number)
  end

  def next_id(revisions)
    numbers = Array(revisions).map { |entry| id_number(entry["id"]) if entry.is_a?(Hash) }.compact
    format_id((numbers.max || 0) + 1)
  end

  # The entry without id and at: what makes two revisions "the same".
  def content(kind:, actor:, reason:, gates:, branches:, no_new_gates:)
    entry = { "kind" => kind, "actor" => actor, "reason" => reason }
    if no_new_gates.nil?
      entry["effects"] = { "gates_declared" => gates, "branches_declared" => branches }
    else
      entry["no_new_gates"] = no_new_gates
    end
    entry
  end

  def build_entry(id:, at:, content:)
    { "id" => id, "at" => at }.merge(content)
  end

  def same_content?(entry, content)
    entry.is_a?(Hash) && entry.reject { |key, _| %w[id at].include?(key) } == content
  end

  def stored_errors(status, label)
    return [] unless status.is_a?(Hash) && status.key?("revisions")

    revisions = status["revisions"]
    return ["#{label}.revisions must be a list of revision records"] unless revisions.is_a?(Array)

    gates = status["completion_gates"].is_a?(Hash) ? status["completion_gates"] : {}
    branches = status["branches"].is_a?(Hash) ? status["branches"] : {}
    errors = []
    previous = nil
    revisions.each_with_index do |entry, index|
      rlabel = "#{label}.revisions[#{index}]"
      unless entry.is_a?(Hash)
        errors << "#{rlabel} must be a map"
        next
      end
      unknown = entry.keys - ENTRY_KEYS
      errors << "#{rlabel} has unknown field(s): #{unknown.join(', ')}" unless unknown.empty?
      number = id_number(entry["id"])
      if number.nil?
        errors << "#{rlabel}.id must match rev-NNN (three or more digits)"
      else
        if previous && number <= previous
          errors << "#{rlabel}.id #{entry['id']} must be greater than the previous revision id (numeric order)"
        end
        previous = number
      end
      unless entry["at"].is_a?(String) && entry["at"].match?(AuthorizationLedger::TIMESTAMP_PATTERN)
        errors << "#{rlabel}.at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
      end
      errors << "#{rlabel}.kind must be one of #{KINDS.join(', ')}" unless KINDS.include?(entry["kind"])
      %w[actor reason].each do |key|
        errors << "#{rlabel}.#{key} must be a non-empty string" unless entry[key].is_a?(String) && !entry[key].strip.empty?
      end
      if entry.key?("effects") == entry.key?("no_new_gates")
        errors << "#{rlabel} must have exactly one of effects or no_new_gates"
      elsif entry.key?("no_new_gates")
        unless entry["no_new_gates"].is_a?(String) && !entry["no_new_gates"].strip.empty?
          errors << "#{rlabel}.no_new_gates must be a non-empty string"
        end
      else
        errors.concat(effects_errors(entry["effects"], "#{rlabel}.effects", gates, branches))
      end
    end
    errors
  end

  def effects_errors(effects, elabel, gates, branches)
    unless effects.is_a?(Hash) && effects.keys.sort == EFFECT_KEYS
      return ["#{elabel} must be a map with gates_declared and branches_declared"]
    end

    errors = []
    { "gates_declared" => [gates, "completion_gates"], "branches_declared" => [branches, "branches"] }.each do |key, (declared, noun)|
      names = effects[key]
      unless names.is_a?(Array) && names.all? { |name| name.is_a?(String) && name.match?(CompletionGuard::GATE_NAME_PATTERN) }
        errors << "#{elabel}.#{key} must be a list of names matching #{CompletionGuard::GATE_NAME_PATTERN.inspect}"
        next
      end
      errors << "#{elabel}.#{key} lists a name twice" unless names.uniq.size == names.size
      missing = names.reject { |name| declared.key?(name) }
      errors << "#{elabel}.#{key} names #{missing.join(', ')}, which is not in #{noun}" unless missing.empty?
    end
    if errors.empty? && effects["gates_declared"].empty? && effects["branches_declared"].empty?
      errors << "#{elabel} must declare at least one gate or branch (use no_new_gates otherwise)"
    end
    errors
  end
end
