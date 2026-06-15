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

checks = [
  ["status.phase",          named(src, "PHASES"), schema_enum("schemas/status.schema.yaml", "properties", "phase", "enum")],
  ["status.state",          named(src, "PHASES"), schema_enum("schemas/status.schema.yaml", "properties", "state", "enum")],
  ["status.current_agent",  named(src, "AGENTS"), ca],
  ["task.workstream",      named(src, "WORKSTREAMS"), schema_enum("schemas/task.schema.yaml", "properties", "task", "properties", "workstream", "enum")],
  ["reviewer.review_verdict", inline(src, 'data\["review_verdict"\]'), schema_enum("schemas/reviewer-output.schema.yaml", "properties", "review_verdict", "enum")],
  ["reviewer.from_phase",   inline(src, 'data\["transition"\]\["from_phase"\]'), schema_enum("schemas/reviewer-output.schema.yaml", "properties", "transition", "properties", "from_phase", "enum")],
]

failed = false
checks.each do |label, validator_enum, schema_enum|
  if validator_enum == schema_enum
    puts "  ok: #{label} (#{validator_enum.size} values agree)"
  else
    failed = true
    puts "[FAIL] #{label} DRIFT between validate-yaml.rb and the schema:"
    puts "    validator: #{validator_enum.inspect}"
    puts "    schema:    #{schema_enum.inspect}"
  end
end
abort "[FAIL] schema/validator drift detected" if failed
puts "[PASS] schema-validator-parity: validator and schemas agree on all checked enums"
RUBY
