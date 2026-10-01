#!/usr/bin/env ruby
# frozen_string_literal: true

# Dispatch-time authorization check (issue #28, Phase 1B.2).
#
#   ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>
#
# Prints exactly one line
#   outcome=<outcome> mode=<mode> actions=<a,b>
# and exits 0 (proceed), 14 (refuse) or 2 (usage error). Any other exit — 3 when
# the task state cannot be judged, 1 on a crash — is not a result: run-agent.sh
# treats it as `check_error` and resolves it WITHOUT this file (see the driver's
# scope recovery, which duplicates gate_state and the roles test on purpose and
# is pinned to this file by the agreement test in
# tests/integration/authorization-dispatch.sh).
#
# The check is inferred from state the Office already holds: a dispatch of a
# configured role, for a task with a gate that is `pending` and carries
# `requires_authorization`, needs a grant of exactly that action that is valid
# NOW (AuthorizationLedger.now_utc) as of the ledger's current high-water id.
# It never writes status.yaml, a gate, or the ledger.
#
# Configuration is read from the TYPED merged config (OfficeConfigResolver
# #merged_config), never from the resolver's `get`/`list`, which flatten lists
# and coerce scalars and would turn malformed config into valid-looking config.

require "yaml"
require "date"
require_relative "authorization-ledger"
require_relative "resolve-office-config"

module AuthorizationDispatchCheck
  MODES = %w[off warn_only required].freeze
  DEFAULT_MODE = "warn_only"
  DEFAULT_ROLES = %w[devops].freeze
  # Mirrors agents/manifest.yaml and the literal in run-agent.sh's scope
  # recovery; tests/integration/authorization-dispatch.sh pins all three.
  CONCRETE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
  EXIT_PROCEED = 0
  EXIT_USAGE = 2
  EXIT_UNJUDGEABLE = 3
  EXIT_REFUSE = 14

  class Unjudgeable < StandardError; end

  Config = Struct.new(:state, :mode, :roles) # state: :ok, :off, :error
  Result = Struct.new(:outcome, :mode, :actions)

  module_function

  # :none (no pending bound gate), :bound, or :malformed (cannot be judged).
  # Kept byte-for-byte equivalent to gate_state in run-agent.sh.
  def gate_state(status)
    return :malformed unless status.is_a?(Hash)
    return :none unless status.key?("completion_gates")

    gates = status["completion_gates"]
    return :malformed unless gates.is_a?(Hash) && gates.values.all? { |gate| gate.is_a?(Hash) }

    gates.values.any? { |gate| pending_bound?(gate) } ? :bound : :none
  end

  def pending_bound?(gate)
    gate["status"] == "pending" && gate.key?("requires_authorization")
  end

  # Distinct required actions of the pending bound gates, as printable tokens.
  def required_actions(status)
    status["completion_gates"].values.select { |gate| pending_bound?(gate) }
                              .map { |gate| token(gate["requires_authorization"]) }.uniq
  end

  def token(value)
    text = value.is_a?(String) ? value : value.inspect
    text = text.gsub(/[\s,]/, "_")
    text.empty? ? "(empty)" : text
  end

  def roles_trustworthy?(roles)
    roles.is_a?(Array) && roles.all? { |role| role.is_a?(String) && CONCRETE_ROLES.include?(role) }
  end

  # Section 4 normalization. Only a WHOLLY absent block means the defaults; a
  # key missing inside a present block is untrustworthy.
  def normalize(merged_config)
    return Config.new(:error, "required", nil) unless merged_config.is_a?(Hash)
    return Config.new(:ok, DEFAULT_MODE, DEFAULT_ROLES) unless merged_config.key?("authorization_dispatch")

    block = merged_config["authorization_dispatch"]
    return Config.new(:error, "required", nil) unless block.is_a?(Hash)

    mode = block["mode"]
    return Config.new(:error, "required", nil) unless mode.is_a?(String) && MODES.include?(mode)
    return Config.new(:off, "off", nil) if mode == "off"

    roles = block["roles"]
    return Config.new(:error, mode, nil) unless roles_trustworthy?(roles)

    Config.new(:ok, mode, roles)
  end

  # The decision, given a parsed status (or :absent), the merged config (or a
  # callable that returns it), the final role and the task dir (for the ledger).
  # Config is read only once a pending bound gate exists (spec §1). Raises
  # Unjudgeable when the task state cannot be read.
  def decide(status, merged_config, role, task_dir)
    return Result.new("not_applicable", "none", []) if status == :absent

    case gate_state(status)
    when :malformed then raise Unjudgeable, "status.yaml completion_gates cannot be judged"
    when :none then return Result.new("not_applicable", "none", [])
    end

    merged_config = merged_config.call if merged_config.respond_to?(:call)
    actions = required_actions(status)
    config = normalize(merged_config)
    return Result.new("not_applicable", "off", []) if config.state == :off
    return Result.new("config_error", config.mode, actions) if config.state == :error
    return Result.new("not_applicable", config.mode, []) unless config.roles.include?(role)

    index = begin
      AuthorizationLedger.load(task_dir)
    rescue AuthorizationLedger::Error => e
      warn "authorization-dispatch-check: ledger unavailable (#{e.message}); every required action is missing"
      nil
    end
    now = AuthorizationLedger.now_utc
    through = index&.high_water_id
    missing = actions.reject do |action|
      !through.nil? && index.any_valid_grant?(action: action, at: now, through: through)
    end
    return Result.new("authorized", config.mode, actions) if missing.empty?

    Result.new("missing_authorization", config.mode, missing)
  end

  def exit_code(result)
    refusing = %w[missing_authorization config_error].include?(result.outcome) && result.mode == "required"
    refusing ? EXIT_REFUSE : EXIT_PROCEED
  end

  def line(result)
    "outcome=#{result.outcome} mode=#{result.mode} actions=#{result.actions.join(',')}"
  end

  def load_status(path)
    return :absent unless File.exist?(path)

    YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  rescue StandardError => e
    raise Unjudgeable, "status.yaml cannot be read: #{e.message}"
  end

  def runs_dir
    ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
  end

  def usage!(message)
    warn "authorization-dispatch-check: #{message}"
    warn "Usage: ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>"
    exit EXIT_USAGE
  end

  def main(argv)
    command, task_id, flag, role, *rest = argv
    usage!("unknown command #{command.inspect}") unless command == "decide"
    usage!("missing --role") unless flag == "--role" && role.is_a?(String) && !role.empty?
    usage!("unexpected arguments #{rest.inspect}") unless rest.empty?
    unless task_id.is_a?(String) && task_id.match?(/\A[A-Za-z0-9][A-Za-z0-9_-]*\z/)
      usage!("invalid task id #{task_id.inspect}")
    end

    task_dir = File.join(runs_dir, task_id)
    status = load_status(File.join(task_dir, "status.yaml"))
    office_dir = File.expand_path("..", __dir__)
    profile = ENV["OFFICE_PROFILE"].to_s.strip
    merged = -> { OfficeConfigResolver.new(office_dir, profile: profile.empty? ? nil : profile).merged_config }
    result = decide(status, merged, role, task_dir)
    puts line(result)
    exit exit_code(result)
  rescue Unjudgeable, AuthorizationLedger::Error => e
    warn "authorization-dispatch-check: #{e.message}"
    exit EXIT_UNJUDGEABLE
  end
end

AuthorizationDispatchCheck.main(ARGV) if $PROGRAM_NAME == __FILE__
