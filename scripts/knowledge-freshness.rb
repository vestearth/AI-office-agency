#!/usr/bin/env ruby
# frozen_string_literal: true

# Surface knowledge whose supporting evidence has been marked (issue #15).
#
# This is the DISCOVERABILITY half of stale-evidence invalidation. Degraded
# knowledge is never deleted, hidden, or rewritten — it is listed here with the
# marks that degraded it, so a human can decide whether to re-verify, correct,
# or leave it. Reporting only: this script writes nothing, anywhere.
#
# Effective freshness of a knowledge-capture output is the MOST SEVERE of its
# declared `provenance.freshness` and the marks standing against every evidence
# id it cites, on the ordering:
#
#     current < unknown < maybe_stale < stale < invalid
#
# `historical` is exempt — a note that records the past on purpose never becomes
# stale (canonical vocabulary, knowledge-base "Provenance And Freshness").
# An output with no provenance block is `unknown`: no provenance is not an
# accusation, and such outputs are reported, never flagged.
#
# It is a pure function of two files per task — knowledge-capture-output.yaml and
# evidence-freshness.yaml. No clock, no repo I/O, no HEAD comparison.
#
# Usage:
#   scripts/knowledge-freshness.rb              # every task under runs/
#   scripts/knowledge-freshness.rb <TASK_ID>    # one task
#   scripts/knowledge-freshness.rb --degraded   # only the ones needing attention
# Exit: 0 always (this is a report, not a gate — validate-yaml.rb is the gate);
#       2 usage error.
#
# Docs: docs/knowledge-provenance.md

require "yaml"
require "date"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))

SEVERITY = { "current" => 0, "unknown" => 1, "maybe_stale" => 2, "stale" => 3, "invalid" => 4 }.freeze
# Only these three can be WRITTEN as a mark; validate-yaml.rb's
# FRESHNESS_MARK_STATES is the same list. The reporter must honour the same
# subset, or a hand-appended `current` mark would overwrite a real degrading
# one here (last-write-wins) and quietly empty --degraded, which is the one
# surface a human reads to find what needs re-checking.
MARK_STATES = %w[maybe_stale stale invalid].freeze
EXEMPT = "historical"

def load_doc(path)
  return nil unless File.exist?(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
rescue Psych::SyntaxError
  nil
end

# Last mark wins per evidence id — the ledger is append-only history and a later
# operator judgment supersedes an earlier one.
def marks_for(task_dir)
  doc = load_doc(File.join(task_dir, "evidence-freshness.yaml"))
  return {} unless doc.is_a?(Hash) && doc["marks"].is_a?(Array)

  doc["marks"].each_with_object({}) do |mark, acc|
    next unless mark.is_a?(Hash) && mark["evidence_id"].is_a?(String) && MARK_STATES.include?(mark["state"])
    acc[mark["evidence_id"]] = mark
  end
end

def assess(task_dir)
  capture = load_doc(File.join(task_dir, "knowledge-capture-output.yaml"))
  return nil unless capture.is_a?(Hash)

  prov = capture["provenance"].is_a?(Hash) ? capture["provenance"] : {}
  declared = prov["freshness"] || "unknown"
  refs = Array(prov["evidence_refs"]).select { |r| r.is_a?(String) }
  marks = marks_for(task_dir)
  hits = refs.map { |ref| marks[ref] }.compact

  effective =
    if declared == EXEMPT
      EXEMPT
    else
      ([declared] + hits.map { |m| m["state"] })
        .select { |s| SEVERITY.key?(s) }
        .max_by { |s| SEVERITY[s] } || declared
    end

  {
    task_id: capture["task_id"] || File.basename(task_dir),
    target_note: capture["target_note"],
    declared: declared,
    effective: effective,
    marks: hits,
    degraded: effective != declared
  }
end

args = ARGV.dup
degraded_only = !args.delete("--degraded").nil?
if args.size > 1 || args.any? { |a| a.start_with?("--") }
  warn "Usage: knowledge-freshness.rb [TASK_ID] [--degraded]"
  exit 2
end

task_dirs =
  if (task_id = args.first)
    dir = File.join(RUNS_DIR, task_id)
    unless File.directory?(dir)
      warn "Run not found: #{dir}"
      exit 2
    end
    [dir]
  else
    Dir.glob(File.join(RUNS_DIR, "*")).select { |p| File.directory?(p) }.sort
  end

rows = task_dirs.map { |dir| assess(dir) }.compact
rows = rows.select { |r| r[:degraded] } if degraded_only

puts "# Knowledge Freshness — #{rows.size} capture output(s)#{degraded_only ? ' with degraded evidence' : ''}"
puts

if rows.empty?
  puts "Nothing to report."
  exit 0
end

rows.sort_by { |r| [-SEVERITY.fetch(r[:effective], 1), r[:task_id]] }.each do |r|
  flag = r[:degraded] ? "  <-- NEEDS REVALIDATION" : ""
  puts "#{r[:task_id]}  declared=#{r[:declared]}  effective=#{r[:effective]}#{flag}"
  puts "  note: #{r[:target_note]}" if r[:target_note]
  r[:marks].each do |m|
    puts "  evidence #{m['evidence_id']} marked #{m['state']} on #{m['marked_at']} by #{m['marked_by']}"
    puts "      #{m['reason']}"
  end
  puts
end

puts "Degraded knowledge stays in place and stays readable. Re-verify it, correct it,"
puts "or leave it — but do not present it as current, and do not delete it."
