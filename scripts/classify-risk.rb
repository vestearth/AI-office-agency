#!/usr/bin/env ruby
# frozen_string_literal: true

# Deterministic change-risk classifier (issue #12).
#
# Maps changed paths to a review risk level using the path rules in
# office.config.yaml (`reviewer.risk_rules`) — rules, never model judgment. The
# level then selects review depth (`reviewer.risk_depth`), so a docs-only change
# does not pay the cost of an auth/payment/migration change.
#
# Usage: ruby scripts/classify-risk.rb <office_dir> [--explain] <path>...
# Exit:  0 always (the level is the answer, not a verdict); 2 on usage error.
#
# Also required by validate-yaml.rb and scripts/review-gate.rb.

require "yaml"

module RiskClassifier
  LEVELS = %w[high medium low].freeze
  # Higher rank wins when several triggers match; `low` is the floor.
  RANK = { "high" => 3, "medium" => 2, "low" => 1 }.freeze
  FNMATCH_FLAGS = File::FNM_PATHNAME | File::FNM_DOTMATCH | File::FNM_CASEFOLD

  module_function

  # Paths are recorded by agents in whatever form they used; compare on a
  # normalized repo-relative form so `./x`, `/x`, `a/../x` and `x` classify
  # identically. Resolution is lexical — the path need not exist on this machine.
  def normalize(path)
    raw = path.to_s.strip.sub(%r{\A/+}, "")
    segments = []
    raw.split("/").each do |segment|
      case segment
      when "", "." then next
      when ".." then segments.pop
      else segments << segment
      end
    end
    segments.join("/")
  end

  # Set-comparison key. Case is NOT folded: on a case-sensitive filesystem
  # `src/Wallet.go` and `src/wallet.go` are two different files, and folding
  # them let a reviewer cover one and suppress the gap for the other. The glob
  # match stays case-insensitive — over-classifying risk is safe, under-counting
  # unreviewed paths is not.
  def compare_key(path)
    normalize(path)
  end

  def rank(level)
    RANK.fetch(level.to_s, 0)
  end

  # rules = the `reviewer.risk_rules` map; paths = changed file paths.
  # Returns { "level" => ..., "labels" => [...], "matches" => [{path,label,level,pattern}] }.
  def classify(rules, paths)
    rules = {} unless rules.is_a?(Hash)
    default = LEVELS.include?(rules["default_level"].to_s) ? rules["default_level"].to_s : "low"
    triggers = rules["triggers"].is_a?(Array) ? rules["triggers"] : []

    matches = []
    Array(paths).each do |raw|
      candidate = normalize(raw)
      next if candidate.empty?

      triggers.each do |trigger|
        next unless trigger.is_a?(Hash)
        level = trigger["level"].to_s
        next unless LEVELS.include?(level)

        pattern = Array(trigger["patterns"]).find { |p| File.fnmatch?(p.to_s, candidate, FNMATCH_FLAGS) }
        next unless pattern

        matches << {
          "path" => candidate, "label" => trigger["label"].to_s,
          "level" => level, "pattern" => pattern.to_s
        }
      end
    end

    level = matches.map { |m| m["level"] }.max_by { |l| rank(l) } || default
    { "level" => level, "labels" => matches.map { |m| m["label"] }.uniq.sort, "matches" => matches }
  end

  # The depth `level` selects: { require_evidence, required_checks }.
  def depth_for(rules_parent, level)
    depth = rules_parent.is_a?(Hash) ? rules_parent["risk_depth"] : nil
    entry = depth.is_a?(Hash) ? depth[level.to_s] : nil
    entry.is_a?(Hash) ? entry : {}
  end
end

if $PROGRAM_NAME == __FILE__
  require_relative "resolve-office-config"

  office_dir = ARGV.shift
  if office_dir.nil? || office_dir.strip.empty?
    warn "Usage: classify-risk.rb <office_dir> [--explain] <path>..."
    exit 2
  end
  explain = ARGV.delete("--explain")

  profile = ENV["OFFICE_PROFILE"].to_s.strip
  config = OfficeConfigResolver.new(office_dir, profile: profile.empty? ? nil : profile).merged_config
  reviewer = config["reviewer"].is_a?(Hash) ? config["reviewer"] : {}

  result = RiskClassifier.classify(reviewer["risk_rules"], ARGV)
  if explain
    depth = RiskClassifier.depth_for(reviewer, result["level"])
    puts "risk_level=#{result['level']}"
    puts "labels=#{result['labels'].empty? ? 'none' : result['labels'].join(',')}"
    puts "require_evidence=#{depth['require_evidence'] ? 'true' : 'false'}"
    puts "required_checks=#{Array(depth['required_checks']).join(',')}"
    result["matches"].each { |m| puts "match=#{m['path']} label=#{m['label']} level=#{m['level']} pattern=#{m['pattern']}" }
  else
    puts result["level"]
  end
end
