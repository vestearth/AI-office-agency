#!/usr/bin/env ruby
# frozen_string_literal: true

# Issue #58 (workflow learning), collector v0: a READ-ONLY report over runs/.
#
# It counts structured rework signals only:
#   - a history row that moves INTO `debugging` (`… -> debugging`). A row like
#     `in_review -> in_review` is mostly a progress note and is never counted;
#   - `defect_class` on debugger (diagnosis.defect_class) and reviewer outputs;
#   - debugger `affected_files` paths, by repository (first path segment);
#   - knowledge closeout coverage of `done` runs (a closeout record naming the
#     task, or runs/<task>/knowledge-capture-output.yaml).
# A class seen in two or more distinct tasks is listed as `recurring`: a
# candidate for a human-reviewed proposal, never a rule (docs/workflow-learning.md).
#
# It writes nothing. Usage:
#   ruby scripts/learning-collector.rb [--json] [--since YYYY-MM-DD]
# Env: AI_OFFICE_RUNS_DIR, AI_OFFICE_REVIEWS_DIR (as the other office scripts).
# Exit: 0 ok; 2 usage error.

require "date"
require "json"
require "optparse"
require "yaml"

OFFICE_DIR = File.expand_path("..", __dir__)
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
REVIEWS_DIR = ENV.fetch("AI_OFFICE_REVIEWS_DIR", File.join(OFFICE_DIR, "knowledge-reviews"))
TASK_DIR_PATTERN = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/.freeze
RECURRING_MIN_TASKS = 2
# Diagnoses sometimes name absolute paths; under the workspace root (the
# office's parent folder) the first segment after it is the repository.
WORKSPACE_PREFIX = %r{\A#{Regexp.escape(File.dirname(OFFICE_DIR))}/}.freeze

# The validator owns the vocabulary; it cannot be required (it runs a CLI at
# load), so read the constant the way tests/integration/schema-validator-parity.sh does.
def defect_classes
  src = File.read(File.join(OFFICE_DIR, "validate-yaml.rb"), encoding: "UTF-8")
  m = src.match(/^DEFECT_CLASSES\s*=\s*%w\[([^\]]*)\]/m) or abort "learning-collector: DEFECT_CLASSES not found in validate-yaml.rb"
  m[1].split
end

def load(path)
  return nil unless File.file?(path)

  data = YAML.safe_load(File.read(path, encoding: "UTF-8"), permitted_classes: [Date, Time])
  data.is_a?(Hash) ? data : nil
rescue Psych::Exception, SystemCallError
  nil
end

opts = {}
parser = OptionParser.new do |o|
  o.banner = "Usage: learning-collector.rb [--json] [--since YYYY-MM-DD]"
  o.on("--json") { opts[:json] = true }
  o.on("--since DATE") { |v| opts[:since] = v }
end
begin
  parser.parse!(ARGV)
  raise OptionParser::InvalidArgument, ARGV.join(" ") unless ARGV.empty?
  if opts[:since]
    raise OptionParser::InvalidArgument, "--since #{opts[:since]}" unless opts[:since].match?(/\A\d{4}-\d{2}-\d{2}\z/)

    Date.iso8601(opts[:since])
  end
rescue OptionParser::ParseError, ArgumentError => e
  warn e.message
  warn parser.banner
  exit 2
end

classes = defect_classes
closed_by_record = Dir.glob(File.join(REVIEWS_DIR, "closeouts", "*.yaml")).map { |f| load(f)&.dig("task_id") }.compact.map { |t| [t.to_s, true] }.to_h

totals = { "runs" => 0, "done" => 0 }
by_prefix = Hash.new { |h, k| h[k] = { "runs" => 0, "done" => 0, "runs_with_debugging" => 0, "debugging_cycles" => 0 } }
by_class = Hash.new { |h, k| h[k] = { "count" => 0, "tasks" => [] } }
unknown = Hash.new { |h, k| h[k] = [] }
unclassified = { "debugger" => [], "reviewer_changes_requested" => [] }
repos = Hash.new(0)
closeout_missing = []

Dir.children(RUNS_DIR).sort.each do |id|
  next unless id.match?(TASK_DIR_PATTERN)

  dir = File.join(RUNS_DIR, id)
  status = load(File.join(dir, "status.yaml"))
  next unless status
  next if opts[:since] && status["updated_at"].to_s[0, 10] < opts[:since]

  prefix = id[/\ATASK-([A-Z][A-Z0-9]*)-\d+\z/, 1] || "none"
  done = status["phase"].to_s == "done"
  cycles = Array(status["history"]).count { |h| h.is_a?(Hash) && h["phase"].to_s.match?(/->\s*debugging\s*\z/) }

  totals["runs"] += 1
  totals["done"] += 1 if done
  row = by_prefix[prefix]
  row["runs"] += 1
  row["done"] += 1 if done
  row["runs_with_debugging"] += 1 if cycles.positive?
  row["debugging_cycles"] += cycles

  seen = []
  record_class = lambda do |value, source|
    if value.nil? || value.to_s.empty?
      unclassified[source] << id
    elsif classes.include?(value)
      seen << value
    else
      unknown[value.to_s] << id
    end
  end

  if (debugger = load(File.join(dir, "debugger-output.yaml")))
    diagnosis = debugger["diagnosis"].is_a?(Hash) ? debugger["diagnosis"] : {}
    record_class.call(diagnosis["defect_class"], "debugger")
    Array(diagnosis["affected_files"]).map { |f| f.is_a?(Hash) ? f["path"] : f }.compact
                                      .map { |p| p.to_s.sub(WORKSPACE_PREFIX, "").sub(%r{\A/+}, "").split("/").first.to_s }
                                      .reject(&:empty?).uniq.each { |repo| repos[repo] += 1 }
  end
  reviewer = load(File.join(dir, "reviewer-output.yaml"))
  if reviewer && reviewer["review_verdict"].to_s != "approved"
    source = reviewer["review_verdict"].to_s == "changes_requested" ? "reviewer_changes_requested" : nil
    if source
      record_class.call(reviewer["defect_class"], source)
    elsif reviewer["defect_class"]
      record_class.call(reviewer["defect_class"], "debugger")
    end
  end
  seen.uniq.each do |klass|
    by_class[klass]["count"] += 1
    by_class[klass]["tasks"] << id
  end

  if done && !closed_by_record[id] && !File.file?(File.join(dir, "knowledge-capture-output.yaml"))
    closeout_missing << id
  end
end

report = {
  "since" => opts[:since],
  "classes" => classes,
  "totals" => totals,
  "by_prefix" => by_prefix.sort.to_h,
  "defect_classes" => by_class.sort_by { |k, v| [-v["count"], k] }.to_h,
  "recurring" => by_class.select { |_, v| v["tasks"].size >= RECURRING_MIN_TASKS }.keys.sort,
  "unknown_classes" => unknown.sort.to_h,
  "unclassified" => unclassified,
  "debugger_repos" => repos.sort.to_h,
  "closeout" => { "done" => totals["done"], "missing" => closeout_missing }
}

if opts[:json]
  puts JSON.generate(report)
  exit 0
end

pct = ->(n, d) { d.zero? ? "-" : "#{(100.0 * n / d).round}%" }
out = []
out << "# Workflow learning report"
out << ""
out << "Read-only; issue #58. Since: #{opts[:since] || 'all runs'}. Runs: #{totals['runs']}, done: #{totals['done']}."
out << ""
out << "## Rework (entries into debugging)"
out << ""
out << "| Prefix | Runs | Done | Runs with debugging | Debugging cycles |"
out << "|---|---|---|---|---|"
report["by_prefix"].each do |prefix, r|
  out << "| #{prefix} | #{r['runs']} | #{r['done']} | #{r['runs_with_debugging']} (#{pct.call(r['runs_with_debugging'], r['runs'])}) | #{r['debugging_cycles']} |"
end
out << ""
out << "## Defect classes"
out << ""
if report["defect_classes"].empty?
  out << "No classified defects yet."
else
  report["defect_classes"].each { |k, v| out << "- `#{k}`: #{v['count']} task(s) — #{v['tasks'].join(', ')}" }
end
out << ""
out << "Recurring (#{RECURRING_MIN_TASKS}+ tasks, proposal candidates only): #{report['recurring'].empty? ? 'none' : report['recurring'].map { |k| "`#{k}`" }.join(', ')}"
unless report["unknown_classes"].empty?
  out << ""
  out << "Unknown classes (not in validate-yaml.rb DEFECT_CLASSES): #{report['unknown_classes'].map { |k, v| "`#{k}` (#{v.join(', ')})" }.join('; ')}"
end
out << ""
out << "Unclassified: #{unclassified['debugger'].size} debugger output(s), #{unclassified['reviewer_changes_requested'].size} changes_requested review(s)."
out << ""
out << "## Repositories in debugger diagnoses"
out << ""
report["debugger_repos"].sort_by { |k, v| [-v, k] }.each { |k, v| out << "- #{k}: #{v}" }
out << ""
out << "## Knowledge closeout"
out << ""
out << "#{report['closeout']['missing'].size} of #{totals['done']} done run(s) have neither a closeout record nor a capture."
puts out.join("\n")
