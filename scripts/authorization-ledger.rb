#!/usr/bin/env ruby
# frozen_string_literal: true

# Authorization ledger (issue #28, Phase 1B.1) — semantics for
# runs/<task>/authorization.yaml, an append-only record of grants and revokes.
#
# Two rules are load-bearing and are why this is a library and not inline code:
#
#  * Ids are compared by their NUMERIC suffix, never as strings
#    (authz-999 < authz-1000). Nothing outside this file compares id strings.
#  * Revocation is decided by APPEND ORDER, never by wall-clock. A grant is valid
#    as of (T, S) iff
#        id <= S  AND  at <= T  AND  (no expires_at OR T < expires_at)
#        AND no revoke of it with id <= S
#    where S is a snapshot boundary (an authorization id). Timestamps decide only
#    a grant's start and expiry. A later revoke has a higher id, so it can never
#    reopen a historical pass, even if a skewed clock gives it an earlier `at`.
#
# `scope` is descriptive / audit-only in this slice and is never compared.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"

module AuthorizationLedger
  class Error < StandardError; end

  FILENAME = "authorization.yaml"
  ACTIONS = %w[
    deploy_staging deploy_production production_data_mutation
    production_backfill live_load external_side_effect
  ].freeze
  TYPES = %w[grant revoke].freeze
  ID_PATTERN = /\Aauthz-\d{3,}\z/.freeze
  TIMESTAMP_PATTERN = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/.freeze
  COMMON_REQUIRED_KEYS = %w[id type actor via reason at].freeze

  # An indexed, read-only view of a ledger's entries.
  class Index
    attr_reader :entries

    def initialize(entries)
      @entries = entries
      @by_number = {}
      @revokes_of = Hash.new { |hash, key| hash[key] = [] }
      entries.each do |entry|
        number = AuthorizationLedger.id_number(entry["id"])
        next if number.nil?

        @by_number[number] = entry
        next unless entry["type"] == "revoke"

        target = AuthorizationLedger.id_number(entry["revokes"])
        @revokes_of[target] << number unless target.nil?
      end
    end

    def entry?(id)
      number = AuthorizationLedger.id_number(id)
      !number.nil? && @by_number.key?(number)
    end

    # The highest id in the ledger as a canonical string, or nil when empty.
    def high_water_id
      return nil if @by_number.empty?

      AuthorizationLedger.format_id(@by_number.keys.max)
    end

    # Is the grant `id` valid for `action` as of time `at` and snapshot `through`?
    # See the header comment. `at` is a Time or a timestamp string.
    def valid_grant?(id, action:, at:, through:)
      number = AuthorizationLedger.id_number(id)
      snapshot = AuthorizationLedger.id_number(through)
      return false if number.nil? || snapshot.nil? || number > snapshot

      grant = @by_number[number]
      return false unless grant.is_a?(Hash) && grant["type"] == "grant" && grant["action"] == action

      moment = at.is_a?(Time) ? at : AuthorizationLedger.parse_time(at)
      started = AuthorizationLedger.parse_time(grant["at"])
      return false if moment.nil? || started.nil? || started > moment

      if grant.key?("expires_at")
        expires = AuthorizationLedger.parse_time(grant["expires_at"])
        return false if expires.nil? || moment >= expires
      end

      @revokes_of[number].none? { |revoke_number| revoke_number <= snapshot }
    end

    # Is there at least one grant of exactly `action` that is valid as of
    # (at, through)? Phase 1B.2 (dispatch-time check) asks this for "now" and
    # the current high-water id; the validity rule is valid_grant?'s, unchanged.
    def any_valid_grant?(action:, at:, through:)
      @by_number.any? do |number, entry|
        entry.is_a?(Hash) && entry["type"] == "grant" &&
          valid_grant?(AuthorizationLedger.format_id(number), action: action, at: at, through: through)
      end
    end
  end

  module_function

  # The numeric part of an authz-NNN id, or nil when `id` is not one.
  def id_number(id)
    return nil unless id.is_a?(String) && id.match?(ID_PATTERN)

    Integer(id.delete_prefix("authz-"), 10)
  end

  # Canonical id for a number: three digits minimum, growing past 999.
  def format_id(number)
    format("authz-%03d", number)
  end

  def parse_time(value)
    return nil unless value.is_a?(String) && value.match?(TIMESTAMP_PATTERN)

    parsed = Time.iso8601(value).utc
    format_time(parsed) == value ? parsed : nil
  rescue ArgumentError
    nil
  end

  def format_time(time)
    time.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
  end

  # The current UTC time floored to whole seconds, so the value used for a
  # validity check is exactly the value stored at second resolution.
  #
  # AI_OFFICE_NOW is a TEST HOOK and is honored ONLY when AI_OFFICE_RUNS_DIR is
  # set to something other than the live <repo>/runs directory: `at` is written
  # by the writer, never supplied by the caller, so the hook must be unreachable
  # against the live store. Otherwise a set AI_OFFICE_NOW raises Error.
  def now_utc
    override = ENV["AI_OFFICE_NOW"].to_s
    return Time.at(Time.now.to_i).utc if override.empty?

    unless clock_override_allowed?
      raise Error, "AI_OFFICE_NOW is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory"
    end

    parsed = parse_time(override)
    raise Error, "AI_OFFICE_NOW must be YYYY-MM-DDTHH:MM:SSZ, got #{override.inspect}" if parsed.nil?

    parsed
  end

  def clock_override_allowed?
    runs = ENV["AI_OFFICE_RUNS_DIR"].to_s
    return false if runs.empty?

    live = File.expand_path("../runs", __dir__)
    real = lambda do |path|
      File.realpath(path)
    rescue SystemCallError
      File.expand_path(path)
    end
    real.call(runs) != real.call(live)
  end

  # Returns an Array of human-readable error strings; empty when the entries
  # satisfy every integrity rule (see docs/authorization-ledger.md).
  def validate_entries(entries)
    return ["authorizations must be a list"] unless entries.is_a?(Array)

    errors = []
    seen = {}
    last_number = 0
    grants = {}
    revoked = {}

    entries.each_with_index do |entry, index|
      label = "authorizations[#{index}]"
      unless entry.is_a?(Hash)
        errors << "#{label} must be a map"
        next
      end

      number = id_number(entry["id"])
      if number.nil?
        errors << "#{label}.id must match #{ID_PATTERN.inspect}"
      else
        if seen.key?(number)
          errors << "#{label}.id #{entry['id']} duplicates #{entries[seen[number]]['id']} (ids are unique by numeric value)"
        elsif number <= last_number
          errors << "#{label}.id #{entry['id']} must be greater than the previous id (ids increase in file order)"
        end
        seen[number] ||= index
        last_number = number if number > last_number
      end

      %w[actor via reason].each do |key|
        errors << "#{label}.#{key} must be a non-empty string" unless entry[key].is_a?(String) && !entry[key].strip.empty?
      end
      unless parse_time(entry["at"])
        errors << "#{label}.at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
      end

      type = entry["type"]
      unless TYPES.include?(type)
        errors << "#{label}.type must be one of #{TYPES.join(', ')}"
        next
      end

      if type == "grant"
        errors << "#{label}.action must be one of #{ACTIONS.join(', ')}" unless ACTIONS.include?(entry["action"])
        errors << "#{label}.scope must be a non-empty string" unless entry["scope"].is_a?(String) && !entry["scope"].strip.empty?
        errors << "#{label}.revokes is only valid on a revoke" if entry.key?("revokes")
        if entry.key?("expires_at")
          expires = parse_time(entry["expires_at"])
          started = parse_time(entry["at"])
          if expires.nil?
            errors << "#{label}.expires_at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
          elsif started && expires <= started
            errors << "#{label}.expires_at must be strictly after at"
          end
        end
        grants[number] = entry unless number.nil?
      else
        %w[action scope expires_at].each do |key|
          errors << "#{label}.#{key} is only valid on a grant" if entry.key?(key)
        end
        target = id_number(entry["revokes"])
        if target.nil?
          errors << "#{label}.revokes must be an authz-NNN id"
        elsif !number.nil? && target >= number
          errors << "#{label}.revokes #{entry['revokes']} must reference an earlier entry"
        elsif !grants.key?(target)
          errors << "#{label}.revokes #{entry['revokes']} must reference an earlier grant"
        elsif revoked.key?(target)
          errors << "#{label}.revokes #{entry['revokes']} is already revoked by #{format_id(revoked[target])}"
        elsif !number.nil?
          revoked[target] = number
        end
      end
    end
    errors
  end

  # Loads runs/<task>/authorization.yaml. An absent file is an empty ledger.
  # An existing file must be a map with BOTH root keys (task_id, which must equal
  # the task directory's name, and an authorizations list).
  # Anything unreadable, not a map, or violating an integrity rule raises Error:
  # callers that must fail closed rescue it and treat the ledger as unavailable.
  def load(task_dir)
    path = File.join(task_dir, FILENAME)
    return Index.new([]) unless File.exist?(path)

    doc = begin
      YAML.safe_load(File.read(path), permitted_classes: [], aliases: false)
    rescue StandardError => e
      raise Error, "#{path}: #{e.message}"
    end
    raise Error, "#{path}: must be a map with task_id and authorizations" unless doc.is_a?(Hash)

    %w[task_id authorizations].each do |key|
      raise Error, "#{path}: #{key} is required" unless doc.key?(key)
    end
    expected = File.basename(File.expand_path(task_dir))
    unless doc["task_id"] == expected
      raise Error, "#{path}: task_id #{doc['task_id'].inspect} does not match its directory #{expected} " \
                   "(a ledger copied from another task is not this task's source)"
    end
    entries = doc["authorizations"]
    errors = validate_entries(entries)
    raise Error, "#{path}: #{errors.join('; ')}" unless errors.empty?

    Index.new(entries)
  rescue Error
    raise
  rescue StandardError => e
    raise Error, "#{path}: #{e.message}"
  end
end
