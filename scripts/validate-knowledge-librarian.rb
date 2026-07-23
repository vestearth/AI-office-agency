#!/usr/bin/env ruby
# frozen_string_literal: true

require "date"
require "json"
require "yaml"

SCHEMA_PATH = File.expand_path(File.join(__dir__, "../schemas/knowledge-librarian-output.schema.json"))
SCHEMA = JSON.parse(File.read(SCHEMA_PATH)).freeze
FINDING_SCHEMA = SCHEMA.fetch("$defs").fetch("finding").freeze
CHANGE_SCHEMA = SCHEMA.fetch("$defs").fetch("change").freeze

WRITE_MODES = SCHEMA.dig("properties", "write_mode", "enum").freeze
REVIEW_MODES = SCHEMA.dig("properties", "review_mode", "enum").freeze
FINDING_STATUSES = FINDING_SCHEMA.dig("properties", "status", "enum").freeze
PRIORITIES = FINDING_SCHEMA.dig("properties", "priority", "enum").freeze
EVIDENCE_STATES = FINDING_SCHEMA.dig("properties", "evidence_state", "enum").freeze
VERIFICATION_SCOPES = FINDING_SCHEMA.dig("properties", "verification_scope", "enum").freeze
ISSUE_TYPES = FINDING_SCHEMA.dig("properties", "issue_type", "enum").freeze
ACTIONS = FINDING_SCHEMA.dig("properties", "recommended_action", "enum").freeze
TARGET_CLASSES = CHANGE_SCHEMA.dig("properties", "target_class", "enum").freeze
CHANGE_ACTIONS = CHANGE_SCHEMA.dig("properties", "action", "enum").freeze
DISPOSITIONS = CHANGE_SCHEMA.dig("properties", "disposition", "enum").freeze
CONFIDENCE = FINDING_SCHEMA.dig("properties", "confidence", "enum").freeze
ROOT_KEYS = SCHEMA.fetch("properties").keys.freeze
ROOT_REQUIRED = SCHEMA.fetch("required").freeze
SCOPE_SCHEMA = SCHEMA.dig("properties", "scope").freeze
SCOPE_KEYS = SCOPE_SCHEMA.fetch("properties").keys.freeze
SCOPE_REQUIRED = SCOPE_SCHEMA.fetch("required").freeze
AUTHORIZATION_SCHEMA = SCHEMA.dig("properties", "authorization", "oneOf", 1).freeze
AUTHORIZATION_KEYS = AUTHORIZATION_SCHEMA.fetch("properties").keys.freeze
AUTHORIZATION_REQUIRED = AUTHORIZATION_SCHEMA.fetch("required").freeze
FINDING_KEYS = FINDING_SCHEMA.fetch("properties").keys.freeze
FINDING_REQUIRED = FINDING_SCHEMA.fetch("required").freeze
CHANGE_KEYS = CHANGE_SCHEMA.fetch("properties").keys.freeze
CHANGE_REQUIRED = CHANGE_SCHEMA.fetch("required").freeze
REVIEW_ID_PATTERN = Regexp.new(SCHEMA.dig("properties", "review_id", "pattern"))
FINGERPRINT_PATTERN = Regexp.new(FINDING_SCHEMA.dig("properties", "fingerprint", "pattern"))
REPO_ROOT = File.expand_path(ENV.fetch("AI_OFFICE_REPO_ROOT", File.join(__dir__, "../..")))

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
end

def required(hash, keys, label, errors)
  keys.each { |key| errors << "#{label}.#{key} is required" unless hash.key?(key) }
end

def exact_keys(hash, allowed, label, errors)
  unexpected = hash.keys - allowed
  errors << "#{label} contains unsupported field(s): #{unexpected.join(', ')}" unless unexpected.empty?
end

def nonempty_string(value, label, errors)
  errors << "#{label} must be a non-empty string" unless value.is_a?(String) && !value.strip.empty?
end

def enum(value, allowed, label, errors)
  errors << "#{label} must be one of: #{allowed.join(', ')}" unless allowed.include?(value)
end

def string_array(value, label, errors, allow_empty: true, unique: false)
  unless value.is_a?(Array) && value.all? { |item| item.is_a?(String) && !item.strip.empty? }
    errors << "#{label} must be an array of non-empty strings"
    return
  end
  errors << "#{label} must not be empty" if !allow_empty && value.empty?
  errors << "#{label} must contain unique values" if unique && value.uniq.length != value.length
end

def date_time(value, label, errors, nullable: false)
  return if nullable && value.nil?

  pattern = /\A\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)\z/i
  unless value.is_a?(String) && value.match?(pattern)
    errors << "#{label} must be an ISO date-time"
    return
  end
  DateTime.rfc3339(value)
rescue ArgumentError
  errors << "#{label} must be an ISO date-time"
end

def date(value, label, errors)
  unless value.is_a?(String) && value.match?(/\A\d{4}-\d{2}-\d{2}\z/)
    errors << "#{label} must be an ISO date"
    return
  end
  Date.iso8601(value)
rescue ArgumentError
  errors << "#{label} must be an ISO date"
end

def load_authorization_policy(authorization, errors)
  source = authorization["policy_source"].to_s
  path = File.expand_path(source, REPO_ROOT)
  unless path.start_with?(REPO_ROOT + File::SEPARATOR)
    errors << "document.authorization.policy_source must stay inside the repository root"
    return nil
  end
  unless File.file?(path)
    errors << "document.authorization.policy_source not found: #{source}"
    return nil
  end

  policy = YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
  unless policy.is_a?(Hash) && policy["version"] == 1 && policy["scopes"].is_a?(Hash)
    errors << "authorization policy must define version: 1 and scopes"
    return nil
  end
  policy
rescue Psych::Exception => e
  errors << "authorization policy is invalid YAML: #{e.message}"
  nil
end

def authorized_change?(change, target_rules, errors)
  target_rules.any? do |rule|
    next false unless rule.is_a?(Hash)
    next false unless rule["target_class"] == change["target_class"]
    next false unless Array(rule["actions"]).include?(change["action"])
    next false if rule.key?("resulting_status") && rule["resulting_status"] != change["resulting_status"]

    begin
      Regexp.new(rule["path_pattern"].to_s).match?(change["note_path"].to_s)
    rescue RegexpError => e
      errors << "authorization policy has invalid path_pattern: #{e.message}"
      false
    end
  end
end

def normalize_review(data)
  findings = data.fetch("findings")
  changes = data.fetch("changes")
  {
    "reviewId" => data.fetch("review_id"),
    "generatedAt" => data.fetch("generated_at"),
    "scope" => {
      "product" => data.dig("scope", "product"),
      "paths" => data.dig("scope", "paths"),
      "maxNotes" => data.dig("scope", "max_notes"),
      "timeboxMinutes" => data.dig("scope", "timebox_minutes")
    },
    "writeMode" => data.fetch("write_mode"),
    "reviewMode" => data.fetch("review_mode"),
    "authorization" => data["authorization"] && {
      "approvedScope" => data.dig("authorization", "approved_scope"),
      "policySource" => data.dig("authorization", "policy_source"),
      "approvedBy" => data.dig("authorization", "approved_by"),
      "approvedAt" => data.dig("authorization", "approved_at")
    },
    "requiresHumanReview" => data.fetch("requires_human_review"),
    "notesReviewed" => data.fetch("notes_reviewed"),
    "notesReviewedCount" => data.fetch("notes_reviewed").length,
    "findingsCount" => findings.length,
    "changesCount" => changes.length,
    "appliedChangesCount" => changes.count { |change| change["disposition"] == "applied" },
    "summary" => data.fetch("summary"),
    "findings" => findings.map do |finding|
      {
        "fingerprint" => finding.fetch("fingerprint"),
        "notePath" => finding.fetch("note_path"),
        "question" => finding.fetch("question"),
        "issueType" => finding.fetch("issue_type"),
        "status" => finding.fetch("status"),
        "priority" => finding.fetch("priority"),
        "evidenceState" => finding.fetch("evidence_state"),
        "verificationScope" => finding.fetch("verification_scope"),
        "sources" => finding.fetch("sources"),
        "recommendedAction" => finding.fetch("recommended_action"),
        "answer" => finding.fetch("answer"),
        "confidence" => finding.fetch("confidence")
      }
    end,
    "changes" => changes.map do |change|
      {
        "notePath" => change.fetch("note_path"),
        "targetClass" => change.fetch("target_class"),
        "action" => change.fetch("action"),
        "disposition" => change.fetch("disposition"),
        "findingFingerprint" => change.fetch("finding_fingerprint"),
        "resultingStatus" => change.fetch("resulting_status"),
        "summary" => change.fetch("summary")
      }
    end
  }
end

json_mode = ARGV.first == "--json"
arguments = json_mode ? ARGV.drop(1) : ARGV
path = arguments.first
usage = "Usage: ruby ai-dev-office/scripts/validate-knowledge-librarian.rb [--json] <path-to-yaml>"
abort usage unless arguments.length == 1 && path.is_a?(String) && !path.strip.empty?

errors = []
begin
  data = load_yaml(path)
rescue Errno::ENOENT, Psych::Exception => e
  errors << e.message
  data = nil
end

unless data.is_a?(Hash)
  errors << "document must be a map" if errors.empty?
  if json_mode
    puts JSON.generate({ "valid" => false, "errors" => errors })
  else
    warn "Knowledge Librarian validation failed: #{path}"
    errors.each { |error| warn " - #{error}" }
  end
  exit 1
end

required(data, ROOT_REQUIRED, "document", errors)
exact_keys(data, ROOT_KEYS, "document", errors)
errors << "document.artifact_type must be knowledge_librarian_review" unless data["artifact_type"] == "knowledge_librarian_review"
errors << "document.schema_version must be 1" unless data["schema_version"] == 1
nonempty_string(data["review_id"], "document.review_id", errors)
errors << "document.review_id has invalid format" unless data["review_id"].to_s.match?(REVIEW_ID_PATTERN)
date_time(data["generated_at"], "document.generated_at", errors)
enum(data["write_mode"], WRITE_MODES, "document.write_mode", errors)
enum(data["review_mode"], REVIEW_MODES, "document.review_mode", errors)
errors << "document.requires_human_review must be true" unless data["requires_human_review"] == true
nonempty_string(data["summary"], "document.summary", errors)
string_array(data["notes_reviewed"], "document.notes_reviewed", errors, unique: true) if data.key?("notes_reviewed")

scope = data["scope"]
if scope.is_a?(Hash)
  required(scope, SCOPE_REQUIRED, "document.scope", errors)
  exact_keys(scope, SCOPE_KEYS, "document.scope", errors)
  nonempty_string(scope["product"], "document.scope.product", errors)
  string_array(scope["paths"], "document.scope.paths", errors, allow_empty: false)
  max_notes_schema = SCOPE_SCHEMA.dig("properties", "max_notes")
  timebox_schema = SCOPE_SCHEMA.dig("properties", "timebox_minutes")
  max_notes_range = max_notes_schema.fetch("minimum")..max_notes_schema.fetch("maximum")
  timebox_range = timebox_schema.fetch("minimum")..timebox_schema.fetch("maximum")
  errors << "document.scope.max_notes must be an integer from #{max_notes_range.begin} to #{max_notes_range.end}" unless scope["max_notes"].is_a?(Integer) && max_notes_range.cover?(scope["max_notes"])
  errors << "document.scope.timebox_minutes must be an integer from #{timebox_range.begin} to #{timebox_range.end}" unless scope["timebox_minutes"].is_a?(Integer) && timebox_range.cover?(scope["timebox_minutes"])
else
  errors << "document.scope must be a map"
end

findings = data["findings"]
if findings.is_a?(Array)
  findings.each_with_index do |finding, index|
    label = "document.findings[#{index}]"
    unless finding.is_a?(Hash)
      errors << "#{label} must be a map"
      next
    end
    required(finding, FINDING_REQUIRED, label, errors)
    exact_keys(finding, FINDING_KEYS, label, errors)
    %w[fingerprint note_path question closure_criteria].each { |key| nonempty_string(finding[key], "#{label}.#{key}", errors) }
    errors << "#{label}.fingerprint has invalid format" unless finding["fingerprint"].to_s.match?(FINGERPRINT_PATTERN)
    enum(finding["issue_type"], ISSUE_TYPES, "#{label}.issue_type", errors)
    enum(finding["status"], FINDING_STATUSES, "#{label}.status", errors)
    enum(finding["priority"], PRIORITIES, "#{label}.priority", errors)
    enum(finding["evidence_state"], EVIDENCE_STATES, "#{label}.evidence_state", errors)
    enum(finding["verification_scope"], VERIFICATION_SCOPES, "#{label}.verification_scope", errors)
    string_array(finding["sources"], "#{label}.sources", errors, allow_empty: false)
    enum(finding["recommended_action"], ACTIONS, "#{label}.recommended_action", errors)
    enum(finding["confidence"], CONFIDENCE, "#{label}.confidence", errors)
    errors << "#{label}.answer must be a string" unless finding["answer"].is_a?(String)
    errors << "#{label}.proposed_patch must be a string" unless finding["proposed_patch"].is_a?(String)
    date_time(finding["opened_at"], "#{label}.opened_at", errors, nullable: true)
    date_time(finding["closed_at"], "#{label}.closed_at", errors, nullable: true)
    next unless finding["status"] == "resolved"

    nonempty_string(finding["answer"], "#{label}.answer", errors)
    nonempty_string(finding["closed_at"], "#{label}.closed_at", errors)
    errors << "#{label}.evidence_state must be confirmed when resolved" unless finding["evidence_state"] == "confirmed"
  end
else
  errors << "document.findings must be an array"
end

changes = data["changes"]
if changes.is_a?(Array)
  changes.each_with_index do |change, index|
    label = "document.changes[#{index}]"
    unless change.is_a?(Hash)
      errors << "#{label} must be a map"
      next
    end
    required(change, CHANGE_REQUIRED, label, errors)
    exact_keys(change, CHANGE_KEYS, label, errors)
    %w[note_path finding_fingerprint summary].each { |key| nonempty_string(change[key], "#{label}.#{key}", errors) }
    enum(change["target_class"], TARGET_CLASSES, "#{label}.target_class", errors)
    enum(change["action"], CHANGE_ACTIONS, "#{label}.action", errors)
    enum(change["disposition"], DISPOSITIONS, "#{label}.disposition", errors)
    errors << "#{label}.resulting_status must be a string or null" unless change["resulting_status"].nil? || change["resulting_status"].is_a?(String)
  end
else
  errors << "document.changes must be an array"
  changes = []
end

authorization = data["authorization"]
if authorization.is_a?(Hash)
  required(authorization, AUTHORIZATION_REQUIRED, "document.authorization", errors)
  exact_keys(authorization, AUTHORIZATION_KEYS, "document.authorization", errors)
  %w[approved_scope policy_source approved_by].each { |key| nonempty_string(authorization[key], "document.authorization.#{key}", errors) }
  date(authorization["approved_at"], "document.authorization.approved_at", errors)
elsif !authorization.nil?
  errors << "document.authorization must be a map or null"
end

if data["write_mode"] == "proposal_only"
  errors << "proposal_only requires review_mode pre_write" unless data["review_mode"] == "pre_write"
  errors << "proposal_only requires authorization: null" unless data["authorization"].nil?
  errors << "proposal_only cannot contain applied changes" if changes.any? { |change| change.is_a?(Hash) && change["disposition"] == "applied" }
elsif data["write_mode"] == "approved_scope_auto_write"
  errors << "approved_scope_auto_write requires review_mode post_write" unless data["review_mode"] == "post_write"
  unless authorization.is_a?(Hash)
    errors << "approved_scope_auto_write requires authorization details"
  end
  applied = changes.select { |change| change.is_a?(Hash) && change["disposition"] == "applied" }
  errors << "approved_scope_auto_write requires at least one applied change" if applied.empty?

  if authorization.is_a?(Hash)
    approved_scope = authorization["approved_scope"]
    errors << "auto-write scope.product must match authorization.approved_scope" unless scope.is_a?(Hash) && scope["product"] == approved_scope
    policy = load_authorization_policy(authorization, errors)
    scope_policy = policy.dig("scopes", approved_scope) if policy
    unless scope_policy.is_a?(Hash)
      errors << "authorization policy does not approve scope: #{approved_scope}" if policy
    else
      errors << "authorization approved_by does not match policy" unless authorization["approved_by"] == scope_policy["approved_by"]
      errors << "authorization approved_at does not match policy" unless authorization["approved_at"] == scope_policy["approved_at"]
      errors << "review_mode does not match authorization policy" unless data["review_mode"] == scope_policy["review_mode"]
      target_rules = scope_policy["write_targets"]
      unless target_rules.is_a?(Array) && !target_rules.empty?
        errors << "authorization policy scope must define write_targets"
        target_rules = []
      end
      applied.each do |change|
        unless authorized_change?(change, target_rules, errors)
          errors << "auto-write target is outside the approved #{approved_scope} boundary: #{change['note_path']}"
        end
      end
    end
  end
end

if findings.is_a?(Array)
  fingerprints = findings.each_with_object([]) do |finding, values|
    values << finding["fingerprint"] if finding.is_a?(Hash)
  end
  changes.each do |change|
    next unless change.is_a?(Hash)
    errors << "change references unknown finding fingerprint: #{change['finding_fingerprint']}" unless fingerprints.include?(change["finding_fingerprint"])
  end
end

if errors.empty?
  if json_mode
    puts JSON.generate({ "valid" => true, "review" => normalize_review(data) })
  else
    puts "Knowledge Librarian validation passed: #{path}"
  end
  exit 0
end

if json_mode
  puts JSON.generate({ "valid" => false, "errors" => errors })
else
  warn "Knowledge Librarian validation failed: #{path}"
  errors.each { |error| warn " - #{error}" }
end
exit 1
