#!/usr/bin/env ruby
# frozen_string_literal: true

# Execution budget: a deterministic, rule-based controller that detects a run
# making no meaningful progress and says so, instead of letting it loop
# silently.
#
# This is DELIBERATELY a boring counter, not a smart one. It looks at the same
# telemetry every other office component writes for its own reasons (run
# identity from #13, the evidence ledger, meta.yaml events, status.yaml
# history) and can raise ONE of three narrow, mechanical exhaustion signals
# (`classify`), plus one annotation-only signal that can never itself halt
# anything (`validation_failure_annotation` — see (2) below):
#
#   1. Did the last two failing evidence entries fail on the SAME command with
#      BYTE-IDENTICAL output, with NOTHING meaningful logged in between?
#                                                  -> repeated_command_failure
#   2. Is validation_failed_retries at (or past) the existing cap, AND did the
#      last two evidence entries carry no new diagnosis?  ANNOTATION ONLY —
#      never sets exhausted, never gates a dispatch on its own; see the
#      comment on validation_failure_signal below for why.
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
# Signal (2) is annotation-only and is NOT in SIGNAL_ORDER: it can never make
# `classify` return exhausted=true, and the actual halt on validation_failed
# stays entirely run-agent.sh's own PRE-EXISTING, unconditional M4 block
# (loop_guard.validation_failed_retry_limit / status.yaml
# validation_failed_retries — untouched by #16,
# tests/integration/validation-failed-bounded.sh stays byte-for-byte green).
# An earlier revision of this file DID put (2) in the exhaustion path, and an
# independent audit caught the resulting bug: M4 honors
# `AI_DEV_OFFICE_FORCE=true` as an operator override, but this file's own
# dispatch-time checkpoint had no such check, so it independently
# re-implemented M4's trigger condition and silently overrode the operator's
# override. (2) exists ONLY so M4's own halt can enrich its recorded reason —
# see docs/execution-budget.md "Retryable vs. exhausted".
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
#   ruby scripts/execution-budget.rb annotate-validation-failure <task-dir> <task-id> <agent>
#
# `classify` prints one line to stdout:
#   exhausted=<true|false> signal=<name|none> reason="<text>"
# `annotate-validation-failure` prints:
#   applicable=<true|false> reason="<text>"
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

  # Event types the harness itself writes as pure bookkeeping around every
  # dispatch, regardless of whether any real work happened. Anything ELSE
  # logged to meta.yaml between two evidence timestamps — a diagnosis note, a
  # role's own summary, a handoff reason, a future event type nobody has
  # invented yet — counts as meaningful activity. The allowlist is
  # deliberately the narrow side (routine types out), not the wide side
  # (diagnostic types in): a new event type this file has never heard of is
  # assumed meaningful rather than assumed routine, so a future addition to
  # log_meta_event's callers cannot silently widen the false-positive surface
  # back open.
  ROUTINE_META_EVENT_TYPES = %w[
    prompt_assembly runner_complete runner_failed runner_retry runner_switch
    ownership_acquired context_provider loop_guard execution_budget
    decision_applied reopen_blocked
  ].freeze

  # True when something happened strictly between two timestamps that is
  # evidence of real work, not just the harness's own dispatch bookkeeping: a
  # non-routine meta.yaml event, OR any evidence.yaml entry at all (even a
  # passing one — running a different check in between is still work).
  def meaningful_activity_between?(task_dir, from_ts, to_ts)
    return false if from_ts.to_s.empty? || to_ts.to_s.empty?

    meta_events(task_dir).any? do |e|
      ts = e["timestamp"].to_s
      !ts.empty? && ts > from_ts && ts < to_ts && !ROUTINE_META_EVENT_TYPES.include?(e["type"].to_s)
    end || evidence_entries(task_dir).any? do |e|
      ts = e["executed_at"].to_s
      !ts.empty? && ts > from_ts && ts < to_ts
    end
  end

  # ── Signal 1: same failing command, byte-identical output, twice running,
  #    with NOTHING meaningful logged in between ──────────────────────────
  # The "in between" check is what tells a stuck loop (rerun, no new
  # information, rerun again) apart from a legitimate baseline-then-confirm
  # rerun (rerun to confirm a diagnosis before applying the actual fix) —
  # both produce byte-identical output on the second run, but only the first
  # is non-progress.
  def repeated_command_failure(task_dir)
    failing = evidence_entries(task_dir).select { |e| e["exit_code"].to_i != 0 }
    return nil if failing.size < 2

    last_two = failing.last(2)
    a, b = last_two
    same_command = a["command"].to_s == b["command"].to_s && !a["command"].to_s.strip.empty?
    same_output = a["artifact_sha256"].to_s == b["artifact_sha256"].to_s && !a["artifact_sha256"].to_s.empty?
    return nil unless same_command && same_output
    return nil if meaningful_activity_between?(task_dir, a["executed_at"].to_s, b["executed_at"].to_s)

    {
      "signal" => "repeated_command_failure",
      "reason" => "command #{a['command'].to_s.inspect} failed twice in a row " \
                  "(#{a['id']}, #{b['id']}) with byte-identical output and nothing " \
                  "meaningful logged in between (no material change)"
    }
  end

  # ── Signal 2 (ANNOTATION ONLY — see below): validation_failed about to
  #    exhaust, no new diagnosis ────────────────────────────────────────────
  # This method is deliberately NOT in SIGNAL_ORDER and can never make
  # `classify` return exhausted=true. It exists only so run-agent.sh's
  # PRE-EXISTING, unconditional validation_failed halt (the M4 block —
  # untouched by #16) can enrich its own recorded reason with whether the
  # repeat carried new evidence. Putting this in the exhaustion path would
  # have meant this file independently re-implementing M4's trigger condition
  # with no `AI_DEV_OFFICE_FORCE` escape hatch — the exact operator-override
  # bypass the audit caught. M4 already honors `AI_DEV_OFFICE_FORCE`; nothing
  # in this file may ever produce a second, un-overridable copy of that halt.
  # Call it directly via `annotate-validation-failure` on the CLI, or
  # `ExecutionBudget.validation_failure_annotation` as a library.
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
  # run_ids of dispatches that EXPLICITLY declared they were not required to
  # produce evidence. Today the only producer of that declaration is #12's
  # review-gate, which logs a `reviewer_evidence_policy` meta event with
  # `require_evidence=false|true` on every reviewer dispatch (low/normal risk
  # -> false, higher risk -> true). A dispatch this office itself says did not
  # need evidence must not be penalized by this file for lacking it — see
  # docs/execution-budget.md "Fix 5: evidence-exempt dispatches".
  def evidence_exempt_run_ids(task_dir)
    meta_events(task_dir).each_with_object({}) do |e, memo|
      next unless e["type"].to_s == "reviewer_evidence_policy"
      next unless e["details"].to_s.match?(/(?:^|\s)require_evidence=false(?:\s|$)/)

      run_id = e["run_id"].to_s
      memo[run_id] = true unless run_id.empty?
    end
  end

  def no_new_evidence_signal(task_dir)
    exempt = evidence_exempt_run_ids(task_dir)
    # Events with NO run_id (pre-dispatch context_provider events, or events
    # logged before run identity existed) are never exempt — there is nothing
    # to look up an exemption FOR, so they count exactly as before. Only an
    # event attributable to a run this office itself marked evidence-exempt is
    # dropped from the tally.
    events = meta_events(task_dir).reject { |e| exempt[e["run_id"].to_s] }
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
      "reason" => "#{actions_since} logged actions (evidence-exempt dispatches excluded) since the last " \
                  "evidence.yaml entry (limit #{limit})#{last_evidence_at && !last_evidence_at.empty? ? " at #{last_evidence_at}" : ' — no evidence has ever been recorded for this task'}"
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

  # validation_failure_signal is deliberately EXCLUDED — see the comment above
  # that method. It can never make `classify` return exhausted=true; it is
  # reachable only through validation_failure_annotation, below.
  SIGNAL_ORDER = %i[repeated_command_failure no_new_evidence_signal role_ping_pong_signal].freeze

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

  # Non-blocking counterpart to `classify`: never sets `exhausted`, only says
  # whether the validation-failure repeat carried a new diagnosis. Meant to be
  # called by run-agent.sh's PRE-EXISTING M4 halt to enrich ITS reason string,
  # never to gate a dispatch on its own.
  def validation_failure_annotation(task_dir)
    return { "applicable" => false, "reason" => "task dir not found" } unless task_dir && File.directory?(task_dir)

    hit = validation_failure_signal(task_dir)
    hit ? { "applicable" => true, "reason" => hit["reason"] } : { "applicable" => false, "reason" => "not at the retry cap" }
  rescue StandardError => e
    { "applicable" => false, "reason" => "execution-budget annotation error: #{e.class}: #{e.message}" }
  end

  def format_line(result)
    reason = result["reason"].to_s.gsub('"', "'")
    %(exhausted=#{result['exhausted']} signal=#{result['signal']} reason="#{reason}")
  end

  def format_annotation(result)
    reason = result["reason"].to_s.gsub('"', "'")
    %(applicable=#{result['applicable']} reason="#{reason}")
  end
end

if $PROGRAM_NAME == __FILE__
  USAGE = "usage: execution-budget.rb classify|annotate-validation-failure <task-dir> [<task-id> <agent>]"
  command = ARGV.shift
  unless %w[classify annotate-validation-failure].include?(command)
    warn USAGE
    exit 2
  end

  task_dir = ARGV.shift
  # task_id / agent are accepted for symmetry with the rest of the office's
  # CLI scripts and for future use (e.g. attributing the reason string), but
  # the classification itself is read entirely from task_dir's own files.
  _task_id = ARGV.shift
  _agent = ARGV.shift

  if task_dir.nil?
    warn USAGE
    exit 2
  end

  case command
  when "classify"
    puts ExecutionBudget.format_line(ExecutionBudget.classify(task_dir))
  when "annotate-validation-failure"
    puts ExecutionBudget.format_annotation(ExecutionBudget.validation_failure_annotation(task_dir))
  end
  exit 0
end
