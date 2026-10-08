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
# An ABSENT authorization.yaml is an empty ledger: a bound `pass` is then
# unresolved (no ref can resolve) and a bound `na` is unaffected. A ledger that
# cannot be loaded (unreadable, corrupt, integrity-violating, wrong root shape)
# — or `authorizations: nil` — leaves EVERY bound gate unresolved, `na`
# included (fail closed).
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
  # Phase 1C: a declared branch is complete only at done/na. Branch state is
  # independent of task phase; one blocked branch never blocks a ready sibling.
  BRANCH_STATES = %w[ready blocked done na].freeze
  BRANCH_TERMINAL_STATES = %w[done na].freeze
  BRANCH_NAME_PATTERN = GATE_NAME_PATTERN
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
  # sorted Array of gate names and branch:<name> labels (or the malformed key
  # itself — fail closed). With no bound gate, `authorizations` is ignored.
  def can_transition_to_done(status, authorizations: nil)
    return Verdict.new(true, []) unless status.is_a?(Hash)

    unresolved = []
    if status.key?("completion_gates")
      gates = status["completion_gates"]
      unresolved.concat(gates.is_a?(Hash) ? gates.reject { |_name, gate| gate_resolved?(gate, authorizations) }.keys.map(&:to_s) : ["completion_gates"])
    end
    unresolved.concat(unresolved_branches(status))
    unresolved.sort!
    Verdict.new(unresolved.empty?, unresolved)
  end

  def unresolved_branches(status)
    return [] unless status.key?("branches")

    branches = status["branches"]
    return ["branches"] unless branches.is_a?(Hash) && !branches.empty?

    branches.reject { |name, branch| branch_resolved?(name, branch) }.keys.map { |name| "branch:#{name}" }
  end

  def branch_resolved?(name, branch)
    name.is_a?(String) && name.match?(BRANCH_NAME_PATTERN) && branch.is_a?(Hash) &&
      BRANCH_TERMINAL_STATES.include?(branch["state"]) && !branch.key?("waiting_for") &&
      RESOLUTION_METADATA_KEYS.all? { |key| branch[key].is_a?(String) && !branch[key].strip.empty? }
  end

  # The wrapper every writer and the validator use: loads the task's ledger only
  # when some gate is bound to an authorization, so tasks that do not use the
  # feature never read authorization.yaml. A load failure is reported on stderr
  # and yields nil (every bound gate then fails closed); an absent file is an
  # empty ledger, not a failure.
  def can_transition_to_done_in(status, task_dir)
    index = nil
    if ledger_needed?(status)
      begin
        index = AuthorizationLedger.load(task_dir)
      rescue StandardError => e
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

    # nil = the ledger could not be loaded: every bound gate is unresolved,
    # `na` included. (An ABSENT ledger file is an empty Index, not nil.)
    return false if index.nil?

    if gate["status"] == "na"
      return !gate.key?("authorization_refs") && !gate.key?("authorization_through")
    end

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
    branches = unresolved.select { |name| name == "branches" || name.start_with?("branch:") }
    gates = unresolved - branches
    unless branches.empty?
      return "Completion blocked: unresolved branch(es): #{branches.join(', ')}. " \
             "Resolve each with scripts/update-task-branch.rb (done|na)." if gates.empty?

      return "Completion blocked: unresolved completion gate(s): #{gates.join(', ')}; " \
             "unresolved branch(es): #{branches.join(', ')}."
    end
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

  # Phase 2A: the one construction of a gate record, shared by
  # update-completion-gate.rb and revise-task-plan.rb. Key order is part of the
  # stored bytes (pinned by tests/integration/plan-revisions.sh section W).
  def gate_record(status:, actor:, reason:, updated_at:, evidence_refs: nil, requires_authorization: nil,
                  authorization_refs: nil, authorization_through: nil, after: nil)
    record = { "status" => status, "actor" => actor }
    record["reason"] = reason unless reason.to_s.empty?
    record["updated_at"] = updated_at
    record["evidence_refs"] = Array(evidence_refs)
    record["requires_authorization"] = requires_authorization unless requires_authorization.nil?
    unless authorization_refs.nil?
      record["authorization_refs"] = authorization_refs
      record["authorization_through"] = authorization_through
    end
    record["after"] = after unless after.nil?
    record
  end

  # Phase 2B gate ordering: the gates a gate waits on ([] when it declares none).
  def gate_after(gate)
    gate.is_a?(Hash) && gate["after"].is_a?(Array) ? gate["after"] : []
  end

  # True when `target` is reachable from `start` by following `after` edges.
  def gate_reaches?(gates, start, target)
    seen = {}
    stack = [start]
    until stack.empty?
      current = stack.pop
      return true if current == target
      next if seen[current]

      seen[current] = true
      stack.concat(gate_after(gates[current]))
    end
    false
  end

  # Problems with the stored orderings (shape, names, self-reference, cycles),
  # shared by update-completion-gate.rb (exit 3) and validate-yaml.rb.
  def ordering_errors(gates)
    errors = []
    gates.each do |name, gate|
      next unless gate.is_a?(Hash) && gate.key?("after")

      after = gate["after"]
      unless after.is_a?(Array) && !after.empty? && after.all? { |dep| dep.is_a?(String) && dep.match?(GATE_NAME_PATTERN) }
        errors << "completion_gates.#{name}.after must be a non-empty list of gate names"
        next
      end
      errors << "completion_gates.#{name}.after lists a gate twice" unless after.uniq.size == after.size
      errors << "completion_gates.#{name}.after names the gate itself" if after.include?(name)
      missing = after.reject { |dep| dep == name || gates.key?(dep) }
      errors << "completion_gates.#{name}.after names #{missing.join(', ')}, which is not a declared gate" unless missing.empty?
      malformed = after.select { |dep| dep != name && gates.key?(dep) && !gates[dep].is_a?(Hash) }
      errors << "completion_gates.#{name}.after names #{malformed.join(', ')}, whose gate record is not a map" unless malformed.empty?
    end
    return errors unless errors.empty?

    gates.each do |name, gate|
      gate_after(gate).each do |dep|
        return ["completion_gates.#{name}.after creates a cycle through #{dep}"] if gate_reaches?(gates, dep, name)
      end
    end
    errors
  end

  # The gates in `gate`'s after list that are not resolved. With an
  # authorization index this is the done guard's definition (gate_resolved?);
  # with nil, the Phase 1A status rule only.
  def unresolved_dependencies(gates, gate, authorizations)
    gate_after(gate).reject do |dep|
      authorizations ? gate_resolved?(gates[dep], authorizations) : resolved?(gates[dep])
    end
  end

  def gate_history_row(gate_name, old_status, new_status, actor:, reason:, at:)
    {
      "phase" => "gate #{gate_name}: #{old_status} -> #{new_status}",
      "agent" => event_agent(actor),
      "reason" => reason.to_s.empty? ? "completion gate declared" : reason,
      "at" => at
    }
  end

  # Phase 2A: the one construction of a branch record and its history row,
  # shared by update-task-branch.rb and revise-task-plan.rb.
  def branch_record(state:, actor:, reason:, updated_at:, waiting_for: [])
    record = { "state" => state, "actor" => actor, "reason" => reason, "updated_at" => updated_at }
    record["waiting_for"] = waiting_for if state == "blocked"
    record
  end

  def branch_history_row(name, from:, to:, old_phase:, new_phase:, actor:, reason:, at:)
    {
      "phase" => "#{old_phase} -> #{new_phase}",
      "agent" => event_agent(actor),
      "reason" => "Branch #{name}: #{from} -> #{to}; #{reason}",
      "at" => at
    }
  end

  # The stored-branch-state checks a branch writer must pass before it builds
  # on status.yaml. Returns the first problem (the writers exit 3 on it) or nil.
  def branch_state_error(status)
    return "status.yaml branches must be a map" if status.key?("branches") && !status["branches"].is_a?(Hash)

    (status["branches"] || {}).each do |id, branch|
      valid = id.is_a?(String) && id.match?(BRANCH_NAME_PATTERN) && branch.is_a?(Hash) &&
              BRANCH_STATES.include?(branch["state"]) &&
              RESOLUTION_METADATA_KEYS.all? { |key| branch[key].is_a?(String) && !branch[key].strip.empty? } &&
              (branch.keys - %w[state actor reason updated_at waiting_for]).empty? &&
              (branch["state"] == "blocked" ?
                branch["waiting_for"].is_a?(Array) && !branch["waiting_for"].empty? &&
                  branch["waiting_for"].all? { |item| item.is_a?(String) && !item.strip.empty? } :
                !branch.key?("waiting_for"))
      return "malformed existing branch #{id.inspect}" unless valid
    end
    return "status.yaml waiting_for must be a list" if status.key?("waiting_for") && !status["waiting_for"].is_a?(Array)
    return "status.yaml blocked_on must be a list" if status.key?("blocked_on") && !status["blocked_on"].is_a?(Array)
    if Array(status["waiting_for"]).any? { |item| !item.is_a?(String) || item.strip.empty? }
      return "status.yaml waiting_for must contain reasons"
    end

    nil
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
