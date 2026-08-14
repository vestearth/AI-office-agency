#!/usr/bin/env ruby
# frozen_string_literal: true

# Run identity: one canonical record per agent execution.
#
# A "run" is a single dispatch of a role to a runner. The record is the stable
# anchor everything else hangs off: meta.yaml events carry the run_id, and
# execution evidence will carry it too once the evidence contract lands.
#
# Storage: runs/<task-id>/run-records/<run_id>.yaml — one file per run.
# A run is append-only history, not mutable task state, so it does NOT belong in
# status.yaml; and folding it into meta.yaml would rewrite the whole event log
# on every field update (start, finish, validation), widening exactly the
# read-modify-write window tests/integration/concurrent-status-writes.sh pins.
# One file per run means two parallel lanes never write the same file, while
# id allocation still takes the task's `.lock` so a collision is impossible
# rather than merely improbable. See docs/run-records.md.
#
# Usage:
#   ruby scripts/record-run.rb start  <task-dir> <task-id> <role> [k=v ...] < instruction
#   ruby scripts/record-run.rb update <task-dir> <run-id>  [k=v ...]
#   ruby scripts/record-run.rb finish <task-dir> <run-id>  [k=v ...]
#
# `start` prints the allocated run id on stdout and hashes the instruction text
# read from stdin into instruction_sha (absent stdin -> null).
# `finish` is `update` plus completed_at.
#
# Exit: 0 on success; 2 on usage error; 3 on a store error.

require "yaml"
require "date"
require "digest"
require "securerandom"

RECORDS_DIRNAME = "run-records"
# Roles that can be dispatched. `done` is a terminal marker, never an executor.
RUN_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
RUN_OUTCOME_STATUSES = %w[running completed failed].freeze
RUN_VALIDATION_RESULTS = %w[passed failed].freeze
# Identity fields the harness always emits, nullable when it cannot observe them
# (a guessed model or profile is worse than an honest null).
IDENTITY_KEYS = %w[
  client model_requested model_observed harness_version skill_version
  instruction_sha repo_sha mcp_profile
].freeze
USAGE_KEYS = %w[input_tokens output_tokens cache_read cache_write tool_calls validation_rounds].freeze
NONCE_ALPHABET = ("0".."9").to_a + ("a".."z").to_a

def die(message, code = 2)
  warn message
  exit code
end

def now_iso
  Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
end

# Same advisory lock the meta.yaml writer uses, so id allocation serializes
# against every other writer in the task dir.
def with_task_lock(task_dir)
  lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)
  yield
ensure
  lock&.close
end

def write_atomic(path, data)
  tmp = "#{path}.tmp.#{$$}"
  File.write(tmp, YAML.dump(data))
  File.rename(tmp, path)
rescue StandardError
  File.delete(tmp) if tmp && File.exist?(tmp)
  raise
end

# run-<UTC basic timestamp>-<task-id>-<role>-<nonce>. Time first so a plain
# lexicographic sort is chronological; task/role inline so a record is
# self-identifying out of context; nonce to separate retries of the same role
# within the same second.
def build_run_id(task_id, role)
  "run-#{Time.now.utc.strftime('%Y%m%dT%H%M%SZ')}-#{task_id}-#{role}-#{Array.new(6) { NONCE_ALPHABET.sample }.join}"
end

def parse_pairs(args)
  args.each_with_object({}) do |arg, memo|
    key, value = arg.split("=", 2)
    die "Bad key=value argument: #{arg}" if value.nil? || key.to_s.strip.empty?
    memo[key] = value
  end
end

# "" means "not observable" -> null. Integers are only coerced for usage.*.
def apply_pairs(record, pairs)
  pairs.each do |key, raw|
    value = raw.strip.empty? ? nil : raw
    case key
    when *IDENTITY_KEYS
      record[key] = value
    when "outcome.status"
      die "outcome.status must be one of: #{RUN_OUTCOME_STATUSES.join(', ')}" unless RUN_OUTCOME_STATUSES.include?(value)
      record["outcome"]["status"] = value
    when "outcome.exit_code"
      die "outcome.exit_code must be an integer" unless value.nil? || value.match?(/\A-?\d+\z/)
      record["outcome"]["exit_code"] = value&.to_i
    when "outcome.validation"
      unless value.nil? || RUN_VALIDATION_RESULTS.include?(value)
        die "outcome.validation must be one of: #{RUN_VALIDATION_RESULTS.join(', ')}"
      end
      record["outcome"]["validation"] = value
    when /\Ausage\.(.+)\z/
      field = Regexp.last_match(1)
      die "Unknown usage field: #{field}" unless USAGE_KEYS.include?(field)
      # Telemetry the runner did not report stays out of the block entirely.
      next if value.nil?
      die "usage.#{field} must be a non-negative integer" unless value.match?(/\A\d+\z/)
      (record["usage"] ||= {})[field] = value.to_i
    else
      die "Unknown field: #{key}"
    end
  end
end

def load_record(path)
  data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  die "Run record is not a mapping: #{path}", 3 unless data.is_a?(Hash)
  data["outcome"] = {} unless data["outcome"].is_a?(Hash)
  data
end

command = ARGV.shift
task_dir = ARGV.shift
die "Usage: record-run.rb start|update|finish <task-dir> ..." if command.nil? || task_dir.nil?
die "Task dir not found: #{task_dir}", 3 unless File.directory?(task_dir)

records_dir = File.join(task_dir, RECORDS_DIRNAME)

case command
when "start"
  task_id = ARGV.shift
  role = ARGV.shift
  die "Usage: record-run.rb start <task-dir> <task-id> <role> [k=v ...]" if task_id.nil? || role.nil?
  die "Unknown role: #{role} (expected one of: #{RUN_ROLES.join(', ')})" unless RUN_ROLES.include?(role)

  instruction = $stdin.tty? ? "" : $stdin.read
  record = { "run_id" => nil, "task_id" => task_id, "role" => role }
  IDENTITY_KEYS.each { |key| record[key] = nil }
  record["started_at"] = now_iso
  record["completed_at"] = nil
  record["outcome"] = { "status" => "running", "exit_code" => nil, "validation" => nil }
  record["instruction_sha"] = "sha256:#{Digest::SHA256.hexdigest(instruction)}" unless instruction.empty?
  apply_pairs(record, parse_pairs(ARGV))

  run_id = nil
  with_task_lock(task_dir) do
    Dir.mkdir(records_dir) unless File.directory?(records_dir)
    # Regenerate rather than clobber: a taken id is never reused, so retries of
    # the same task/role in the same second cannot overwrite an earlier record.
    10.times do
      candidate = build_run_id(task_id, role)
      next if File.exist?(File.join(records_dir, "#{candidate}.yaml"))
      run_id = candidate
      break
    end
    die "Could not allocate a unique run id in #{records_dir}", 3 if run_id.nil?
    record["run_id"] = run_id
    write_atomic(File.join(records_dir, "#{run_id}.yaml"), record)
  end
  puts run_id

when "update", "finish"
  run_id = ARGV.shift
  die "Usage: record-run.rb #{command} <task-dir> <run-id> [k=v ...]" if run_id.nil?
  path = File.join(records_dir, "#{run_id}.yaml")
  die "Run record not found: #{path}", 3 unless File.exist?(path)

  pairs = parse_pairs(ARGV)
  with_task_lock(task_dir) do
    record = load_record(path)
    apply_pairs(record, pairs)
    record["completed_at"] = now_iso if command == "finish"
    write_atomic(path, record)
  end
  puts run_id

else
  die "Unknown command: #{command}"
end
