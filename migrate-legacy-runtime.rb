#!/usr/bin/env ruby
require "yaml"

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
rescue Psych::SyntaxError => e
  warn "#{path}: YAML syntax error: #{e.message}"
  exit 1
end

def dump_yaml(data)
  YAML.dump(data).sub(/\A---\s*\n/, "")
end

def normalize_legacy_reviewer(data)
  return nil unless data.is_a?(Hash)
  return nil unless data.key?("review_verdict") && data.key?("checks") && !data.key?("build_check")

  details = []
  details << "Legacy checks:" if data["checks"].is_a?(Array) && !data["checks"].empty?
  Array(data["checks"]).each { |entry| details << "- #{entry}" }
  if data["notes"].is_a?(String) && !data["notes"].strip.empty?
    details << ""
    details << "Legacy notes:"
    details << data["notes"].rstrip
  end

  {
    "summary" => data["summary"] || "Migrated legacy reviewer output.",
    "review_verdict" => data["review_verdict"],
    "build_check" => {
      "compile" => "skipped",
      "tests" => "skipped",
      "details" => details.join("\n").strip.empty? ? "Legacy reviewer output did not include structured build or test results." : details.join("\n")
    },
    "artifacts" => [],
    "next_action" => data["next_action"] || { "agent" => "done", "reason" => "Migrated from legacy reviewer output." },
    "blockers" => data["blockers"] || []
  }
end

def migrate_file(path, write: false)
  data = load_yaml(path)
  normalized = normalize_legacy_reviewer(data)

  if normalized.nil?
    puts "No supported legacy migration for: #{path}"
    return 0
  end

  output = dump_yaml(normalized)
  if write
    File.write(path, output)
    puts "Migrated in place: #{path}"
  else
    puts output
  end
  0
end

target = ARGV[0]
write = ARGV.include?("--write")

if target.nil? || target.strip.empty?
  warn "Usage: ruby ai-dev-office/migrate-legacy-runtime.rb <path-to-yaml> [--write]"
  exit 1
end

path = File.expand_path(target)
unless File.file?(path)
  warn "File not found: #{target}"
  exit 1
end

exit migrate_file(path, write: write)
