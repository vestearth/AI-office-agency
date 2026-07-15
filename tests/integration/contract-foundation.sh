#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

PORTABLE_FILES=(
  AGENTS.md
  SKILL.md
  README.md
  office.config.example.yaml
  templates/install-manifest.yaml
  docs/config-profile-merge-contract.md
  docs/getting-started.md
  docs/codex.md
  docs/cursor.md
  docs/claude.md
  docs/gemini.md
  docs/cursor-templates.md
  docs/socraticode.md
  scripts/validate-knowledge-librarian.rb
  templates/project-AGENTS.md
  templates/project-office.config.yaml
)

FORBIDDEN_PATTERNS=(
  '/Users/earth'
  'd:\\llm'
  'Games-Labs-'
  'github.com/SparqLab/shared-lib'
  'handler message'
)

GITIGNORE_REQUIRED=(
  'office.config.local.yaml'
  'profiles/*.local.yaml'
  '.env'
  '.socraticode.local.yaml'
  'runs/*'
  'knowledge-reviews/'
)

assert_file() {
  local path="$1"
  local message="$2"
  if [[ ! -f "$path" ]]; then
    echo "[FAIL] $message: missing file $path"
    exit 1
  fi
}

assert_contains() {
  local path="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq -- "$expected" "$path"; then
    echo "[FAIL] $message: expected '$expected' in $path"
    exit 1
  fi
}

assert_not_contains() {
  local path="$1"
  local forbidden="$2"
  local message="$3"
  if grep -Fq -- "$forbidden" "$path"; then
    echo "[FAIL] $message: forbidden pattern '$forbidden' found in $path"
    exit 1
  fi
}

echo "== Scenario 1: required framework contract files exist =="
for rel in "${PORTABLE_FILES[@]}"; do
  assert_file "$ROOT_DIR/$rel" "framework contract file"
done

echo "== Scenario 2: portable contract files avoid machine/project-specific assumptions =="
for rel in "${PORTABLE_FILES[@]}"; do
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    assert_not_contains "$ROOT_DIR/$rel" "$pattern" "portable contract scan ($rel)"
  done
done

echo "== Scenario 3: SKILL references in-repo AGENTS.md =="
assert_contains "$ROOT_DIR/SKILL.md" 'AGENTS.md' "SKILL should reference AGENTS.md"
assert_not_contains "$ROOT_DIR/SKILL.md" '../AGENTS.md' "SKILL must not depend on parent AGENTS.md"

echo "== Scenario 4: .gitignore excludes local config =="
for pattern in "${GITIGNORE_REQUIRED[@]}"; do
  assert_contains "$ROOT_DIR/.gitignore" "$pattern" ".gitignore local config coverage"
done

echo "== Scenario 5: install manifest defines install and exclude boundaries =="
ruby - "$ROOT_DIR/templates/install-manifest.yaml" <<'RUBY'
require "yaml"

path = ARGV[0]
data = YAML.safe_load(File.read(path), aliases: true) || {}

core = Array(data.dig("installable", "core")).map(&:to_s)
optional = Array(data.dig("installable", "optional")).map(&:to_s)
runtime_excludes = Array(data.dig("exclude", "runtime")).map(&:to_s)
local_excludes = Array(data.dig("exclude", "local")).map(&:to_s)

required_core = %w[
  AGENTS.md
  README.md
  SKILL.md
  office.config.example.yaml
  agents/**
  runners/**
  workflows/**
  schemas/**
  scripts/validate-knowledge-librarian.rb
  docs/config-profile-merge-contract.md
  docs/getting-started.md
  docs/codex.md
  docs/cursor.md
  docs/claude.md
  docs/gemini.md
  docs/cursor-templates.md
  docs/socraticode.md
]

required_core.each do |entry|
  abort "[FAIL] install manifest missing core entry: #{entry}" unless core.include?(entry)
end

generic_docs = %w[
  docs/getting-started.md
  docs/codex.md
  docs/cursor.md
  docs/claude.md
  docs/gemini.md
  docs/cursor-templates.md
  docs/socraticode.md
  docs/config-profile-merge-contract.md
]

generic_docs.each do |entry|
  abort "[FAIL] install manifest should not list core doc as optional: #{entry}" if optional.include?(entry)
end

%w[runs/** knowledge-reviews/** **/*-output.yaml **/*.log].each do |entry|
  abort "[FAIL] install manifest missing runtime exclude: #{entry}" unless runtime_excludes.include?(entry)
end

%w[office.config.local.yaml profiles/*.local.yaml .env].each do |entry|
  abort "[FAIL] install manifest missing local exclude: #{entry}" unless local_excludes.include?(entry)
end

abort "[FAIL] install manifest should keep profiles optional" unless optional.any? { |entry| entry.include?("profiles") }
abort "[FAIL] install manifest should keep templates optional" unless optional.any? { |entry| entry.include?("templates") }

puts "[OK] install manifest contract boundaries verified"
RUBY

echo "== Scenario 6: merge contract documents protected fields =="
for field in \
  'office.version' \
  'state_model.source_of_truth' \
  'handoff_contract.state_files' \
  'agents[].id' \
  'runner_selector.config_dir'
do
  assert_contains "$ROOT_DIR/docs/config-profile-merge-contract.md" "$field" "protected field documentation"
done

echo "== Scenario 7: example config uses env placeholders, not hardcoded paths =="
assert_contains "$ROOT_DIR/office.config.example.yaml" '${SOCRATICODE_PRIMARY_PROJECT}' "example config primary project placeholder"
assert_contains "$ROOT_DIR/office.config.example.yaml" '${SOCRATICODE_FALLBACK_PROJECT}' "example config fallback project placeholder"
assert_not_contains "$ROOT_DIR/office.config.example.yaml" '/Users/' "example config must not hardcode user paths"
ruby - "$ROOT_DIR/office.config.example.yaml" <<'RUBY'
require "yaml"

path = ARGV[0]
data = YAML.safe_load(File.read(path), aliases: true) || {}

enabled = data.dig("dependency_guard", "enabled")
abort "[FAIL] example config should default dependency_guard.enabled to false" unless enabled == false

abort "[FAIL] example config must define handoff_contract.state_files" unless data.dig("handoff_contract", "state_files").is_a?(Hash)
abort "[FAIL] example config must define state_model.source_of_truth" unless data.dig("state_model", "source_of_truth") == "status.yaml"

agent_ids = Array(data["agents"]).map { |entry| entry["id"].to_s }
required = %w[pm dev dev-2 reviewer debugger devops free-roam]
missing = required - agent_ids
abort "[FAIL] example config missing agent ids: #{missing.join(', ')}" unless missing.empty?

puts "[OK] example config portable defaults verified"
RUBY

echo "== Scenario 8: generic doc links referenced from README exist =="
for rel in \
  docs/getting-started.md \
  docs/codex.md \
  docs/cursor.md \
  docs/claude.md \
  docs/gemini.md \
  docs/cursor-templates.md \
  docs/socraticode.md \
  profiles/README.md \
  profiles/games-labs.md
do
  assert_file "$ROOT_DIR/$rel" "README-linked doc"
done

assert_not_contains "$ROOT_DIR/README.md" 'handler message' "generic README must not contain shared-lib handler policy"

echo "== Scenario 9: workflow loop guard references config as source of truth =="
ruby - "$ROOT_DIR/workflows/hybrid-default.yaml" <<'RUBY'
require "yaml"

path = ARGV[0]
data = YAML.safe_load(File.read(path), aliases: true) || {}
loop_detection = data.dig("escalation_rules", "loop_detection") || {}

max_iterations = loop_detection["max_iterations"]
abort "[FAIL] workflow loop guard should not hardcode max_iterations" if max_iterations.is_a?(Numeric)
abort "[FAIL] workflow loop guard should reference office.config.yaml -> loop_guard.max_iterations" unless max_iterations == "office.config.yaml -> loop_guard.max_iterations"

puts "[OK] workflow loop guard references config"
RUBY

echo "== Scenario 10: runs/ team-sync allowlist is enforced =="
ruby - "$ROOT_DIR" <<'RUBY'
root = ARGV[0]
tracked = Dir.chdir(root) { `git ls-files runs`.lines.map(&:strip).reject(&:empty?) }

allowed_patterns = [
  %r{\Aruns/\.gitkeep\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/task\.md\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/status\.yaml\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/[a-z0-9-]+-output\.yaml\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/decision\.yaml\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/verification-evidence\.md\z},
  %r{\Aruns/TASK(?:-[A-Z][A-Z0-9]*)?-\d+/findings\.md\z}
]

disallowed_patterns = [
  %r{\.log\z},
  %r{/\.cursor-prompt\.md\z},
  %r{/meta\.yaml\z},
  %r{status\.yaml\.corrupt}
]

unexpected = tracked.reject { |path| allowed_patterns.any? { |pattern| path.match?(pattern) } }
abort "[FAIL] tracked runs files outside allowlist: #{unexpected.join(', ')}" unless unexpected.empty?

blocked = tracked.select { |path| disallowed_patterns.any? { |pattern| path.match?(pattern) } }
abort "[FAIL] disallowed runs files are tracked: #{blocked.join(', ')}" unless blocked.empty?

puts "[OK] runs/ allowlist enforced (#{tracked.size} tracked path(s))"
RUBY

echo "== Scenario 11: legacy v1 agent docs are moved out of active agents/ =="
for rel in \
  agents/planner.md \
  agents/tester.md
do
  if [[ -f "$ROOT_DIR/$rel" ]]; then
    echo "[FAIL] legacy agent should not remain in active agents/: $rel"
    exit 1
  fi
done

for rel in \
  docs/legacy-v1/planner.md \
  docs/legacy-v1/tester.md \
  docs/legacy-v1/README.md
do
  assert_file "$ROOT_DIR/$rel" "legacy docs archive"
done

echo "[PASS] framework contract foundation scenarios passed"
