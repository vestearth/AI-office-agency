#!/usr/bin/env ruby
# frozen_string_literal: true

# Execution budget: a deterministic, rule-based controller that detects a run
# making no meaningful progress and says so, instead of letting it loop
# silently.
#
# This is DELIBERATELY a boring counter, not a smart one. It looks at the same
# telemetry every other office component writes for its own reasons (run
# identity from #13, the evidence ledger, meta.yaml events, status.yaml
# history) and asks four narrow, mechanical questions:
#
#   1. Did the last two failing evidence entries fail on the SAME command with
#      BYTE-IDENTICAL output?                    -> repeated_command_failure
#   2. Is validation_failed_retries about to exhaust the existing cap, AND did
#      the last two evidence entries carry no new diagnosis?
#                                                  -> validation_failure_no_new_evidence
#   3. Has this task logged max_no_progress_actions meta events since its last
#      evidence.yaml append (or since the task started, if it has none)?
#                                                  -> no_new_evidence
#   4. Did the last six status.yaml history entries alternate between the same
#      two roles with the evidence count unchanged across the whole window?
#                                                  -> role_ping_pong
#
# Signals this issue's brief named and this file deliberately does NOT
# implement (see docs/execution-budget.md "Scoped out" for the reasoning):
#   - same search/query repeated: no per-query instrumentation exists anywhere
#     in the office to detect this from, and inventing one elsewhere is out of
#     scope for this file.
#   - scope expansion beyond a declared task boundary: an ordinary task (unlike
#     #17/#19's gateway path) has no clean "declared scope" to expand beyond.
#
# Signal (2) is deliberately observational only: it does NOT change whether
# run-agent.sh halts on validation_failed. That halt is #16's own prior art
# (loop_guard.validation_failed_retry_limit / status.yaml
# validation_failed_retries) and this file extends it with a documented
# retryable-vs-exhausted distinction, never replaces its counting or its
# tests (tests/integration/validation-failed-bounded.sh stays byte-for-byte
# green — see docs/execution-budget.md).
#
# Fail-open, not fail-closed, on missing or unreadable telemetry: this
# controller only ever raises a signal from POSITIVE evidence of repetition
# (two matching entries, N logged events, six alternating history rows). A
# task with no evidence.yaml, no meta.yaml, or a short history has not
# demonstrated non-progress — it has demonstrated nothing yet — so absence of
# data classifies as `exhausted=false`, never as an assumed stall. This is the
# one place this file's fail posture differs from preflight.rb's fail-closed
# (preflight gates a PRIVILEGED ACTION so silence must deny it; this file
# gates ordinary iteration so silence must not halt the whole office on a
# telemetry hiccup). Malformed CONFIG still falls back to hardcoded defaults,
# exactly like loop_guard's own resolve_loop_limit.
#
# Usage:
#   ruby scripts/execution-budget.rb classify <task-dir> <task-id> <agent>
#
# Prints one line to stdout:
#   exhausted=<true|false> signal=<name|none> reason="<text>"
# Exit: always 0 on a completed classification (the driver reads stdout, not
# the exit code — see the "fail-open" note above). Exit 2 on a usage error.
#
# Recording: the CALLER (run-agent.sh) logs the outcome via log_meta_event as
# an `execution_budget` event when a signal fires, exactly like the existing
# `loop_guard` event does for the free-roam and max_iterations halts. This
# file does not write to meta.yaml itself, so a dry classify (e.g. from a
# test, or a future dashboard read) never has a side effect.

require "yaml"
require "date"

require_relative "resolve-office-config"

module ExecutionBudget
  OFFICE_DIR = File.expand_path("..", __dir__)
  DEFAULT_MAX_NO_PROGRESS_ACTIONS = 12
  DEFAULT_VALIDATION_FAILED_RETRY_LIMIT = 3
  # Roles this signal treats as "the same conversation" for ping-pong
  # detection — mirrors the pairs the office actually round-trips today.
  PING_PONG_PAIRS = [%w[dev reviewer], %w[dev debugger], %w[dev-2 reviewer], %w[dev-2 debugger]].freeze
  PING_PONG_WINDOW = 6
  PING_PONG_MIN_ALTERNATIONS = 3

  module_function

  def load_yaml(path)
    return nil unless path && File.exist?(path)

    YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  rescue Psych::SyntaxError, ArgumentError
    nil
  end

  def config
    OfficeConfigResolver.new(OFFICE_DIR)
  rescue StandardError
    nil
  end

  def max_no_progress_actions
    value = config&.get("execution_budget.max_no_progress_actions", DEFAULT_MAX_NO_PROGRESS_ACTIONS)
    value = value.to_s.match?(/\A\d+\z/) ? value.to_i : DEFAULT_MAX_NO_PROGRESS_ACTIONS
    value.positive? ? value : DEFAULT_MAX_NO_PROGRESS_ACTIONS
  rescue StandardError
    DEFAULT_MAX_NO_PROGRESS_ACTIONS
  end

  def validation_failed_retry_limit
    # Reused, not duplicated: the SAME key run-agent.sh's own loop guard reads
    # (loop_guard.validation_failed_retry_limit). A second config key here
    # could disagree with the one the driver actually enforces; see
    # docs/execution-budget.md "Relationship to loop_guard".
    value = config&.get("loop_guard.validation_failed_retry_limit", DEFAULT_VALIDATION_FAILED_RETRY_LIMIT)
    value = value.to_s.match?(/\A\d+\z/) ? value.to_i : DEFAULT_VALIDATION_FAILED_RETRY_LIMIT
    value.positive? ? value : DEFAULT_VALIDATION_FAILED_RETRY_LIMIT
  rescue StandardError
    DEFAULT_VALIDATION_FAILED_RETRY_LIMIT
  end

  def evidence_entries(task_dir)
    data = load_yaml(File.join(task_dir, "evidence.yaml"))
    entries = data.is_a?(Hash) ? data["evidence"] : nil
    Array(entries).select { |e| e.is_a?(Hash) }.sort_by { |e| e["executed_at"].to_s }
  end

  def meta_events(task_dir)
    data = load_yaml(File.join(task_dir, "meta.yaml"))
    events = data.is_a?(Hash) ? data["events"] : nil
    Array(events).select { |e| e.is_a?(Hash) }
  end

  def status_history(task_dir)
    data = load_yaml(File.join(task_dir, "status.yaml"))
    history = data.is_a?(Hash) ? data["history"] : nil
    Array(history).select { |e| e.is_a?(Hash) }
  end

  def status(task_dir)
    load_yaml(File.join(task_dir, "status.yaml")) || {}
  end

  # ── Signal 1: same failing command, byte-identical output, twice running ──
  def repeated_command_failure(task_dir)
    failing = evidence_entries(task_dir).select { |e| e["exit_code"].to_i != 0 }
    return nil if failing.size < 2

    last_two = failing.last(2)
    a, b = last_two
    same_command = a["command"].to_s == b["command"].to_s && !a["command"].to_s.strip.empty?
    same_output = a["artifact_sha256"].to_s == b["artifact_sha256"].to_s && !a["artifact_sha256"].to_s.empty?
    return nil unless same_command && same_output

    {
      "signal" => "repeated_command_failure",
      "reason" => "command #{a['command'].to_s.inspect} failed twice in a row " \
                  "(#{a['id']}, #{b['id']}) with byte-identical output (no material change)"
    }
  end

  # ── Signal 2: validation_failed about to exhaust, no new diagnosis ────────
  # Observational: the caller does NOT use this to halt (run-agent.sh's own
  # validation_failed block already does, unconditionally on the retry count).
  # This only sharpens the recorded REASON with whether the repeat carried new
  # evidence, satisfying the retryable-vs-exhausted distinction the brief asks
  # for without duplicating or racing the existing halt.
  def validation_failure_signal(task_dir)
    st = status(task_dir)
    phase = st["phase"].to_s
    state = st["state"].to_s
    return nil unless phase == "validation_failed" || state == "validation_failed"

    retries = st["validation_failed_retries"].to_i
    limit = validation_failed_retry_limit
    return nil if retries < limit

    failing = evidence_entries(task_dir)
    no_new_evidence =
      if failing.size >= 2
        a, b = failing.last(2)
        a["command"].to_s == b["command"].to_s && a["artifact_sha256"].to_s == b["artifact_sha256"].to_s &&
          !a["artifact_sha256"].to_s.empty?
      else
        # No evidence to compare is not evidence of a NEW diagnosis either;
        # treat it the same as the existing driver does (retries alone decide).
        true
      end

    {
      "signal" => "validation_failure_no_new_evidence",
      "reason" => "validation_failed_retries (#{retries}) reached the limit (#{limit})" +
                  (no_new_evidence ? " with no new diagnosis since the last failure" : " but the last failure carried new evidence")
    }
  end

  # ── Signal 3: no evidence appended in the last N logged actions ───────────
  def no_new_evidence_signal(task_dir)
    events = meta_events(task_dir)
    return nil if events.empty?

    limit = max_no_progress_actions
    last_evidence_at = evidence_entries(task_dir).map { |e| e["executed_at"].to_s }.max

    actions_since =
      if last_evidence_at.nil? || last_evidence_at.empty?
        events.size
      else
        events.count { |e| e["timestamp"].to_s > last_evidence_at }
      end

    return nil if actions_since < limit

    {
      "signal" => "no_new_evidence",
      "reason" => "#{actions_since} logged actions since the last evidence.yaml entry " \
                  "(limit #{limit})#{last_evidence_at && !last_evidence_at.empty? ? " at #{last_evidence_at}" : ' — no evidence has ever been recorded for this task'}"
    }
  end

  # ── Signal 4: the same two roles handing off back and forth, no evidence
  #    growth across the window (proxy for edit -> revert -> edit) ──────────
  def role_ping_pong_signal(task_dir)
    history = status_history(task_dir).last(PING_PONG_WINDOW)
    return nil if history.size < PING_PONG_WINDOW

    roles = history.map { |h| h["agent"].to_s }
    pair = PING_PONG_PAIRS.find { |p| (roles.uniq - p).empty? && p.all? { |r| roles.include?(r) } }
    return nil unless pair

    alternations = (1...roles.size).count { |i| roles[i] != roles[i - 1] }
    return nil if alternations < PING_PONG_MIN_ALTERNATIONS

    # Evidence must not have grown across the WHOLE window for this to count as
    # thrash rather than legitimate iterative review.
    window_start = history.first["at"].to_s
    window_end = history.last["at"].to_s
    grew = evidence_entries(task_dir).any? do |e|
      ts = e["executed_at"].to_s
      !ts.empty? && ts > window_start && ts <= window_end
    end
    return nil if grew

    {
      "signal" => "role_ping_pong",
      "reason" => "#{roles.join(' -> ')} across the last #{history.size} handoffs " \
                  "with no new evidence between #{window_start} and #{window_end}"
    }
  end

  SIGNAL_ORDER = %i[repeated_command_failure validation_failure_signal no_new_evidence_signal role_ping_pong_signal].freeze

  # Runs every signal in a fixed order and returns the FIRST one that fires.
  # Order is itself a documented, deterministic choice (most-specific /
  # cheapest-to-explain first), not a priority ranking of severity.
  def classify(task_dir)
    return { "exhausted" => false, "signal" => "none", "reason" => "task dir not found" } unless task_dir && File.directory?(task_dir)

    SIGNAL_ORDER.each do |method_name|
      hit = public_send(method_name, task_dir)
      next unless hit

      return { "exhausted" => true, "signal" => hit["signal"], "reason" => hit["reason"] }
    end
    { "exhausted" => false, "signal" => "none", "reason" => "no non-progress signal matched" }
  rescue StandardError => e
    # Fail-open (see header): a bug in this classifier must never itself halt
    # a healthy task. Recorded so it is visible, not silently swallowed.
    { "exhausted" => false, "signal" => "none", "reason" => "execution-budget classifier error: #{e.class}: #{e.message}" }
  end

  def format_line(result)
    reason = result["reason"].to_s.gsub('"', "'")
    %(exhausted=#{result['exhausted']} signal=#{result['signal']} reason="#{reason}")
  end
end

if $PROGRAM_NAME == __FILE__
  command = ARGV.shift
  if command != "classify"
    warn "usage: execution-budget.rb classify <task-dir> <task-id> <agent>"
    exit 2
  end

  task_dir = ARGV.shift
  # task_id / agent are accepted for symmetry with the rest of the office's
  # CLI scripts and for future use (e.g. attributing the reason string), but
  # the classification itself is read entirely from task_dir's own files.
  _task_id = ARGV.shift
  _agent = ARGV.shift

  if task_dir.nil?
    warn "usage: execution-budget.rb classify <task-dir> <task-id> <agent>"
    exit 2
  end

  puts ExecutionBudget.format_line(ExecutionBudget.classify(task_dir))
  exit 0
end
