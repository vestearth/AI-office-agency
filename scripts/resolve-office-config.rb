#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"
require "date"

class OfficeConfigResolver
  # Keys a local/profile overlay may NOT change. office.config.local.yaml and
  # profiles/*.local.yaml are gitignored, so anything overridable there can be
  # weakened with no trace in `git status` — which is fine for tuning knobs and
  # not fine for the safety gate. Left overridable, one gitignored line
  # ("trusted_sources: [github_issue]") turns every later denial into an allow.
  #
  # The `preflight` entries are EVERY key in that block except `enabled`, which
  # stays overridable on purpose: it is a kill switch, and turning it off DENIES
  # external work. That "every key except one" claim is checked mechanically by
  # tests/integration/policy-preflight.sh (F-prot) against the shipped config,
  # so a key added to the policy without a line here fails there.
  PROTECTED_PATHS = [
    %w[office version],
    %w[state_model source_of_truth],
    %w[handoff_contract state_files],
    %w[runner_selector config_dir],
    # Ownership: a gitignored local overlay must not be able to switch the lease
    # off. Since the config flag now reaches the fence as well as acquisition,
    # leaving this unprotected would let an overlay disable mutual exclusion AND
    # disarm the stale-owner refusal in one line.
    %w[ownership enabled],
    # Task input integrity (#22): the whole block, not just `enabled`. Unlike
    # preflight.enabled/gateway.enabled (kill switches that fail CLOSED —
    # turning them off stops work), turning this off silently WEAKENS a
    # protection, same shape as ownership.enabled above. A gitignored overlay
    # must not be able to shrink frozen_files/append_only_files, disable
    # protect_role_outputs/protect_run_records, or flip enabled to false.
    %w[task_input_integrity],
    %w[preflight trusted_sources],
    %w[preflight decision_matrix],
    %w[preflight sensitivity_rules],
    %w[preflight role_actions],
    %w[preflight default_sensitivity],
    %w[preflight undeclared_scope_sensitivity],
    # Gateway (#19): `commands` IS the entire recognized grammar mapped to the
    # role each literal dispatches as — an overlay that remaps or adds a
    # command changes what an external event can trigger just as directly as
    # remapping preflight.role_actions would. `enabled` stays overridable on
    # purpose: it is a kill switch, and turning it off stops the gateway from
    # dispatching anything (fails closed, like preflight.enabled).
    %w[gateway commands],
    # #16: execution_budget's `enabled` stays overridable on purpose (a kill
    # switch, like dependency_guard.enabled/context_provider.enabled — turning
    # it off just stops the extra non-progress halt, the existing loop_guard
    # halts still apply). The two keys that actually decide an outcome are
    # protected so a gitignored overlay cannot quietly raise the ceiling or
    # change the halt's routing target.
    %w[execution_budget max_no_progress_actions],
    %w[execution_budget on_exhausted]
  ].freeze

  ENV_OVERRIDES = {
    "OFFICE_DEPENDENCY_GUARD_ENABLED" => %w[dependency_guard enabled],
    "OFFICE_CONTEXT_PROVIDER_ENABLED" => %w[context_provider enabled],
    "OFFICE_LOOP_MAX_ITERATIONS" => %w[loop_guard max_iterations],
    "SOCRATICODE_PRIMARY_PROJECT" => %w[context_provider project_paths primary],
    "SOCRATICODE_FALLBACK_PROJECT" => %w[context_provider project_paths fallback],
    "AI_SKILLS_PATH" => %w[external_repos ai_skills_path],
    "KNOWLEDGE_BASE_PATH" => %w[external_repos knowledge_base_path],
    "OFFICE_KNOWLEDGE_MODE" => %w[knowledge mode],
    "OFFICE_EVIDENCE_POLICY_MODE" => %w[reviewer evidence_policy mode]
  }.freeze

  def initialize(office_dir, profile: nil)
    @office_dir = File.expand_path(office_dir)
    @profile = profile.to_s.strip
    @profile = nil if @profile.empty?
  end

  def merged_config
    @merged_config ||= build_merged_config
  end

  def get(key_path, fallback = nil)
    value = dig(merged_config, key_path.split("."))
    if value.nil? || (value.respond_to?(:empty?) && value.empty?)
      fallback
    else
      value
    end
  end

  def list_values(key_path, fallback = nil)
    value = get(key_path, fallback)
    values = Array(value).map(&:to_s).reject(&:empty?)
    if values.empty? && fallback
      values = fallback.to_s.split(/[,\s]+/).reject(&:empty?)
    end
    values
  end

  def contains?(key_path, expected)
    list_values(key_path).include?(expected.to_s)
  end

  private

  def build_merged_config
    config = load_yaml(File.join(@office_dir, "office.config.yaml"))

    if @profile
      profile_path = File.join(@office_dir, "profiles", "#{@profile}.yaml")
      unless File.exist?(profile_path)
        warn "[ERROR] profile not found: #{@profile}"
        exit 1
      end

      profile_overlay = load_yaml(profile_path)
      local_profile_path = File.join(@office_dir, "profiles", "#{@profile}.local.yaml")
      profile_overlay = deep_merge(profile_overlay, load_yaml(local_profile_path)) if File.exist?(local_profile_path)

      config = deep_merge(config, profile_overlay)
    end

    local_path = File.join(@office_dir, "office.config.local.yaml")
    config = deep_merge(config, load_yaml(local_path)) if File.exist?(local_path)

    apply_env_overrides(config)
    config
  end

  def load_yaml(path)
    return {} unless File.exist?(path)

    YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
  rescue Psych::SyntaxError => e
    warn "[ERROR] invalid YAML in #{path}: #{e.message}"
    exit 1
  end

  def protected_path?(path)
    PROTECTED_PATHS.any? do |protected_path|
      protected_path.each_with_index.all? { |segment, index| path[index] == segment } &&
        path.length >= protected_path.length
    end
  end

  def id_keyed_array?(array)
    array.is_a?(Array) &&
      array.any? &&
      array.all? { |entry| entry.is_a?(Hash) && !entry["id"].to_s.empty? }
  end

  def deep_merge(base, overlay, path = [])
    base = {} if base.nil?
    overlay = {} if overlay.nil?
    return overlay unless base.is_a?(Hash) && overlay.is_a?(Hash)

    result = base.dup
    overlay.each do |key, value|
      current_path = path + [key.to_s]
      next if protected_path?(current_path)

      existing = result[key]
      if value.is_a?(Hash) && existing.is_a?(Hash)
        result[key] = deep_merge(existing, value, current_path)
      elsif value.is_a?(Array) && id_keyed_array?(value)
        result[key] = merge_id_keyed_arrays(existing, value, current_path)
      else
        result[key] = value
      end
    end
    result
  end

  def merge_id_keyed_arrays(base, overlay, path)
    base_array = Array(base)
    return overlay unless id_keyed_array?(base_array) && id_keyed_array?(overlay)

    by_id = base_array.each_with_object({}) do |entry, memo|
      memo[entry["id"].to_s] = entry.dup
    end

    overlay.each do |entry|
      id = entry["id"].to_s
      if by_id.key?(id)
        merged_entry = deep_merge(by_id[id], entry, path + [id])
        merged_entry["id"] = id unless merged_entry.key?("id")
        by_id[id] = merged_entry
      else
        by_id[id] = entry
      end
    end

    by_id.values
  end

  def apply_env_overrides(config)
    ENV_OVERRIDES.each do |env_name, key_path|
      next unless ENV.key?(env_name)

      set_nested(config, key_path, coerce_env_value(key_path.last, ENV[env_name]))
    end
    config
  end

  def coerce_env_value(key, raw)
    return raw.to_i if key == "max_iterations"
    return truthy?(raw) if %w[enabled].include?(key)

    raw
  end

  def truthy?(value)
    %w[true 1 yes on].include?(value.to_s.strip.downcase)
  end

  def set_nested(config, key_path, value)
    *parents, leaf = key_path
    target = parents.reduce(config) do |memo, key|
      memo[key] = {} unless memo[key].is_a?(Hash)
      memo[key]
    end
    target[leaf] = value
  end

  def dig(config, keys)
    keys.reduce(config) do |memo, key|
      break nil unless memo.is_a?(Hash)

      memo[key]
    end
  end
end

if $PROGRAM_NAME == __FILE__
  command = ARGV.shift
  office_dir = ARGV.shift
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  profile = nil if profile.empty?

  resolver = OfficeConfigResolver.new(office_dir, profile: profile)

  case command
  when "get"
    key_path, fallback = ARGV
    puts resolver.get(key_path, fallback)
  when "list"
    key_path, fallback = ARGV
    puts resolver.list_values(key_path, fallback).join("\n")
  when "contains"
    key_path, expected = ARGV
    puts resolver.contains?(key_path, expected) ? "true" : "false"
  when "dump"
    puts YAML.dump(resolver.merged_config)
  else
    warn "Usage: #{$PROGRAM_NAME} <get|list|contains|dump> <office_dir> [args...]"
    exit 1
  end
end
