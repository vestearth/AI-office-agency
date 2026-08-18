#!/usr/bin/env ruby
# frozen_string_literal: true

# Driver-side reconcile of a human decision (decision.yaml) into the workflow
# (status.yaml).
#
# Single-writer invariant: the dashboard writes decision.yaml, the driver (this
# script, run from run-agent.sh) writes status.yaml — never the same file.
#
# Idempotent: applies only the LATEST decision, and only once, tracked via
# status.yaml `decision_applied_at` (= that decision's decided_at).
#
# Usage:  ruby scripts/reconcile-decision.rb <TASK_ID>
# Output: "applied:<decision>:<phase>" when it transitions, else "noop".
# Exit:   0 on success (applied or noop); 2 on usage error.

require "yaml"
require "date"
require_relative "task-ownership"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))

# Human decision -> workflow transition. Mirrors the reviewer verdict semantics
# the state machine already knows how to continue.
DECISION_MAP = {
  "approve"         => { "phase" => "done",      "current_agent" => "done",      "ready" => false },
  "request_changes" => { "phase" => "debugging", "current_agent" => "debugger",  "ready" => true  },
  "escalate"        => { "phase" => "escalated", "current_agent" => "free-roam", "ready" => true  },
  "reject"          => { "phase" => "aborted",   "current_agent" => nil,         "ready" => false }
}.freeze

# Returns the parsed mapping, or nil if the file is ABSENT. A present-but-
# unreadable file (S3) is surfaced and exits 3 — never silently treated as
# "nothing pending", which would drop a real human decision.
def load_or_die(path, label)
  return nil unless File.exist?(path)

  data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  return data if data.is_a?(Hash)

  warn "#{label} is present but not a valid mapping; refusing to silently ignore it."
  exit 3
rescue Psych::SyntaxError => e
  warn "#{label} is malformed YAML (#{e.message}); refusing to silently ignore it."
  exit 3
end

def noop!
  puts "noop"
  exit 0
end

task_id = ARGV[0]
if task_id.nil? || task_id.strip.empty?
  warn "Usage: reconcile-decision.rb <TASK_ID>"
  exit 2
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
decision_path = File.join(task_dir, "decision.yaml")

# M1: serialize with the driver's status writers (parallel lanes share .lock).
# Held for the whole process; released on exit (including via noop!).
if File.directory?(task_dir)
  lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)

  # I3: ownership fence, inside the lock. ORCHESTRATOR lane: applying a human
  # decision is not a dispatch and never held a lease, so there is no epoch to
  # compare — it is refused only while a lease is LIVE (an agent is executing
  # right now, and landing a phase change under it would race that dispatch's
  # own write). See docs/task-ownership.md.
  TaskOwnership.fence!(task_dir, force_orchestrator: true)
end

status = load_or_die(status_path, "status.yaml")
decisions_doc = load_or_die(decision_path, "decision.yaml")
noop! unless status && decisions_doc

list = decisions_doc["decisions"]
candidates = list.is_a?(Array) ? list.select { |d| d.is_a?(Hash) && DECISION_MAP.key?(d["decision"]) } : []
# S4: a decision with no decided_at can never be marked applied (its idempotency
# key would be ""), so it would re-apply on every dispatch. Require decided_at.
latest = candidates.reverse.find { |d| !d["decided_at"].to_s.strip.empty? }
if latest.nil? && !candidates.empty?
  warn "Newest decision for #{task_id} has no decided_at; skipping (it could never be marked applied)."
end
noop! unless latest

decided_at = latest["decided_at"].to_s
# Already applied this exact decision? (decided_at is guaranteed non-empty now.)
noop! if status["decision_applied_at"].to_s == decided_at

mapping = DECISION_MAP.fetch(latest["decision"])
prev_phase = status["phase"].to_s

status["phase"] = mapping["phase"]
status["state"] = mapping["phase"]
status["current_agent"] = mapping["current_agent"]
status["ready"] = mapping["ready"]
status["updated_at"] = Date.today.to_s
status["decision_applied_at"] = decided_at

actor = latest["actor"].to_s
actor = "unknown" if actor.empty?
history = status["history"].is_a?(Array) ? status["history"] : []
history << {
  "phase" => "#{prev_phase.empty? ? 'unknown' : prev_phase} -> #{mapping['phase']}",
  "agent" => "orchestrator",
  "reason" => "human decision: #{latest['decision']} by #{actor}",
  "at" => Time.now.utc.strftime("%FT%TZ")  # N1
}
status["history"] = history

# Atomic write (status.yaml is driver-owned).
tmp = "#{status_path}.tmp.#{Process.pid}"
File.write(tmp, YAML.dump(status))
File.rename(tmp, status_path)

puts "applied:#{latest['decision']}:#{mapping['phase']}"
exit 0
