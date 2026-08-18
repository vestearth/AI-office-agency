#!/usr/bin/env ruby
# frozen_string_literal: true

# Event-driven agent gateway (issue #19): normalizes an already-received
# GitHub/CI/tester event into one internal envelope, resolves it to a TASK-*
# id, and enqueues a normal `./run-agent.sh <TASK_ID> <AGENT>` dispatch.
#
#   event (github | test) -> normalize -> ONE envelope shape
#     -> idempotency reservation (delivery_id)
#     -> command grammar (first line, exact literal match, no argument parsing)
#     -> identity resolution (existing task_id, or a maintained external_ref
#        -> task_id mapping, or — /agent triage only — mint a new one)
#     -> preflight PRE-CHECK (library call, decides nothing on disk)
#     -> ./run-agent.sh (the real, authoritative preflight + ownership gate)
#
# This file composes #17 (scripts/preflight.rb) and #14
# (scripts/task-ownership.rb, via run-agent.sh) rather than re-implementing
# either. It does not verify webhook signatures, serve HTTP, or listen on a
# socket — it normalizes and dispatches an ALREADY-RECEIVED payload. See
# docs/event-gateway.md.
#
# Usage:
#   ruby scripts/event-gateway.rb handle --adapter github --input-file <payload.json> [--dry-run]
#   ruby scripts/event-gateway.rb handle --adapter test   --input-file <envelope.yaml> [--dry-run]
#
# Prints "<delivery_id> <outcome>" on stdout, where outcome is one of:
#   dispatched  duplicate  rejected_command  rejected_identity
#   rejected_preflight  rejected_malformed  dispatch_failed
#
# Exit codes:
#   0  dispatched (the driver ran and exited 0)
#    1  dispatch_failed (the driver ran and exited non-zero)
#   10  duplicate (this delivery_id was already reserved/processed)
#   11  rejected_command   12  rejected_identity   13  rejected_preflight
#   14  rejected_malformed  2  usage error
#
# Contract: docs/event-gateway.md  Schema: schemas/gateway-events.schema.yaml

require "yaml"
require "json"
require "date"
require "time"
require "tmpdir"
require "tempfile"
require "fileutils"
require "digest"

require_relative "resolve-office-config"
# Reused as a LIBRARY: decide_or_deny/resolved_policy/now_iso/die/with_task_lock
# come from here. The bottom of preflight.rb is guarded by
# `if $PROGRAM_NAME == __FILE__`, so requiring it never runs its CLI branch —
# the same pattern tests/integration/policy-preflight.sh already relies on.
require_relative "preflight"

# OFFICE_DIR and RUNS_DIR come from the `require_relative "preflight"` above —
# same values, same AI_OFFICE_RUNS_DIR override, one definition.
GATEWAY_DIR = File.join(RUNS_DIR, "_gateway")
LEDGER_PATH = File.join(GATEWAY_DIR, "ledger.yaml")
MAPPING_PATH = File.join(GATEWAY_DIR, "external-refs.yaml")

# Mirrors validate-yaml.rb's TASK_ID_PATTERN exactly. Duplicated rather than
# required: validate-yaml.rb runs its CLI body unconditionally at load time
# (no $PROGRAM_NAME guard), so `require`-ing it would execute a validation run
# as a side effect of loading this library. Keep the two definitions in sync by
# hand; tests/integration/event-gateway.sh pins this copy against the other
# file's copy so drift fails loudly instead of silently.
TASK_ID_PATTERN = /^TASK(?:-[A-Z][A-Z0-9]*)?-\d+$/.freeze

# The MINTING namespace for tasks the gateway itself creates (the `/agent
# triage` path, issue #19 §"brand-new task from a bare issue"). A dedicated
# prefix keeps gateway-minted ids visually distinct from operator/PM-assigned
# TASK-<PROJECT>-NNN ids and never collides with them.
MINT_PREFIX = "TASK-GW"

# ── THE COMMAND GRAMMAR ──────────────────────────────────────────────────────
# The entire first line of the event body (CRLF-normalized, then stripped of
# leading/trailing whitespace ON THAT LINE ONLY) must equal, byte-for-byte,
# one of the keys in gateway.commands. No case folding. No argument parsing.
# Every other line — including a second line that itself looks like a
# command — is CONTEXT: it can flow into the preflight input hash/scan, and
# nowhere else. This is intentionally the narrowest grammar that can still
# express "one of N fixed actions": a literal-set membership test, not a
# parser.
def resolve_command(body, commands)
  first_line = body.to_s.split("\n", -1).first.to_s.delete("\r").strip
  role = commands[first_line]
  role ? [first_line, role] : [first_line, nil]
end

def gateway_policy
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  OfficeConfigResolver.new(OFFICE_DIR, profile: profile.empty? ? nil : profile).get("gateway") || {}
end

def gateway_faults(policy)
  faults = []
  faults << "gateway.enabled is not true" unless policy.is_a?(Hash) && policy["enabled"] == true
  cmds = policy.is_a?(Hash) ? policy["commands"] : nil
  unless cmds.is_a?(Hash) && !cmds.empty? && cmds.all? { |k, v| k.is_a?(String) && v.is_a?(String) }
    faults << "gateway.commands must be a non-empty mapping of literal command -> role"
  end
  faults
end

# ── Normalizers: BOTH produce this exact envelope shape ──────────────────────
#   source        String  caller-declared origin (checked by preflight trust)
#   delivery_id   String  idempotency key
#   external_ref  String? stable external identity ("owner/repo#17"), or nil
#   task_id       String? an EXPLICIT, already-resolved task reference, or nil
#   body          String  untrusted free text (context only — never parsed for
#                         config/trust/action/paths beyond the one command line)
#   meta          Hash    passthrough bookkeeping for the audit record only
ENVELOPE_KEYS = %w[source delivery_id external_ref task_id body meta].freeze

def envelope_faults(envelope)
  faults = []
  faults << "envelope must be a mapping" unless envelope.is_a?(Hash)
  return faults unless envelope.is_a?(Hash)

  faults << "envelope.source must be a non-empty string" unless envelope["source"].is_a?(String) && !envelope["source"].strip.empty?
  faults << "envelope.delivery_id must be a non-empty string" unless envelope["delivery_id"].is_a?(String) && !envelope["delivery_id"].strip.empty?
  faults << "envelope.body must be a string" unless envelope["body"].is_a?(String)
  unless envelope["external_ref"].nil? || envelope["external_ref"].is_a?(String)
    faults << "envelope.external_ref must be a string or absent"
  end
  unless envelope["task_id"].nil? || envelope["task_id"].is_a?(String)
    faults << "envelope.task_id must be a string or absent"
  end
  faults
end

# GitHub-shaped adapter. Takes an already-received issue_comment webhook body
# (a realistic subset: action, issue.number, comment.id, comment.body,
# repository.full_name, delivery_id) and produces the shared envelope. Does
# NOT verify a webhook signature and does NOT fetch anything over the network
# — that is out of scope for this issue (transport, not normalization).
#
# `delivery_id`: a real GitHub delivery carries this in the `X-GitHub-Delivery`
# HTTP header, not the JSON body, and header handling is transport (out of
# scope here). This adapter accepts it as an optional top-level `delivery_id`
# field for a caller that already extracted the header. Lacking that, it
# falls back to a STABLE hash of (repository, issue, comment, action) — stable
# under retries of the SAME delivery, but not distinct from a genuine edit
# that reuses the same comment id and action. That gap is intentional and
# documented as a limitation, not silently patched over with a random id
# (which would make every retry look new).
def normalize_github(payload)
  return { "_faults" => ["github payload must be a JSON/YAML mapping"] } unless payload.is_a?(Hash)

  action = payload["action"]
  issue = payload["issue"].is_a?(Hash) ? payload["issue"] : {}
  comment = payload["comment"].is_a?(Hash) ? payload["comment"] : {}
  repo = payload["repository"].is_a?(Hash) ? payload["repository"] : {}

  faults = []
  faults << "github payload missing repository.full_name" unless repo["full_name"].is_a?(String) && !repo["full_name"].strip.empty?
  faults << "github payload missing issue.number" unless issue["number"].is_a?(Integer)
  faults << "github payload missing comment.body" unless comment["body"].is_a?(String)
  return { "_faults" => faults } unless faults.empty?

  unless action == "created"
    return { "_faults" => ["unsupported github action '#{action}' (only 'created' comment events are handled)"] }
  end

  external_ref = "#{repo['full_name']}##{issue['number']}"
  delivery_id = payload["delivery_id"]
  delivery_id = "gh:#{Digest::SHA256.hexdigest("#{repo['full_name']}|#{issue['number']}|#{comment['id']}|#{action}")}" if delivery_id.to_s.strip.empty?

  {
    "source" => "github_issue_comment",
    "delivery_id" => delivery_id.to_s,
    "external_ref" => external_ref,
    "task_id" => nil, # GitHub events never carry a self-asserted task id — see docs/event-gateway.md
    "body" => comment["body"],
    "meta" => {
      "repository" => repo["full_name"],
      "issue_number" => issue["number"],
      "comment_id" => comment["id"],
      "action" => action
    }
  }
end

# Generic/test adapter: a small normalized YAML/JSON envelope, already close
# to the internal shape. This is what a future tester/task-board integration
# would produce, and what this repo's own tests drive directly. `task_id`, if
# present, is treated as an EXPLICIT reference the caller already resolved
# out-of-band (e.g. a task board that already knows its own mapping) — still
# subject to the same "must already exist" identity rule as everything else.
def normalize_test(payload)
  return { "_faults" => ["test envelope must be a mapping"] } unless payload.is_a?(Hash)

  envelope = {
    "source" => payload["source"],
    "delivery_id" => payload["delivery_id"],
    "external_ref" => payload["external_ref"],
    "task_id" => payload["task_id"],
    "body" => payload["body"],
    "meta" => payload["meta"].is_a?(Hash) ? payload["meta"] : {}
  }
  faults = envelope_faults(envelope)
  faults.empty? ? envelope : { "_faults" => faults }
end

def normalize(adapter, raw)
  envelope =
    case adapter
    when "github" then normalize_github(raw)
    when "test" then normalize_test(raw)
    else { "_faults" => ["unknown adapter '#{adapter}' (only 'github' or 'test')"] }
    end
  return envelope if envelope.key?("_faults")

  faults = envelope_faults(envelope)
  faults.empty? ? envelope.slice(*ENVELOPE_KEYS) : { "_faults" => faults }
end

# ── Idempotency store (runs/_gateway/ledger.yaml) ────────────────────────────
# WHY a store outside any task dir: duplicate delivery must be recognized even
# when the event never resolves to a task (a retried webhook for an
# unresolvable issue must not be re-processed N times and re-rejected N times
# as if each were new — see docs/event-gateway.md). A per-task ledger cannot
# hold that key before a task exists, so the delivery_id space lives in one
# place the whole pipeline can check first, before identity resolution even
# runs. Locked with the same flock-on-`.lock` idiom every other writer here
# uses (scripts/preflight.rb, scripts/task-ownership.rb, log_meta_event).
def load_ledger
  return { "events" => [] } unless File.exist?(LEDGER_PATH)

  doc = YAML.safe_load(File.read(LEDGER_PATH), permitted_classes: [Date, Time], aliases: true)
  doc.is_a?(Hash) && doc["events"].is_a?(Array) ? doc : { "events" => [] }
rescue Psych::SyntaxError
  # An unreadable ledger must not be treated as an empty one — that would
  # silently forget every duplicate it ever recorded and let a retry re-fire.
  raise "gateway ledger is unparseable: #{LEDGER_PATH}"
end

def save_ledger(doc)
  FileUtils.mkdir_p(GATEWAY_DIR)
  tmp = "#{LEDGER_PATH}.tmp.#{$$}"
  File.write(tmp, YAML.dump(doc))
  File.rename(tmp, LEDGER_PATH)
rescue StandardError
  File.delete(tmp) if tmp && File.exist?(tmp)
  raise
end

def with_gateway_lock(&block)
  FileUtils.mkdir_p(GATEWAY_DIR)
  with_task_lock(GATEWAY_DIR, &block) # reuses scripts/preflight.rb's helper verbatim
end

# Atomically: if delivery_id is already known, return its existing record
# (duplicate); otherwise reserve it with outcome "in_progress" so a second,
# concurrent call for the SAME delivery_id sees the reservation and not an
# empty ledger. This is what makes 3 concurrent submissions of one event
# collapse to exactly one dispatch: the reservation happens inside one flock,
# and flock serializes concurrent processes, not just threads.
def reserve_delivery(delivery_id, envelope)
  with_gateway_lock do
    doc = load_ledger
    existing = doc["events"].find { |e| e["delivery_id"] == delivery_id }
    next [:duplicate, existing] if existing

    record = {
      "delivery_id" => delivery_id,
      "source" => envelope["source"],
      "external_ref" => envelope["external_ref"],
      "received_at" => now_iso,
      "outcome" => "in_progress",
      "task_id" => nil,
      "stages" => [
        { "stage" => "intake", "outcome" => "accepted", "reason" => nil, "at" => now_iso }
      ]
    }
    doc["events"] << record
    save_ledger(doc)
    [:reserved, record]
  end
end

# Rewrites the ledger row for delivery_id with the given updates + an
# appended stage entry. Always runs under the gateway lock so a concurrent
# reader never observes a half-written record.
def finalize_delivery(delivery_id, outcome:, task_id: nil, stage:, stage_outcome:, reason: nil, extra: {})
  with_gateway_lock do
    doc = load_ledger
    record = doc["events"].find { |e| e["delivery_id"] == delivery_id }
    next nil unless record

    record["outcome"] = outcome
    record["task_id"] = task_id if task_id
    record["stages"] << { "stage" => stage, "outcome" => stage_outcome, "reason" => reason, "at" => now_iso }.merge(extra)
    save_ledger(doc)
    record
  end
end

# Mirrors the finalized record into runs/<task>/gateway-events.yaml — the
# per-task audit trail, colocated the way evidence.yaml and ownership.yaml
# are colocated with their task. Deliberately best-effort AFTER the ledger
# write: the ledger (not this mirror) is the idempotency source of truth, so
# a crash between the two leaves dedup intact and only the mirror stale — the
# opposite failure (a stale idempotency record) is the one that would let a
# duplicate mutate the repo twice.
def mirror_to_task(task_id, record)
  task_dir = File.join(RUNS_DIR, task_id)
  return unless File.directory?(task_dir)

  path = File.join(task_dir, "gateway-events.yaml")
  with_task_lock(task_dir) do
    doc = File.exist?(path) ? (YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}) : {}
    doc["task_id"] ||= task_id
    doc["events"] = [] unless doc["events"].is_a?(Array)
    doc["events"].reject! { |e| e["delivery_id"] == record["delivery_id"] }
    doc["events"] << record
    doc["updated_at"] = now_iso
    tmp = "#{path}.tmp.#{$$}"
    File.write(tmp, YAML.dump(doc))
    File.rename(tmp, path)
  end
end

# ── Identity resolution ───────────────────────────────────────────────────────
def load_mapping
  return {} unless File.exist?(MAPPING_PATH)

  doc = YAML.safe_load(File.read(MAPPING_PATH), permitted_classes: [Date, Time], aliases: true)
  doc.is_a?(Hash) ? doc : {}
rescue Psych::SyntaxError
  raise "gateway external-ref mapping is unparseable: #{MAPPING_PATH}"
end

def save_mapping(doc)
  FileUtils.mkdir_p(GATEWAY_DIR)
  tmp = "#{MAPPING_PATH}.tmp.#{$$}"
  File.write(tmp, YAML.dump(doc))
  File.rename(tmp, MAPPING_PATH)
rescue StandardError
  File.delete(tmp) if tmp && File.exist?(tmp)
  raise
end

def mint_task_id
  used = Dir.glob(File.join(RUNS_DIR, "#{MINT_PREFIX}-*")).map do |dir|
    match = File.basename(dir).match(/\A#{Regexp.escape(MINT_PREFIX)}-(\d+)\z/)
    match ? match[1].to_i : 0
  end
  "#{MINT_PREFIX}-#{used.max.to_i + 1}"
end

# Returns one of:
#   [:resolved, task_id]     an existing, resolvable task — dispatch proceeds
#   [:mint, external_ref]    only for the pm/triage command — a NEW id may be
#                             minted, but only AFTER the preflight pre-check
#   [:reject, reason]        cannot be resolved deterministically — refuse
#
# Never guesses. An explicit task_id must already be a real, existing task
# dir. An external_ref must already be in the maintained mapping UNLESS the
# resolved command is the one designated to create new tasks (`pm`, reached
# only via the literal `/agent triage`) — anything else with no mapping is
# rejected rather than assigned a fresh id from unreviewed text.
def resolve_identity(envelope, role)
  explicit = envelope["task_id"]
  if explicit
    return [:reject, "envelope.task_id '#{explicit}' does not match the task id pattern"] unless explicit.match?(TASK_ID_PATTERN)
    return [:reject, "task '#{explicit}' does not exist; the gateway does not create tasks from an explicit id"] unless File.directory?(File.join(RUNS_DIR, explicit))

    return [:resolved, explicit]
  end

  ref = envelope["external_ref"].to_s.strip
  return [:reject, "event carries no task_id and no external_ref; identity is not resolvable"] if ref.empty?

  mapped = load_mapping[ref]
  return [:resolved, mapped] if mapped && File.directory?(File.join(RUNS_DIR, mapped))

  return [:mint, ref] if role == "pm"

  [:reject, "external_ref '#{ref}' has no existing task mapping (only '/agent triage' may create one)"]
end

# Mints (or, under a race, reuses a concurrently-minted) id for `ref` and
# records the mapping — all inside one lock so two triage events for the same
# ref can never mint two tasks.
def mint_and_map(ref)
  with_gateway_lock do
    mapping = load_mapping
    next mapping[ref] if mapping[ref] # a concurrent caller minted first

    task_id = mint_task_id
    mapping[ref] = task_id
    save_mapping(mapping)
    task_id
  end
end

# ── Dispatch: hand off to the REAL gate (run-agent.sh), never a shortcut ─────
# Sets exactly the env-var contract run-agent.sh already reads
# (AI_DEV_OFFICE_INPUT_SOURCE / _REQUESTED_ACTION / _INPUT_FILE / _INPUT_REF /
# _REQUESTED_PATHS) and invokes it normally. `_REQUESTED_PATHS` is
# DELIBERATELY never set: the gateway never derives a path scope from event
# text, so every gateway-triggered request is "undeclared scope" and takes
# preflight's undeclared_scope_sensitivity floor. `_REQUESTED_ACTION` is also
# left unset: the action is whatever preflight.role_actions resolves for the
# role, exactly as the gateway's own pre-check computed it — never a second,
# independently-declared value that could drift from the first.
def dispatch(task_id, role, envelope)
  body_file = Tempfile.new(["gateway-input-", ".txt"])
  body_file.write(envelope["body"].to_s)
  body_file.flush

  env = {
    "AI_DEV_OFFICE_INPUT_SOURCE" => envelope["source"],
    "AI_DEV_OFFICE_INPUT_FILE" => body_file.path
  }
  env["AI_DEV_OFFICE_INPUT_REF"] = envelope["external_ref"] if envelope["external_ref"]

  ok = system(env, File.join(OFFICE_DIR, "run-agent.sh"), task_id, role)
  rc = ok ? 0 : ($?.nil? ? 1 : $?.exitstatus) # rubocop-style: Process::Status of the last system() call
  [ok, rc]
ensure
  body_file&.close
  body_file&.unlink
end

# ── The pipeline ──────────────────────────────────────────────────────────────
OUTCOME_EXIT = {
  "dispatched" => 0,
  "dispatch_failed" => 1,
  "duplicate" => 10,
  "rejected_command" => 11,
  "rejected_identity" => 12,
  "rejected_preflight" => 13,
  "rejected_malformed" => 14
}.freeze

# Returns [outcome, delivery_id_or_nil, detail]. Never raises — a failure the
# pipeline did not anticipate is a rejected_malformed, not a crash (mirrors
# scripts/preflight.rb's decide_or_deny total guard).
def run_pipeline(adapter, raw, dry_run: false)
  envelope = normalize(adapter, raw)
  if envelope.key?("_faults")
    return ["rejected_malformed", nil, envelope["_faults"].join("; ")]
  end

  delivery_id = envelope["delivery_id"]
  status, reserved = reserve_delivery(delivery_id, envelope)
  if status == :duplicate
    return ["duplicate", delivery_id, "delivery_id already recorded with outcome=#{reserved['outcome']}"]
  end

  gpolicy = gateway_policy
  gfaults = gateway_faults(gpolicy)
  if !gfaults.empty?
    finalize_delivery(delivery_id, outcome: "rejected_command", stage: "command", stage_outcome: "rejected", reason: gfaults.join("; "))
    return ["rejected_command", delivery_id, gfaults.join("; ")]
  end

  first_line, role = resolve_command(envelope["body"], gpolicy["commands"])
  unless role
    reason = "no recognized command (first line: #{first_line.inspect})"
    finalize_delivery(delivery_id, outcome: "rejected_command", stage: "command", stage_outcome: "rejected", reason: reason)
    return ["rejected_command", delivery_id, reason]
  end
  finalize_delivery(delivery_id, outcome: "in_progress", stage: "command", stage_outcome: "resolved", reason: nil, extra: { "command" => first_line, "role" => role })

  action, ref_or_task = resolve_identity(envelope, role)
  task_id =
    case action
    when :resolved
      finalize_delivery(delivery_id, outcome: "in_progress", task_id: ref_or_task, stage: "resolve", stage_outcome: "resolved", reason: nil)
      ref_or_task
    when :mint
      finalize_delivery(delivery_id, outcome: "in_progress", stage: "resolve", stage_outcome: "pending_mint", reason: nil, extra: { "external_ref" => ref_or_task })
      nil # minted only after the preflight pre-check passes
    when :reject
      finalize_delivery(delivery_id, outcome: "rejected_identity", stage: "resolve", stage_outcome: "rejected", reason: ref_or_task)
      return ["rejected_identity", delivery_id, ref_or_task]
    end

  # ── The pre-check (docs/event-gateway.md "Ordering"): a LIBRARY call to
  # #17's own decision function, computed with the identical request the
  # driver will use, BEFORE run-agent.sh (and therefore before its `pm`
  # mkdir) ever runs. This is what keeps an unvetted event from creating even
  # an empty task directory: nothing below this line touches the filesystem
  # under a task id until this check has passed.
  policy = resolved_policy
  precheck_source = envelope["source"]
  request = { "source" => precheck_source, "role" => role, "paths" => [] }
  if envelope["external_ref"]
    request["external_ref"] = envelope["external_ref"]
  end
  body_file = Tempfile.new(["gateway-precheck-", ".txt"])
  begin
    body_file.write(envelope["body"].to_s)
    body_file.flush
    request["input_file"] = body_file.path
    decision = decide_or_deny(request)
  ensure
    body_file.close
    body_file.unlink
  end

  unless %w[allow allow_with_deep_review].include?(decision["outcome"])
    reason = "preflight pre-check outcome=#{decision['outcome']}: #{decision['rationale']}"
    finalize_delivery(delivery_id, outcome: "rejected_preflight", task_id: task_id, stage: "dispatch",
                       stage_outcome: "refused", reason: reason,
                       extra: { "injection_signals" => decision.dig("input", "injection_signals") || [] })
    mirror_to_task(task_id, load_ledger["events"].find { |e| e["delivery_id"] == delivery_id }) if task_id
    return ["rejected_preflight", delivery_id, reason]
  end

  if action == :mint
    task_id = mint_and_map(ref_or_task)
    finalize_delivery(delivery_id, outcome: "in_progress", task_id: task_id, stage: "resolve", stage_outcome: "minted", reason: nil, extra: { "external_ref" => ref_or_task })
  end

  if dry_run
    finalize_delivery(delivery_id, outcome: "dispatched", task_id: task_id, stage: "dispatch", stage_outcome: "dry_run", reason: nil, extra: { "role" => role })
    mirror_to_task(task_id, load_ledger["events"].find { |e| e["delivery_id"] == delivery_id })
    return ["dispatched", delivery_id, "dry_run: would dispatch #{task_id} as #{role}"]
  end

  ok, rc = dispatch(task_id, role, envelope)
  outcome = ok ? "dispatched" : "dispatch_failed"
  finalize_delivery(delivery_id, outcome: outcome, task_id: task_id, stage: "dispatch", stage_outcome: ok ? "dispatched" : "failed",
                     reason: ok ? nil : "run-agent.sh exited #{rc}", extra: { "role" => role, "exit_code" => rc })
  mirror_to_task(task_id, load_ledger["events"].find { |e| e["delivery_id"] == delivery_id })
  [outcome, delivery_id, ok ? "dispatched #{task_id} as #{role}" : "run-agent.sh exited #{rc}"]
rescue StandardError, ScriptError => e
  ["rejected_malformed", envelope.is_a?(Hash) ? envelope["delivery_id"] : nil, "gateway pipeline raised #{e.class}: #{e.message}"]
end

if $PROGRAM_NAME == __FILE__
  command = ARGV.shift
  die "usage: event-gateway.rb handle --adapter <github|test> --input-file <f> [--dry-run]" unless command == "handle"

  adapter = nil
  input_file = nil
  dry_run = false
  until ARGV.empty?
    flag = ARGV.shift
    case flag
    when "--adapter" then adapter = ARGV.shift
    when "--input-file" then input_file = ARGV.shift
    when "--dry-run" then dry_run = true
    else die "unknown argument '#{flag}'"
    end
  end
  die "--adapter is required" if adapter.to_s.strip.empty?
  die "--input-file is required" if input_file.to_s.strip.empty?

  raw =
    begin
      text = File.read(input_file)
      if input_file.end_with?(".json")
        JSON.parse(text)
      else
        YAML.safe_load(text, permitted_classes: [Date, Time], aliases: true) || JSON.parse(text)
      end
    rescue StandardError => e
      die "could not read/parse --input-file: #{e.message}", 14
    end

  outcome, delivery_id, detail = run_pipeline(adapter, raw, dry_run: dry_run)
  warn "event-gateway: #{detail}" unless outcome == "dispatched"
  puts "#{delivery_id || 'none'} #{outcome}"
  exit OUTCOME_EXIT.fetch(outcome, 14)
end
