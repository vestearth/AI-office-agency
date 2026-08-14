#!/usr/bin/env ruby
# frozen_string_literal: true

# Reviewer evidence + risk gate (issue #12).
#
# One implementation of the gate, two consumers:
#   * validate-yaml.rb requires it and turns the gaps into validation ERRORS
#     when `reviewer.evidence_policy.mode` is `required` (which is what makes
#     `approved` unreachable without evidence);
#   * run-agent.sh runs it as a CLI and logs the result as a meta event, so a
#     gap is recorded in the run history even under the default `warn_only`.
#
# Usage: ruby scripts/review-gate.rb <TASK_ID>
# Exit:  0 = no gaps, or gaps under warn_only (recorded, not blocking)
#        1 = gaps under `required` on an `approved` verdict (blocking)
#        2 = usage / config error
#
# Policy: docs/reviewer-policy.md  Contract: agents/reviewer.md

require "yaml"
require "date"
require_relative "classify-risk"

module ReviewGate
  MODES = %w[warn_only required].freeze
  DEFAULT_MODE = "warn_only"

  module_function

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

    paths = Array(data["artifacts"]).map { |a| a["path"] if a.is_a?(Hash) }.compact
    risk = RiskClassifier.classify(reviewer["risk_rules"], paths)
    depth = RiskClassifier.depth_for(reviewer, risk["level"])
    require_evidence = depth["require_evidence"] == true
    required_checks = Array(depth["required_checks"]).map(&:to_s)

    build_check = data["build_check"].is_a?(Hash) ? data["build_check"] : {}
    passed = %w[compile tests].select { |k| build_check[k] == "pass" }
    refs = cited_refs(data)
    known = load_evidence(task_dir)
    cited = known.select { |e| refs.include?(e["id"].to_s) }

    gaps = []
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

    blocking = mode == "required" && data["review_verdict"] == "approved" && !gaps.empty?
    {
      "mode" => mode, "risk_level" => risk["level"], "labels" => risk["labels"],
      "require_evidence" => require_evidence, "required_checks" => required_checks,
      "gaps" => gaps, "blocking" => blocking
    }
  end
end

if $PROGRAM_NAME == __FILE__
  require_relative "resolve-office-config"

  OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
  # Overridable so tests can point at a temp dir instead of the live runs/.
  RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))

  task_id = ARGV[0]
  if task_id.nil? || task_id.strip.empty?
    warn "Usage: review-gate.rb <TASK_ID>"
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
       "gaps=#{result['gaps'].size}#{result['gaps'].empty? ? '' : ' gap=' + result['gaps'].join(' | ')}"
  exit(result["blocking"] ? 1 : 0)
end
