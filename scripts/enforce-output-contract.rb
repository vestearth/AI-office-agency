#!/usr/bin/env ruby
# frozen_string_literal: true

# Producer-contract enforcement (Slice 2).
#
# Validates a single agent's output against its contract (via validate-yaml.rb).
# On failure, sets the task's status.yaml phase/state to `validation_failed`
# (atomic write) so invalid output is NOT propagated downstream.
#
# Usage: ruby scripts/enforce-output-contract.rb <TASK_ID> <AGENT>
# Exit:  0 = valid, or not contract-enforced  -> driver may proceed
#        1 = invalid -> status set to validation_failed; driver must not sync
#        2 = usage / config error

require "yaml"
require "date"
require "open3"
require_relative "task-ownership"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
MANIFEST = File.join(OFFICE_DIR, "agents", "manifest.yaml")
VALIDATOR = File.join(OFFICE_DIR, "validate-yaml.rb")
VALIDATION_FAILED_PHASE = "validation_failed"

def die(message, code)
  warn message
  exit code
end

def load_manifest
  data = YAML.safe_load(File.read(MANIFEST), permitted_classes: [], aliases: false)
  data.is_a?(Hash) ? data : nil
rescue StandardError
  nil
end

def load_status(path)
  data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  data.is_a?(Hash) ? data : {}
rescue StandardError => e
  # M5: load_status only runs for a file that EXISTS. If it won't parse, it is
  # corrupt — do NOT flatten to {} (the caller would rename-commit a stub,
  # dropping task_id/iteration/assignment). Back it up and fail loud instead.
  backup = "#{path}.corrupt.#{Process.pid}"
  begin
    File.write(backup, File.read(path))
  rescue StandardError
    backup = "(backup failed)"
  end
  die("status.yaml unreadable/corrupt (#{e.class}: #{e.message}); backed up to #{backup}. Refusing to overwrite it with a stub.", 2)
end

def mark_validation_failed(status_path, agent, detail = "")
  # M1: per-task lock around the read-modify-write (released at block exit).
  File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644) do |lock|
    lock.flock(File::LOCK_EX)

    # I3: ownership fence, inside the lock. This is a full status write on the
    # NORMAL failure path of a dispatch, so a run that lost its lease must not
    # land it — without this the fence is bypassable through plain validation
    # failure. Owner lane: the epoch this dispatch was granted is compared
    # against the register. See docs/task-ownership.md.
    TaskOwnership.fence!(File.dirname(status_path))

    data = File.exist?(status_path) ? load_status(status_path) : {}
    prev_phase = data["phase"].to_s

    data["phase"] = VALIDATION_FAILED_PHASE
    data["state"] = VALIDATION_FAILED_PHASE
    data["updated_at"] = Date.today.to_s
    data["ready"] = false
    # M4: route OUT to free-roam for remediation instead of leaving the failing
    # agent as current_agent (which made `next`/auto re-run it on the same input).
    data["current_agent"] = "free-roam"
    # M4: bounded retry counter. sync is skipped on validation_failed, so
    # `iteration` never advances — the driver halts once this hits the limit.
    data["validation_failed_retries"] = data["validation_failed_retries"].to_i + 1

    # M4: don't churn history on a repeated validation_failed -> validation_failed.
    unless prev_phase == VALIDATION_FAILED_PHASE
      history = data["history"].is_a?(Array) ? data["history"] : []
      # N3: keep the specific validator message, not just a generic line.
      detail_line = detail.to_s.strip.lines.first(3).map(&:strip).reject(&:empty?).join("; ")
      reason = "#{agent} output failed schema validation"
      reason += ": #{detail_line[0, 400]}" unless detail_line.empty?
      history << {
        "phase" => "#{prev_phase.empty? ? 'unknown' : prev_phase} -> #{VALIDATION_FAILED_PHASE}",
        "agent" => "orchestrator",
        "reason" => reason,
        "at" => Time.now.utc.strftime("%FT%TZ")  # N1
      }
      data["history"] = history
    end

    # Atomic write (mirrors the driver's status-write pattern).
    tmp = "#{status_path}.tmp.#{Process.pid}"
    File.write(tmp, YAML.dump(data))
    File.rename(tmp, status_path)
  end
end

task_id, agent = ARGV
die("Usage: enforce-output-contract.rb <TASK_ID> <AGENT>", 2) if task_id.nil? || agent.nil?

manifest = load_manifest
die("Cannot read manifest: #{MANIFEST}", 2) unless manifest

agent_def = manifest.dig("agents", agent)
# Agents without a manifest entry are not contract-enforced -> pass through.
exit 0 unless agent_def.is_a?(Hash) && agent_def["output_file"]

# Only enforce when the policy is strict.
policy = manifest.dig("validation", "policy")
exit 0 unless policy == "strict"

task_dir = File.join(RUNS_DIR, task_id)
output_path = File.join(task_dir, agent_def["output_file"])
# Nothing produced yet -> not this gate's concern.
exit 0 unless File.exist?(output_path)

# Validate just this output file with the canonical validator.
_stdout, stderr, status = Open3.capture3("ruby", VALIDATOR, output_path)
exit 0 if status.success?

mark_validation_failed(File.join(task_dir, "status.yaml"), agent, stderr)

warn "Output contract failed for #{task_id}/#{agent}; phase set to #{VALIDATION_FAILED_PHASE}."
warn stderr unless stderr.strip.empty?
exit 1
