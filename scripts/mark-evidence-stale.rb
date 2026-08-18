#!/usr/bin/env ruby
# frozen_string_literal: true

# Mark a recorded piece of evidence as no longer describing the world it was
# recorded against (issue #15).
#
# This is THE deterministic staleness trigger. Evidence is stale if and only if
# this script has appended a mark naming it in
# runs/<TASK_ID>/evidence-freshness.yaml. Nothing else moves evidence out of the
# unmarked default: there is no clock, no background scan, and no comparison of
# `repo_sha` against a current HEAD — `repo_sha` stays provenance, not liveness
# (docs/evidence-contract.md), and EVIDENCE_STRICT_SHA=1 remains the only opt-in
# sha check in this repo.
#
# When to invoke it (the human judgment, which is NOT automated):
# something the evidence rests on provably moved — a migration merged, a
# contract or proto field changed, a service redeployed, a config flag flipped,
# a cited source file rewritten. That makes the claim POTENTIALLY wrong, not
# wrong, so `maybe_stale` is the default and the conservative choice. Reserve
# `stale` for a re-check that showed the behaviour actually changed, and
# `invalid` for evidence that was wrong when it was recorded.
#
# The ledger is APPEND-ONLY and additive. It never edits or deletes an evidence
# record, never touches a log, never rewrites a knowledge-capture output, and
# never writes to knowledge-base/. Marking is a suggestion to re-verify; a human
# still decides what the affected knowledge should say.
#
# Usage:
#   scripts/mark-evidence-stale.rb <TASK_ID> <ev-id> --reason "..." \
#       [--state maybe_stale|stale|invalid] [--by NAME]
#   scripts/mark-evidence-stale.rb <TASK_ID> --list
# Exit: 0 ok; 2 usage/config error; 3 task or evidence not found.
#
# Docs: docs/knowledge-provenance.md  Schema: schemas/evidence-freshness.schema.yaml

require "yaml"
require "date"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
MARK_STATES = %w[maybe_stale stale invalid].freeze
EVIDENCE_ID_PATTERN = /\Aev-\d{3,}\z/.freeze

def die(msg, code = 2)
  warn "mark-evidence-stale: #{msg}"
  exit code
end

def usage
  die "usage: mark-evidence-stale.rb <TASK_ID> <ev-id> --reason \"...\" " \
      "[--state #{MARK_STATES.join('|')}] [--by NAME]  |  <TASK_ID> --list"
end

def load_doc(path)
  return nil unless File.exist?(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
rescue Psych::SyntaxError => e
  die "#{path}: malformed YAML (#{e.message})", 3
end

args = ARGV.dup
usage if args.empty?

task_id = args.shift
usage if task_id.nil? || task_id.strip.empty? || task_id.start_with?("--")

task_dir = File.join(RUNS_DIR, task_id)
die("task dir not found: #{task_dir}", 3) unless File.directory?(task_dir)

ledger_path = File.join(task_dir, "evidence-freshness.yaml")

if args == ["--list"]
  doc = load_doc(ledger_path)
  marks = doc.is_a?(Hash) ? Array(doc["marks"]) : []
  if marks.empty?
    puts "#{task_id}: no evidence marked (all recorded evidence stands as recorded)"
  else
    puts "#{task_id}: #{marks.size} mark(s) — last write wins per evidence id"
    marks.each do |m|
      next unless m.is_a?(Hash)
      puts "  #{m['evidence_id']}  #{m['state']}  #{m['marked_at']}  by #{m['marked_by']}"
      puts "      #{m['reason']}"
    end
  end
  exit 0
end

evidence_id = args.shift
usage if evidence_id.nil? || evidence_id.start_with?("--")
die("evidence id must match ev-NNN (e.g. ev-001), got '#{evidence_id}'") unless evidence_id.match?(EVIDENCE_ID_PATTERN)

state = "maybe_stale"
reason = nil
marked_by = ENV["AI_DEV_OFFICE_OPERATOR"] || ENV["USER"] || "unknown"

until args.empty?
  case (flag = args.shift)
  when "--state" then state = args.shift or die("--state needs a value")
  when /\A--state=/ then state = flag.split("=", 2)[1]
  when "--reason" then reason = args.shift or die("--reason needs a value")
  when /\A--reason=/ then reason = flag.split("=", 2)[1]
  when "--by" then marked_by = args.shift or die("--by needs a value")
  when /\A--by=/ then marked_by = flag.split("=", 2)[1]
  else die("unexpected argument '#{flag}'")
  end
end

die("unknown --state '#{state}' (one of: #{MARK_STATES.join(', ')}). There is no 'current' mark: " \
    "a re-verification produces a NEW evidence record, it does not rewrite an old one.") unless MARK_STATES.include?(state)
die("--reason is required (a mark with no reason is not reviewable)") if reason.nil? || reason.to_s.strip.empty?

# ev-NNN ids are TASK-SCOPED, so the id is only meaningful against this task's
# ledger — resolve it here rather than letting a typo create a dangling mark.
ledger = load_doc(File.join(task_dir, "evidence.yaml"))
known = (ledger.is_a?(Hash) ? Array(ledger["evidence"]) : []).map { |e| e["id"] if e.is_a?(Hash) }.compact
die("#{evidence_id} is not in #{task_id}'s evidence.yaml (evidence ids are task-scoped)", 3) unless known.include?(evidence_id)

marked_at = Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
run_id = nil if run_id.empty?

# Same per-task advisory flock the driver and record-evidence.sh use: the append
# must be one critical section or parallel lanes lose a mark.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)

doc = load_doc(ledger_path) || {}
doc["task_id"] ||= task_id
doc["marks"] = [] unless doc["marks"].is_a?(Array)
doc["marks"] << {
  "evidence_id" => evidence_id,
  "state" => state,
  "marked_at" => marked_at,
  "marked_by" => marked_by,
  "reason" => reason,
  "run_id" => run_id
}
doc["updated_at"] = marked_at

tmp_path = "#{ledger_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(doc))
  File.rename(tmp_path, ledger_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

puts "#{task_id} #{evidence_id} -> #{state}"
puts "Knowledge citing it is now surfaced by: ruby scripts/knowledge-freshness.rb #{task_id}"
puts "Nothing was deleted. A human decides what the affected notes should say."
