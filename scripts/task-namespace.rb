# frozen_string_literal: true

# Issue #55: the namespace rules a NEW task id must pass, for
# `./run-agent.sh open`. They mirror, with the same messages, the two checks
# run-agent.sh already makes inline: intake's prefix rules (grammar; PKG and GW
# reserved) and the PM creation gate's registry rule (enforce_new_task_namespace:
# once office.team.yaml lists prefixes, a new id must be TASK-<your prefix>-NNN).
# run-agent.sh keeps its inline copies because tests run it from a sandboxed
# office without scripts/; tests/integration/open-task.sh (section N) pins the
# messages against both.

require "yaml"

module TaskNamespace
  module_function

  # The new id is refused (open exits 1). The message is the line to print.
  class Refused < StandardError; end

  RESERVED = {
    "PKG" => "reserved for package tasks",
    "GW" => "reserved for the event gateway's minted TASK-GW-N ids"
  }.freeze

  def prefix_problem(raw_prefix)
    prefix = raw_prefix.to_s.strip.upcase
    unless prefix.empty? || prefix.match?(/\A[A-Z][A-Z0-9]*\z/)
      return "[ERROR] task prefix #{raw_prefix.inspect} must be letters/digits starting with a letter (e.g. EA, BOB)"
    end
    return "[ERROR] task prefix #{prefix} is #{RESERVED[prefix]} - pick a personal prefix" if RESERVED.key?(prefix)

    nil
  end

  def reserved_id_problem(task_id)
    namespace = task_id.to_s[/\ATASK-([A-Z][A-Z0-9]*)-\d+\z/, 1]
    return nil unless RESERVED.key?(namespace)

    "[ERROR] #{task_id} is in the reserved #{namespace} namespace (#{RESERVED[namespace]}); open a task in your own namespace"
  end

  # Fails closed like intake: an unparseable or mis-shaped registry refuses,
  # it never silently turns prefix enforcement off. Absent file, comments only,
  # or no `prefixes:` is the empty (solo) registry.
  def load_registry(path)
    return {} unless path && File.exist?(path)

    data = begin
      YAML.safe_load(File.read(path))
    rescue StandardError => e
      raise Refused, "[ERROR] office.team.yaml exists but cannot be parsed (#{e.class}: #{e.message.lines.first&.strip})"
    end
    return {} if data.nil?
    raise Refused, "[ERROR] office.team.yaml must be a map with a 'prefixes:' entry (got #{data.class})" unless data.is_a?(Hash)

    raw = data["prefixes"]
    return {} if raw.nil?
    raise Refused, "[ERROR] office.team.yaml 'prefixes:' must be a map of PREFIX: Name (got #{raw.class})" unless raw.is_a?(Hash)

    raw.each_with_object({}) { |(key, owner), memo| memo[key.to_s.strip.upcase] = owner.to_s }
  end

  def registry_problem(task_id, raw_prefix, registry)
    return nil if registry.empty?

    prefix = raw_prefix.to_s.strip.upcase
    return "[ERROR] set your Dashboard name before creating a task" if prefix.empty?
    owner = registry[prefix]
    return "[ERROR] prefix #{prefix} is not registered" unless owner && !owner.empty?
    return nil if task_id.to_s.match?(/\ATASK-#{Regexp.escape(prefix)}-\d+\z/)

    "[ERROR] new task id must use active namespace TASK-#{prefix}-NNN; run intake and use its returned id"
  end

  # Raises Refused with the first problem; returns nil when the id may be opened.
  def check_new_task!(task_id, raw_prefix, registry_path)
    problem = prefix_problem(raw_prefix) || reserved_id_problem(task_id)
    problem ||= registry_problem(task_id, raw_prefix, load_registry(registry_path))
    raise Refused, problem if problem

    nil
  end
end
