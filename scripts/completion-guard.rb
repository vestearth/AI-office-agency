#!/usr/bin/env ruby
# frozen_string_literal: true

# Completion gates (issue #28, Phase 1A + 1B.1) — the one place that answers
# "may this task transition to `done` now?".
#
# A task opts in by declaring `completion_gates` in status.yaml. A gate that is
# present is REQUIRED (there is no `required:` flag). A gate is resolved only
# when its status is `pass` or `na` (with actor, reason and updated_at);
# `pending` — and anything the guard cannot read — blocks `done`. Tasks with no
# `completion_gates` key are unaffected.
#
# Phase 1B.1: a gate that carries the key `requires_authorization` is BOUND to
# an authorization. Such a gate is resolved only when
#   * `pass`: it cites `authorization_refs` that are grants in the task's
#     authorization ledger, matching the required action EXACTLY, and valid as
#     of the gate's own recorded (updated_at, authorization_through) — never
#     "now" and never the ledger's current tail (see
#     scripts/authorization-ledger.rb); or
#   * `na`: it carries no authorization refs (`na` is not a waiver).
# A missing or corrupt ledger makes a bound gate unresolved (fail closed).
# Unbound gates never read the ledger.
#
# Every writer that can produce `done` calls can_transition_to_done_in, and the
# stored-state validator calls it too (defense in depth). Do not copy this
# logic into a writer.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"
require_relative "authorization-ledger"

module CompletionGuard
  GATE_STATUSES = %w[pending pass na].freeze
  GATE_NAME_PATTERN = /\A[a-z][a-z0-9_]*\z/.freeze
  RESOLVED_STATUSES = %w[pass na].freeze
  # A pass/na gate must carry these (non-empty strings) to count as resolved.
  # validate-yaml.rb reads the same constant; schemas/status.schema.yaml pins it.
  RESOLUTION_METADATA_KEYS = %w[actor reason updated_at].freeze
  # Exit code a status writer uses when the guard refuses `done`. Distinct from
  # 3 (malformed output -> validation_failed) on purpose: a legitimate wait for
  # runtime acceptance is not a validation defect.
  COMPLETION_BLOCKED = 5
  # Mirrors validate-yaml.rb STATUS_ACTORS (meta.yaml event `agent` enum).
  STATUS_ACTORS = %w[pm dev dev-2 reviewer debugger devops free-roam done orchestrator].freeze

  Verdict = Struct.new(:allowed, :unresolved)

  module_function

  # status is the parsed status.yaml Hash; `authorizations` is an
  # AuthorizationLedger::Index or nil. Returns a Verdict; `unresolved` is a
  # sorted Array of gate names (or ["completion_gates"] when the key itself is
  # malformed — fail closed). With no bound gate, `authorizations` is ignored.
  def can_transition_to_done(status, authorizations: nil)
    return Verdict.new(true, []) unless status.is_a?(Hash) && status.key?("completion_gates")

    gates = status["completion_gates"]
    return Verdict.new(false, ["completion_gates"]) unless gates.is_a?(Hash)

    unresolved = gates.reject { |_name, gate| gate_resolved?(gate, authorizations) }.keys.map(&:to_s).sort
    Verdict.new(unresolved.empty?, unresolved)
  end

  # The wrapper every writer and the validator use: loads the task's ledger only
  # when some gate is bound to an authorization, so tasks that do not use the
  # feature never read authorization.yaml. A load failure is reported on stderr
  # and treated as "no ledger" (bound gates then fail closed).
  def can_transition_to_done_in(status, task_dir)
    index = nil
    if ledger_needed?(status)
      begin
        index = AuthorizationLedger.load(task_dir)
      rescue AuthorizationLedger::Error => e
        warn "completion-guard: #{e.message}"
      end
    end
    can_transition_to_done(status, authorizations: index)
  end

  def ledger_needed?(status)
    return false unless status.is_a?(Hash) && status["completion_gates"].is_a?(Hash)

    status["completion_gates"].values.any? { |gate| gate.is_a?(Hash) && gate.key?("requires_authorization") }
  end

  # Phase 1A metadata rules only (status pass/na with non-empty actor, reason,
  # updated_at). Bound gates additionally need authorization_satisfied?.
  def resolved?(gate)
    return false unless gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate["status"].to_s)

    RESOLUTION_METADATA_KEYS.all? { |key| gate[key].is_a?(String) && !gate[key].strip.empty? }
  end

  def gate_resolved?(gate, authorizations)
    return false unless resolved?(gate)
    return true unless gate.key?("requires_authorization")

    authorization_satisfied?(gate, authorizations)
  end

  # A bound gate. Every comparison of authz ids is numeric (AuthorizationLedger).
  def authorization_satisfied?(gate, index)
    required = gate["requires_authorization"]
    return false unless AuthorizationLedger::ACTIONS.include?(required)

    if gate["status"] == "na"
      return !gate.key?("authorization_refs") && !gate.key?("authorization_through")
    end

    return false if index.nil?

    refs = gate["authorization_refs"]
    return false unless refs.is_a?(Array) && !refs.empty? && refs.all? { |ref| ref.is_a?(String) }

    through = gate["authorization_through"]
    through_number = AuthorizationLedger.id_number(through)
    return false if through_number.nil? || !index.entry?(through)

    at = AuthorizationLedger.parse_time(gate["updated_at"])
    return false if at.nil?

    refs.all? do |ref|
      ref_number = AuthorizationLedger.id_number(ref)
      !ref_number.nil? && ref_number <= through_number &&
        index.valid_grant?(ref, action: required, at: at, through: through)
    end
  end

  def blocked_message(unresolved)
    "Completion blocked: unresolved completion gate(s): #{unresolved.join(', ')}. " \
      "Resolve each with scripts/update-completion-gate.rb (pass|na) before the task can be marked done. " \
      "A pass/na gate must also carry actor, reason and updated_at. " \
      "A gate bound to an authorization also needs authorization_refs to valid grants in authorization.yaml."
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
