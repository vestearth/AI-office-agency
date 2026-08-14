#!/usr/bin/env ruby
# frozen_string_literal: true

# Portable, lane-neutral runner for the knowledge-capture workflow
# (workflows/knowledge-capture.md). Any operator — Claude, Codex, Cursor, or a
# human — runs this to do the DETERMINISTIC parts of a post-task capture:
#
#   1. gather the run's inputs (status + role outputs + decision),
#   2. pre-extract candidate sources as repo-relative paths,
#   3. emit a schema-shaped skeleton (schemas/knowledge-capture-output.schema.json).
#
# It deliberately does NOT make the capture judgment, call any model/CLI (that
# would pick a lane), write to knowledge-base/, or commit. The operator reads the
# brief, applies the knowledge-capture skill's judgment, fills the skeleton, writes
# runs/<task>/knowledge-capture-output.yaml, then validates it. Capture stays
# suggest-only; a human applies the result to the vault.
#
# Usage:
#   ruby scripts/knowledge-capture.rb <TASK_ID>            # brief + skeleton + next steps (stdout)
#   ruby scripts/knowledge-capture.rb <TASK_ID> --skeleton # skeleton YAML only (pipe to a draft file)
#   ruby scripts/knowledge-capture.rb --validate <TASK_ID|path>  # delegate to validate-yaml.rb
# Exit: 0 ok; 2 usage error; 3 run missing/unreadable.

require "yaml"
require "date"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
REPO_ROOT = File.dirname(OFFICE_DIR)
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
VALIDATOR = File.join(OFFICE_DIR, "validate-yaml.rb")

CAPTURE_TYPES = %w[decision lesson concept flow project_note inbox].freeze
CAPTURE_ACTIONS = %w[create_note update_note add_to_inbox skip].freeze

def die_usage
  warn "Usage: knowledge-capture.rb <TASK_ID> [--skeleton] | --validate <TASK_ID|path>"
  exit 2
end

def load_yaml(path)
  return nil unless File.exist?(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
rescue Psych::SyntaxError => e
  warn "#{path}: malformed YAML (#{e.message})"
  exit 3
end

# Source Link Convention: prefer repo-relative paths. Role outputs often record
# absolute local paths, so fold them back to repo-relative when they sit under
# the workspace root.
def repo_relative(path)
  s = path.to_s
  prefix = "#{REPO_ROOT}/"
  s.start_with?(prefix) ? s[prefix.length..] : s
end

def truncate(str, max = 240)
  s = str.to_s.strip.tr("\n", " ").squeeze(" ")
  s.length > max ? "#{s[0, max]}…" : s
end

# --- arg parse ---------------------------------------------------------------

args = ARGV.dup
die_usage if args.empty?

if args[0] == "--validate"
  target = args[1]
  die_usage if target.nil? || target.strip.empty?
  # Delegate to the single source of truth for the contract shape.
  exec("ruby", VALIDATOR, target)
end

task_id = args.shift
skeleton_only = args.delete("--skeleton")
die_usage unless args.empty? && task_id && !task_id.strip.empty? && !task_id.start_with?("--")

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.directory?(task_dir) && File.exist?(status_path)
  warn "Run not found or missing status.yaml: #{task_dir}"
  exit 3
end

status = load_yaml(status_path) || {}

# Collect role outputs (skip our own capture artifact).
outputs = Dir.glob(File.join(task_dir, "*-output.yaml")).sort.reject do |p|
  File.basename(p) == "knowledge-capture-output.yaml"
end.map { |p| [File.basename(p), load_yaml(p)] }.to_h

decision = load_yaml(File.join(task_dir, "decision.yaml"))
pm = outputs["pm-output.yaml"]
title = pm.is_a?(Hash) && pm["task"].is_a?(Hash) ? pm["task"]["title"] : nil

# Candidate sources, repo-relative + deduped, in a stable order: the run
# artifacts that exist, then every artifact path the role outputs touched.
candidate_sources = []
%w[status.yaml].each { |f| candidate_sources << "#{repo_relative(task_dir)}/#{f}" }
outputs.each_key { |f| candidate_sources << "#{repo_relative(task_dir)}/#{f}" }
candidate_sources << "#{repo_relative(task_dir)}/decision.yaml" if decision
outputs.each_value do |doc|
  next unless doc.is_a?(Hash)
  Array(doc["artifacts"]).each do |a|
    candidate_sources << repo_relative(a["path"]) if a.is_a?(Hash) && a["path"]
  end
  diag = doc["diagnosis"]
  Array(diag["affected_files"]).each { |a| candidate_sources << repo_relative(a["path"]) if a.is_a?(Hash) && a["path"] } if diag.is_a?(Hash)
end
candidate_sources.uniq!

# --- provenance (issue #15) --------------------------------------------------
# Deterministic gather only. The identifiers are read verbatim from this task's
# own ledgers — evidence ids, the run they were recorded under, and the repo the
# commands actually ran against — and the field names are the vault's, so the
# block promotes into a note's YAML frontmatter with no transformation.
# `freshness` is NOT guessed: it starts at `unknown`, and only an actual
# re-check earns anything better. `repo_sha` is provenance, not liveness —
# nothing here compares it against a current HEAD.
evidence_ledger = load_yaml(File.join(task_dir, "evidence.yaml"))
evidence_records = evidence_ledger.is_a?(Hash) ? Array(evidence_ledger["evidence"]).select { |e| e.is_a?(Hash) } : []
evidence_ids = evidence_records.map { |e| e["id"] }.compact
# Prefer a passing record for repo identity: a green check is what a durable
# claim normally rests on. Fall back to the last record so provenance is never
# silently empty when everything failed.
provenance_source = evidence_records.reverse.find { |e| e["exit_code"] == 0 } || evidence_records.last
capture_run_id = provenance_source && provenance_source["run_id"]
capture_repo_origin = provenance_source && provenance_source["repo_origin"]
capture_repo_sha = provenance_source && provenance_source["repo_sha"]

freshness_doc = load_yaml(File.join(task_dir, "evidence-freshness.yaml"))
freshness_marks = freshness_doc.is_a?(Hash) ? Array(freshness_doc["marks"]).select { |m| m.is_a?(Hash) } : []

def yaml_scalar(value)
  value.nil? ? "null" : "\"#{value}\""
end

def provenance_yaml(task_id, evidence_ids, run_id, repo_origin, repo_sha)
  refs = evidence_ids.empty? ? "[]" : "[#{evidence_ids.join(', ')}]"
  [
    "provenance:          # OPTIONAL, promotes verbatim into the note's frontmatter",
    "  freshness: unknown # current / unknown / maybe_stale / stale / invalid / historical",
    "                     # only an ACTUAL re-check earns `current` — writing the note does not",
    "  task_id: #{task_id}",
    "  run_id: #{yaml_scalar(run_id)}",
    "  evidence_refs: #{refs}",
    "  repo_origin: #{yaml_scalar(repo_origin)}",
    # "unknown" is the contracted value for "outside a git repo / not recorded";
    # it is provenance, not liveness — nothing compares it against a HEAD.
    "  repo_sha: \"#{repo_sha || 'unknown'}\"",
    "  # verified_at: YYYY-MM-DD      # the day you re-checked the claim; omit if nobody did",
    "  # confidence: high|medium|low  # only with verified_at + run_id/evidence_refs"
  ].join("\n")
end

# The same block, rendered as the frontmatter the promoted note carries, so
# provenance survives promotion into knowledge-base without transformation.
def frontmatter_yaml(task_id, evidence_ids, run_id, repo_origin, repo_sha)
  lines = ["---", "freshness: unknown", "task_id: #{task_id}"]
  lines << "run_id: #{run_id}" if run_id
  lines << "evidence_refs: [#{evidence_ids.join(', ')}]" unless evidence_ids.empty?
  lines << "repo_origin: #{repo_origin}" if repo_origin
  lines << "repo_sha: #{repo_sha}" if repo_sha
  lines << "---"
  lines
end

def skeleton_yaml(task_id, candidate_sources, evidence_ids = [], run_id = nil, repo_origin = nil, repo_sha = nil)
  src = candidate_sources.empty? ? "  - \"\"" : candidate_sources.map { |s| "  - \"#{s}\"" }.join("\n")
  fm = frontmatter_yaml(task_id, evidence_ids, run_id, repo_origin, repo_sha).map { |l| "  #{l}" }.join("\n")
  <<~YAML
    task_id: #{task_id}
    capture_type:        # one of: #{CAPTURE_TYPES.join(' / ')}   (TODO)
    target_repo: knowledge-base
    target_note: ""      # Knowledge Base/<area>/<slug>.md — SEARCH THE VAULT FIRST; prefer update over new  (TODO)
    summary: ""          # one line: the reusable point, not "what the task did"  (TODO)
    sources:             # repo-relative, >=1 real source; keep only the ones the claim actually rests on
    #{src}
    recommended_action:  # one of: #{CAPTURE_ACTIONS.join(' / ')}   (TODO)
    requires_human_review: true
    #{provenance_yaml(task_id, evidence_ids, run_id, repo_origin, repo_sha)}
    note_patch: |        # the note (or change), with Related links + a Source:/Sources: section  (TODO)
    #{fm}

      # TODO
  YAML
end

if skeleton_only
  puts skeleton_yaml(task_id, candidate_sources, evidence_ids, capture_run_id, capture_repo_origin, capture_repo_sha)
  exit 0
end

# --- brief (stdout) ----------------------------------------------------------

out = []
out << "# Knowledge Capture Brief — #{task_id}"
out << ""
out << "Task: #{title || '(no pm title)'}"
out << "Phase: #{status['phase'] || '?'}  |  Assignment: #{status.dig('assignment', 'primary') || '?'}"
out << ""

history = status["history"]
if history.is_a?(Array) && !history.empty?
  out << "## Transitions"
  history.each { |h| out << "- #{h['phase']}  (#{h['agent']}) — #{truncate(h['reason'], 160)}" if h.is_a?(Hash) }
  out << ""
end

unless outputs.empty?
  out << "## Role outputs"
  outputs.each do |name, doc|
    next unless doc.is_a?(Hash)
    out << "### #{name}"
    out << "- summary: #{truncate(doc['summary'])}" if doc["summary"]
    if (diag = doc["diagnosis"]).is_a?(Hash)
      out << "- root_cause: #{truncate(diag['root_cause'])}"
      out << "- confidence: #{diag['confidence']}"
    end
    out << "- review_verdict: #{doc['review_verdict']}" if doc["review_verdict"]
    if (na = doc["next_action"]).is_a?(Hash) && na["reason"]
      out << "- next_action: #{na['agent']} — #{truncate(na['reason'], 160)}"
    end
    out << ""
  end
end

if decision.is_a?(Hash) && decision["decisions"].is_a?(Array) && !decision["decisions"].empty?
  d = decision["decisions"].last
  out << "## Human decision"
  out << "- #{d['decision']} by #{d['actor']} (#{d['decided_at']})" if d.is_a?(Hash)
  out << ""
end

out << "## Candidate sources (repo-relative — keep only what the claim rests on)"
candidate_sources.each { |s| out << "- #{s}" }
out << ""

out << "## Provenance available from this run"
out << "- run_id: #{capture_run_id || '(none recorded)'}"
out << "- evidence_refs: #{evidence_ids.empty? ? '(no evidence.yaml entries)' : evidence_ids.join(', ')}"
out << "- repo_origin: #{capture_repo_origin || '(none)'}  |  repo_sha: #{capture_repo_sha || '(none)'}"
out << "freshness starts at `unknown`. Only an actual re-check of the claim earns `current`,"
out << "and the day of that check goes in `verified_at`. Writing the note is not a check."
out << ""

unless freshness_marks.empty?
  out << "## ⚠ Evidence marked in evidence-freshness.yaml — DO NOT declare `current`"
  freshness_marks.each do |m|
    out << "- #{m['evidence_id']} → #{m['state']} (#{m['marked_at']}, #{m['marked_by']}): #{truncate(m['reason'], 160)}"
  end
  out << "Cite this evidence and the capture must declare maybe_stale (or stale/invalid) until"
  out << "someone re-checks the claim. The capture is still worth writing — it stays discoverable."
  out << ""
end
out << "## Now you (operator) decide — suggest-only"
out << "Apply the knowledge-capture skill: ai-skills/skills/knowledge-capture/SKILL.md"
out << "Capture Gate: knowledge-base/Knowledge Base/Promotion Rule.md  |  Targets: knowledge-base/AGENTS.md"
out << "Rules: search the vault first (prefer update); cite real sources; never write knowledge-base/ or commit;"
out << "requires_human_review stays true; a human applies the result."
out << ""
out << "## Skeleton (fill judgment fields, then write to runs/#{task_id}/knowledge-capture-output.yaml)"
out << skeleton_yaml(task_id, candidate_sources, evidence_ids, capture_run_id, capture_repo_origin, capture_repo_sha)
out << "Validate: ruby ai-dev-office/scripts/knowledge-capture.rb --validate #{task_id}"
out << "Freshness report: ruby ai-dev-office/scripts/knowledge-freshness.rb #{task_id}"

puts out.join("\n")
