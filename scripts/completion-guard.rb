#!/usr/bin/env ruby
# frozen_string_literal: true

# Completion gates (issue #28, Phase 1A) — the one place that answers
# "may this task transition to `done` now?".
#
# A task opts in by declaring `completion_gates` in status.yaml. A gate that is
# present is REQUIRED (there is no `required:` flag). A gate is resolved only
# when its status is `pass` or `na`; `pending` — and anything the guard cannot
# read — blocks `done`. Tasks with no `completion_gates` key are unaffected.
#
# Every writer that can produce `done` calls can_transition_to_done, and the
# stored-state validator calls it too (defense in depth). Do not copy this
# logic into a writer.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"

module CompletionGuard
  GATE_STATUSES = %w[pending pass na].freeze
  GATE_NAME_PATTERN = /\A[a-z][a-z0-9_]*\z/.freeze
  RESOLVED_STATUSES = %w[pass na].freeze
  # Exit code a status writer uses when the guard refuses `done`. Distinct from
  # 3 (malformed output -> validation_failed) on purpose: a legitimate wait for
  # runtime acceptance is not a validation defect.
  COMPLETION_BLOCKED = 5
  # Mirrors validate-yaml.rb STATUS_ACTORS (meta.yaml event `agent` enum).
  STATUS_ACTORS = %w[pm dev dev-2 reviewer debugger devops free-roam done orchestrator].freeze

  Verdict = Struct.new(:allowed, :unresolved)

  module_function

  # status is the parsed status.yaml Hash. Returns a Verdict; `unresolved` is a
  # sorted Array of gate names (or ["completion_gates"] when the key itself is
  # malformed — fail closed).
  def can_transition_to_done(status)
    return Verdict.new(true, []) unless status.is_a?(Hash) && status.key?("completion_gates")

    gates = status["completion_gates"]
    return Verdict.new(false, ["completion_gates"]) unless gates.is_a?(Hash)

    unresolved = gates.reject { |_name, gate| resolved?(gate) }.keys.map(&:to_s).sort
    Verdict.new(unresolved.empty?, unresolved)
  end

  def resolved?(gate)
    gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate["status"].to_s)
  end

  def blocked_message(unresolved)
    "Completion blocked: unresolved completion gate(s): #{unresolved.join(', ')}. " \
      "Resolve each with scripts/update-completion-gate.rb (pass|na) before the task can be marked done."
  end

  # meta.yaml event `agent` must be a STATUS_ACTORS value. `actor` on a gate is
  # free text (Phase 1A does not verify identity), so anything else is recorded
  # as `orchestrator` on the event and kept verbatim in `details`.
  def event_agent(actor)
    STATUS_ACTORS.include?(actor.to_s) ? actor.to_s : "orchestrator"
  end

  # Appends one event to runs/<task>/meta.yaml. The CALLER MUST ALREADY HOLD the
  # task `.lock` — status writers do; this method deliberately does not lock
  # (a second flock on the same file from the same process would deadlock).
  # Observability must never turn a refusal into a crash, so I/O and YAML
  # problems are reported on stderr and swallowed.
  def append_meta_event!(task_dir, type:, agent:, details:, dedupe: false)
    meta_path = File.join(task_dir, "meta.yaml")
    meta = if File.exist?(meta_path)
             YAML.safe_load(File.read(meta_path), permitted_classes: [Date, Time], aliases: true) || {}
           else
             {}
           end
    meta["task_id"] ||= File.basename(task_dir)
    meta["events"] = [] unless meta["events"].is_a?(Array)

    if dedupe
      last = meta["events"].last
      return false if last.is_a?(Hash) && last["type"] == type && last["agent"] == agent && last["details"] == details
    end

    timestamp = Time.now.utc.strftime("%FT%TZ")
    event = { "type" => type, "agent" => agent, "details" => details, "timestamp" => timestamp }
    run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
    event["run_id"] = run_id unless run_id.empty?
    meta["events"] << event
    meta["updated_at"] = timestamp

    tmp_path = "#{meta_path}.tmp.#{$$}"
    begin
      File.write(tmp_path, YAML.dump(meta))
      File.rename(tmp_path, meta_path)
    rescue StandardError
      File.delete(tmp_path) if File.exist?(tmp_path)
      raise
    end
    true
  rescue StandardError => e
    warn "completion-guard: could not record #{type} event in #{meta_path}: #{e.message}"
    false
  end

  # The event written whenever the guard refuses a transition to done.
  def record_blocked!(task_dir, attempted:, actor:, unresolved:)
    append_meta_event!(
      task_dir,
      type: "completion_blocked",
      agent: event_agent(actor),
      details: "attempted=#{attempted} unresolved=#{unresolved.join(',')}",
      dedupe: true
    )
  end
end
