#!/usr/bin/env bash
# S7(b): the schemas under schemas/ are NOT loaded at runtime — validate-yaml.rb
# hardcodes the rules. This test pins the two together on the enums most likely
# to drift, so a schema edit the validator doesn't mirror (or vice versa) fails
# CI instead of silently diverging. (The full json_schemer migration is S7(a).)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ruby - <<'RUBY'
# encoding: utf-8
require "yaml"
# validate-yaml.rb contains UTF-8 (em-dashes in comments); read it as UTF-8 so
# the regex scans below don't raise "invalid byte sequence in US-ASCII" when the
# process runs under a US-ASCII default external encoding (e.g. LANG unset).
src = File.read("validate-yaml.rb", encoding: "UTF-8")
# The run-record WRITER hardcodes the same enums (it cannot require the
# validator — that file runs a CLI at load). Scrape it as a third party to the
# comparison so the writer can never emit a record the validator would reject.
writer = File.read("scripts/record-run.rb", encoding: "UTF-8")

def named(src, name)
  m = src.match(/^#{name}\s*=\s*%w\[([^\]]*)\]/m) or abort "validator: const #{name} not found"
  m[1].split.sort
end

def inline(src, anchor)
  m = src.match(/#{anchor},\s*%w\[([^\]]*)\]/m) or abort "validator: inline enum for #{anchor} not found"
  m[1].split.sort
end

def schema_enum(path, *keys)
  node = YAML.load_file(path)
  keys.each { |k| node = node.fetch(k) { abort "schema #{path}: missing #{keys.inspect}" } }
  node.sort
end

# current_agent in status.schema is anyOf [null, {string, enum}].
ca = YAML.load_file("schemas/status.schema.yaml")["properties"]["current_agent"]["anyOf"]
            .map { |x| x["enum"] }.compact.first.sort

# ev-id grammar: the validator regex and the schema patterns are written in
# different dialects, so compare them by behavior over a fixed sample set.
def pattern_at(path, *keys)
  node = YAML.load_file(path)
  keys.each { |k| node = node.fetch(k) { abort "schema #{path}: missing #{keys.inspect}" } }
  node
end

ev_re = Regexp.new(src.match(/^EVIDENCE_ID_PATTERN\s*=\s*\/(.+?)\/\.freeze/)[1])
ev_samples = %w[ev-001 ev-0001 ev-01 ev-1 ev- ev-abc EV-001 ev-001x]
ev_validator = ev_samples.map { |s| ev_re.match?(s) }

origin_re = Regexp.new(src.match(/^REPO_ORIGIN_PATTERN\s*=\s*%r\{(.+?)\}\.freeze/)[1])
origin_samples = ["SparqLab/missions", "group/sub/repo", "missions", "", "owner/", "/repo", "owner /repo"]
origin_validator = origin_samples.map { |s| origin_re.match?(s) }

checks = [
  ["evidence.type", named(src, "EVIDENCE_TYPES"),
   schema_enum("schemas/evidence.schema.yaml", "properties", "evidence", "items", "properties", "type", "enum")],
  ["evidence.id grammar (evidence.schema)", ev_validator,
   ev_samples.map { |s| Regexp.new(pattern_at("schemas/evidence.schema.yaml", "properties", "evidence", "items", "properties", "id", "pattern")).match?(s) }],
  ["evidence.repo_origin grammar", origin_validator,
   origin_samples.map { |s| Regexp.new(pattern_at("schemas/evidence.schema.yaml", "properties", "evidence", "items", "properties", "repo_origin", "pattern")).match?(s) }],
  ["evidence_refs grammar (agent-output.schema)", ev_validator,
   ev_samples.map { |s| Regexp.new(pattern_at("schemas/agent-output.schema.yaml", "properties", "evidence_refs", "items", "pattern")).match?(s) }],
  ["status.phase",          named(src, "PHASES"), schema_enum("schemas/status.schema.yaml", "properties", "phase", "enum")],
  ["status.state",          named(src, "PHASES"), schema_enum("schemas/status.schema.yaml", "properties", "state", "enum")],
  ["status.current_agent",  named(src, "AGENTS"), ca],
  ["task.workstream",      named(src, "WORKSTREAMS"), schema_enum("schemas/task.schema.yaml", "properties", "task", "properties", "workstream", "enum")],
  ["reviewer.review_verdict", inline(src, 'data\["review_verdict"\]'), schema_enum("schemas/reviewer-output.schema.yaml", "properties", "review_verdict", "enum")],
  ["reviewer.from_phase",   inline(src, 'data\["transition"\]\["from_phase"\]'), schema_enum("schemas/reviewer-output.schema.yaml", "properties", "transition", "properties", "from_phase", "enum")],
  ["run-record.role",              named(src, "RUN_ROLES"), schema_enum("schemas/run-record.schema.yaml", "properties", "role", "enum")],
  ["run-record.outcome.status",    named(src, "RUN_OUTCOME_STATUSES"), schema_enum("schemas/run-record.schema.yaml", "properties", "outcome", "properties", "status", "enum")],
  ["run-record.outcome.validation", named(src, "RUN_VALIDATION_RESULTS"),
   YAML.load_file("schemas/run-record.schema.yaml")["properties"]["outcome"]["properties"]["validation"]["oneOf"]
       .map { |x| x["enum"] }.compact.first.sort],
  ["run-record.usage keys",        named(src, "RUN_USAGE_KEYS"),
   YAML.load_file("schemas/run-record.schema.yaml")["properties"]["usage"]["properties"].keys.sort],
]

# Writer vs validator: same constant names, so a rename or an added value on
# either side fails here instead of at runtime.
%w[RUN_ROLES RUN_OUTCOME_STATUSES RUN_VALIDATION_RESULTS RUN_USAGE_KEYS].each do |const|
  checks << ["record-run.rb #{const}", named(src, const), named(writer, const)]
end

failed = false
checks.each do |label, validator_enum, schema_enum|
  if validator_enum == schema_enum
    puts "  ok: #{label} (#{validator_enum.size} values agree)"
  else
    failed = true
    puts "[FAIL] #{label} DRIFT from validate-yaml.rb:"
    puts "    validate-yaml.rb: #{validator_enum.inspect}"
    puts "    counterpart:      #{schema_enum.inspect}"
  end
end
abort "[FAIL] schema/validator drift detected" if failed
puts "[PASS] schema-validator-parity: validator and schemas agree on all checked enums"
RUBY
