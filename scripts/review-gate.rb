#!/usr/bin/env ruby
# frozen_string_literal: true

# Reviewer evidence + risk gate (issue #12).
#
# EVERY rule lives here, so the two consumers can never disagree about what a
# gap is:
#   * validate-yaml.rb requires it and turns the gaps into validation ERRORS
#     when `reviewer.evidence_policy.mode` is `required` (which is what makes
#     `approved` unreachable without evidence), or in ANY mode when the
#     `reviewer:` config is malformed — a gate that cannot classify fails closed;
#   * run-agent.sh runs it as a CLI and logs the result as a meta event, so a
#     gap is recorded in the run history even under the default `warn_only`.
#
# Usage: ruby scripts/review-gate.rb <TASK_ID>
#        ruby scripts/review-gate.rb --upstream-paths <task_dir>
# Exit:  0 = no gaps, or gaps under warn_only (recorded, not blocking)
#        1 = blocking (gaps under `required` on `approved`, or a broken config)
#        2 = usage error
#
# Policy: docs/reviewer-policy.md  Contract: agents/reviewer.md

require "yaml"
require "date"
require_relative "classify-risk"

module ReviewGate
  MODES = %w[warn_only required].freeze
  DEFAULT_MODE = "warn_only"
  BUILD_CHECKS = %w[compile tests].freeze
  # The outputs whose artifacts define what was actually changed. The reviewer's
  # own artifacts[] is a CLAIM about that set, never the definition of it.
  UPSTREAM_OUTPUTS = %w[
    dev-output.yaml dev-2-output.yaml debugger-output.yaml devops-output.yaml free-roam-output.yaml
  ].freeze

  module_function

  def load_output(path)
    return nil unless File.exist?(path)

    data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
    data.is_a?(Hash) ? data : nil
  rescue StandardError
    nil
  end

  def artifact_paths(data)
    return [] unless data.is_a?(Hash)

    Array(data["artifacts"]).map do |artifact|
      next unless artifact.is_a?(Hash)

      path = RiskClassifier.normalize(artifact["path"])
      path.empty? ? nil : path
    end.compact
  end

  # The ONE resolver for "what did this task change" — used by the gate itself
  # and, through the --upstream-paths CLI, by run-agent.sh for the prompt
  # section. Two resolvers would be two answers.
  def upstream_artifact_paths(task_dir)
    UPSTREAM_OUTPUTS.flat_map { |name| artifact_paths(load_output(File.join(task_dir, name))) }.uniq
  end

  # A safety gate must never fail open on a typo. `reviewer:` may be absent
  # entirely (the gate is then simply not configured), but a present block must
  # be complete and well-shaped or every classification silently degrades to
  # `low` while the mode still reports `required`.
  def config_errors(reviewer)
    return [] unless reviewer.is_a?(Hash) && !reviewer.empty?

    errors = []
    unless MODES.include?(mode_of(reviewer))
      errors << "reviewer.evidence_policy.mode must be one of: #{MODES.join(', ')} (got '#{mode_of(reviewer)}')"
    end
    errors.concat(risk_rules_errors(reviewer["risk_rules"]))
    errors.concat(risk_depth_errors(reviewer["risk_depth"]))
    errors
  end

  def risk_rules_errors(rules)
    unless rules.is_a?(Hash)
      return ["reviewer.risk_rules is missing or not a map — every change would silently classify as the default level"]
    end

    errors = []
    unless RiskClassifier::LEVELS.include?(rules["default_level"].to_s)
      errors << "reviewer.risk_rules.default_level must be one of: #{RiskClassifier::LEVELS.join(', ')}"
    end
    triggers = rules["triggers"]
    unless triggers.is_a?(Array) && !triggers.empty?
      return errors << "reviewer.risk_rules.triggers must be a non-empty list"
    end

    triggers.each_with_index do |trigger, i|
      label = "reviewer.risk_rules.triggers[#{i}]"
      unless trigger.is_a?(Hash)
        errors << "#{label} must be a map"
        next
      end
      errors << "#{label}.label must be a non-empty string" unless trigger["label"].is_a?(String) && !trigger["label"].strip.empty?
      errors << "#{label}.level must be one of: #{RiskClassifier::LEVELS.join(', ')}" unless RiskClassifier::LEVELS.include?(trigger["level"].to_s)
      patterns = trigger["patterns"]
      unless patterns.is_a?(Array) && !patterns.empty? && patterns.all? { |p| p.is_a?(String) && !p.strip.empty? }
        errors << "#{label}.patterns must be a non-empty list of glob strings"
      end
    end
    errors
  end

  def risk_depth_errors(depth)
    unless depth.is_a?(Hash)
      return ["reviewer.risk_depth is missing or not a map — no risk level would select any review depth"]
    end

    errors = []
    RiskClassifier::LEVELS.each do |level|
      entry = depth[level]
      unless entry.is_a?(Hash)
        errors << "reviewer.risk_depth.#{level} must be a map"
        next
      end
      unless [true, false].include?(entry["require_evidence"])
        errors << "reviewer.risk_depth.#{level}.require_evidence must be a boolean"
      end
      checks = entry["required_checks"]
      unless checks.is_a?(Array) && checks.all? { |c| BUILD_CHECKS.include?(c.to_s) }
        errors << "reviewer.risk_depth.#{level}.required_checks must be a list of #{BUILD_CHECKS.join('/')}"
      end
    end
    errors
  end

  def reviewer_config(config)
    config.is_a?(Hash) && config["reviewer"].is_a?(Hash) ? config["reviewer"] : {}
  end

  def mode_of(reviewer)
    raw = reviewer.is_a?(Hash) ? reviewer.dig("evidence_policy", "mode").to_s : ""
    raw.empty? ? DEFAULT_MODE : raw
  end

  # Every evidence id the reviewer cites, top level and per claim.
  def cited_refs(data)
    refs = Array(data["evidence_refs"]).select { |r| r.is_a?(String) }
    Array(data["claims"]).each do |claim|
      refs.concat(Array(claim["evidence_refs"]).select { |r| r.is_a?(String) }) if claim.is_a?(Hash)
    end
    refs.uniq
  end

  def load_evidence(task_dir)
    path = File.join(task_dir, "evidence.yaml")
    return [] unless File.exist?(path)

    doc = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
    doc.is_a?(Hash) && doc["evidence"].is_a?(Array) ? doc["evidence"].select { |e| e.is_a?(Hash) } : []
  rescue StandardError
    []
  end

  # "Reviewed state" = the single commit the cited evidence was taken at. It is
  # read from the records themselves, never from live HEAD, so re-validating a
  # finished task months later returns the same answer. Liveness against HEAD
  # stays opt-in behind EVIDENCE_STRICT_SHA (see docs/reviewer-policy.md).
  def state_gaps(records)
    gaps = []
    by_repo = {}
    records.each do |entry|
      id = entry["id"].to_s
      sha = entry["repo_sha"].to_s
      if sha.empty? || sha == "unknown"
        gaps << "#{id} has no repo_sha ('unknown'): it cannot be tied to a reviewed state"
        next
      end
      if entry["working_tree_dirty"] == true
        gaps << "#{id} was recorded against a dirty working tree: #{sha[0, 12]} does not describe what ran"
      end
      (by_repo[entry["repo"].to_s] ||= {})[sha] ||= id
    end

    by_repo.each do |repo, shas|
      next if shas.size < 2

      detail = shas.map { |sha, id| "#{id}@#{sha[0, 12]}" }.sort.join(", ")
      gaps << "cited evidence for #{repo} spans #{shas.size} commits (#{detail}): it does not describe one reviewed state"
    end
    gaps
  end

  # Returns a plain hash (no exceptions) describing the gate outcome.
  #   mode, risk_level, labels, require_evidence, required_checks, gaps, blocking
  def evaluate(config, task_dir, data)
    reviewer = reviewer_config(config)
    mode = mode_of(reviewer)
    data = {} unless data.is_a?(Hash)
    conf_errors = config_errors(reviewer)

    # Risk is classified from the UNION of what the upstream agents declared they
    # changed and what the reviewer listed. Classifying from the reviewer's list
    # alone made the gate escapable by omission: an empty artifacts[] on a
    # wallet+auth change classified `low` and required nothing.
    upstream = upstream_artifact_paths(task_dir)
    reviewed = artifact_paths(data)
    risk = RiskClassifier.classify(reviewer["risk_rules"], (upstream + reviewed).uniq)
    depth = RiskClassifier.depth_for(reviewer, risk["level"])
    require_evidence = depth["require_evidence"] == true
    required_checks = Array(depth["required_checks"]).map(&:to_s)

    build_check = data["build_check"].is_a?(Hash) ? data["build_check"] : {}
    passed = %w[compile tests].select { |k| build_check[k] == "pass" }
    refs = cited_refs(data)
    known = load_evidence(task_dir)
    cited = known.select { |e| refs.include?(e["id"].to_s) }

    gaps = []
    unreviewed = upstream - reviewed
    unless unreviewed.empty?
      gaps << "artifacts[] omits #{unreviewed.size} path(s) the upstream agent declared changed " \
              "(#{unreviewed.sort.join(', ')}): they were not reviewed"
    end
    if require_evidence
      if !passed.empty? && refs.empty?
        gaps << "build_check #{passed.join('/')} claims 'pass' with no evidence_refs " \
                "(risk #{risk['level']}); record the command with scripts/record-evidence.sh"
      end
      gaps.concat(state_gaps(cited))
    end
    required_checks.each do |check|
      next unless build_check[check] == "skipped"

      gaps << "risk #{risk['level']} requires build_check.#{check} to be executed, not 'skipped'"
    end
    # A published risk_level may be RAISED above the path rules but never
    # lowered. This lives here, not in validate-yaml.rb, so the driver records
    # exactly what the validator blocks on — and so it obeys `warn_only`.
    emitted = data["risk_level"]
    if RiskClassifier::LEVELS.include?(emitted) && RiskClassifier.rank(emitted) < RiskClassifier.rank(risk["level"])
      matched = risk["labels"].empty? ? "path rules" : risk["labels"].join(", ")
      gaps << "risk_level '#{emitted}' is below the deterministic classification " \
              "'#{risk['level']}' (#{matched}) — raise it or correct artifacts[].path"
    end

    # A broken config blocks in EVERY mode: `warn_only` is a rollout switch for
    # evidence gaps, not a licence to run a gate that cannot classify.
    blocking = !conf_errors.empty? ||
               (mode == "required" && data["review_verdict"] == "approved" && !gaps.empty?)
    {
      "mode" => mode, "risk_level" => risk["level"], "labels" => risk["labels"],
      "require_evidence" => require_evidence, "required_checks" => required_checks,
      "gaps" => gaps, "config_errors" => conf_errors, "blocking" => blocking
    }
  end
end

if $PROGRAM_NAME == __FILE__
  require_relative "resolve-office-config"

  OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
  # Overridable so tests can point at a temp dir instead of the live runs/.
  RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))

  # run-agent.sh asks for the same path set the gate classifies from, so the
  # prompt it shows the reviewer and the rule it is held to cannot diverge.
  if ARGV[0] == "--upstream-paths"
    task_dir = ARGV[1].to_s
    if task_dir.empty?
      warn "Usage: review-gate.rb --upstream-paths <task_dir>"
      exit 2
    end
    puts ReviewGate.upstream_artifact_paths(task_dir)
    exit 0
  end

  task_id = ARGV[0]
  if task_id.nil? || task_id.strip.empty?
    warn "Usage: review-gate.rb <TASK_ID> | review-gate.rb --upstream-paths <task_dir>"
    exit 2
  end

  task_dir = File.join(RUNS_DIR, task_id)
  output_path = File.join(task_dir, "reviewer-output.yaml")
  # No reviewer verdict yet -> nothing to gate.
  exit 0 unless File.exist?(output_path)

  data = begin
    YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true)
  rescue StandardError
    nil
  end
  # Malformed output is the output contract's problem, not this gate's.
  exit 0 unless data.is_a?(Hash)

  profile = ENV["OFFICE_PROFILE"].to_s.strip
  config = OfficeConfigResolver.new(OFFICE_DIR, profile: profile.empty? ? nil : profile).merged_config
  result = ReviewGate.evaluate(config, task_dir, data)

  # One machine-readable line so the driver can log it verbatim as a meta event.
  puts "mode=#{result['mode']} risk_level=#{result['risk_level']} " \
       "labels=#{result['labels'].empty? ? 'none' : result['labels'].join(',')} " \
       "require_evidence=#{result['require_evidence']} " \
       "config_errors=#{result['config_errors'].size} " \
       "gaps=#{result['gaps'].size}#{result['gaps'].empty? ? '' : ' gap=' + result['gaps'].join(' | ')}"
  result["config_errors"].each { |e| warn "review-gate: #{e}" }
  exit(result["blocking"] ? 1 : 0)
end
