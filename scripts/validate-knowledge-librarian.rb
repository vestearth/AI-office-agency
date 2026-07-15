#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

WRITE_MODES = %w[proposal_only approved_scope_auto_write].freeze
REVIEW_MODES = %w[pre_write post_write].freeze
FINDING_STATUSES = %w[new recurring resolved suppressed].freeze
PRIORITIES = %w[critical high medium low].freeze
EVIDENCE_STATES = %w[confirmed partial missing conflicted].freeze
VERIFICATION_SCOPES = %w[source test ci staging production mixed unverified].freeze
ISSUE_TYPES = %w[
  stale_claim source_gap source_drift broken_link ambiguous_link duplicate orphan
  publication_risk large_feature_capture resolved_debug_capture promotion_candidate other
].freeze
ACTIONS = %w[update_note create_note append_review_queue merge archive propose_adr propose_shared_knowledge no_change].freeze
TARGET_CLASSES = %w[project_note flow review_queue proposed_adr shared_knowledge].freeze
CHANGE_ACTIONS = %w[create update append remove].freeze
DISPOSITIONS = %w[proposed applied].freeze
CONFIDENCE = %w[high medium low].freeze
REPO_ROOT = File.expand_path(ENV.fetch("AI_OFFICE_REPO_ROOT", File.join(__dir__, "../..")))

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
rescue Errno::ENOENT, Psych::Exception => e
  abort "Validation failed: #{path}\n - #{e.message}"
end

def required(hash, keys, label, errors)
  keys.each { |key| errors << "#{label}.#{key} is required" unless hash.key?(key) }
end

def nonempty_string(value, label, errors)
  errors << "#{label} must be a non-empty string" unless value.is_a?(String) && !value.strip.empty?
end

def enum(value, allowed, label, errors)
  errors << "#{label} must be one of: #{allowed.join(', ')}" unless allowed.include?(value)
end

def string_array(value, label, errors, allow_empty: true)
  unless value.is_a?(Array) && value.all? { |item| item.is_a?(String) && !item.strip.empty? }
    errors << "#{label} must be an array of non-empty strings"
    return
  end
  errors << "#{label} must not be empty" if !allow_empty && value.empty?
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

path = ARGV[0]
abort "Usage: ruby ai-dev-office/scripts/validate-knowledge-librarian.rb <path-to-yaml>" if path.nil? || path.strip.empty?

data = load_yaml(path)
errors = []

unless data.is_a?(Hash)
  abort "Validation failed: #{path}\n - document must be a map"
end

required(data, %w[artifact_type schema_version review_id generated_at scope write_mode review_mode authorization requires_human_review notes_reviewed findings changes summary], "document", errors)
errors << "document.artifact_type must be knowledge_librarian_review" unless data["artifact_type"] == "knowledge_librarian_review"
errors << "document.schema_version must be 1" unless data["schema_version"] == 1
nonempty_string(data["review_id"], "document.review_id", errors)
errors << "document.review_id has invalid format" unless data["review_id"].to_s.match?(/\AKLR-\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]*\z/)
nonempty_string(data["generated_at"], "document.generated_at", errors)
enum(data["write_mode"], WRITE_MODES, "document.write_mode", errors)
enum(data["review_mode"], REVIEW_MODES, "document.review_mode", errors)
errors << "document.requires_human_review must be true" unless data["requires_human_review"] == true
nonempty_string(data["summary"], "document.summary", errors)
string_array(data["notes_reviewed"], "document.notes_reviewed", errors) if data.key?("notes_reviewed")

scope = data["scope"]
if scope.is_a?(Hash)
  required(scope, %w[product paths max_notes timebox_minutes], "document.scope", errors)
  nonempty_string(scope["product"], "document.scope.product", errors)
  string_array(scope["paths"], "document.scope.paths", errors, allow_empty: false)
  errors << "document.scope.max_notes must be an integer from 1 to 5" unless scope["max_notes"].is_a?(Integer) && (1..5).cover?(scope["max_notes"])
  errors << "document.scope.timebox_minutes must be an integer from 1 to 20" unless scope["timebox_minutes"].is_a?(Integer) && (1..20).cover?(scope["timebox_minutes"])
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
    required(finding, %w[fingerprint note_path question issue_type status priority evidence_state verification_scope sources recommended_action closure_criteria answer opened_at closed_at confidence proposed_patch], label, errors)
    %w[fingerprint note_path question closure_criteria].each { |key| nonempty_string(finding[key], "#{label}.#{key}", errors) }
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
    required(change, %w[note_path target_class action disposition finding_fingerprint resulting_status summary], label, errors)
    %w[note_path finding_fingerprint summary].each { |key| nonempty_string(change[key], "#{label}.#{key}", errors) }
    enum(change["target_class"], TARGET_CLASSES, "#{label}.target_class", errors)
    enum(change["action"], CHANGE_ACTIONS, "#{label}.action", errors)
    enum(change["disposition"], DISPOSITIONS, "#{label}.disposition", errors)
  end
else
  errors << "document.changes must be an array"
  changes = []
end

if data["write_mode"] == "proposal_only"
  errors << "proposal_only requires review_mode pre_write" unless data["review_mode"] == "pre_write"
  errors << "proposal_only requires authorization: null" unless data["authorization"].nil?
  errors << "proposal_only cannot contain applied changes" if changes.any? { |change| change.is_a?(Hash) && change["disposition"] == "applied" }
elsif data["write_mode"] == "approved_scope_auto_write"
  errors << "approved_scope_auto_write requires review_mode post_write" unless data["review_mode"] == "post_write"
  authorization = data["authorization"]
  if authorization.is_a?(Hash)
    required(authorization, %w[approved_scope policy_source approved_by approved_at], "document.authorization", errors)
    %w[approved_scope policy_source approved_by approved_at].each { |key| nonempty_string(authorization[key], "document.authorization.#{key}", errors) }
  else
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
  puts "Knowledge Librarian validation passed: #{path}"
  exit 0
end

warn "Knowledge Librarian validation failed: #{path}"
errors.each { |error| warn " - #{error}" }
exit 1
