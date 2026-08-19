#!/usr/bin/env ruby
# frozen_string_literal: true

# Task input integrity (issue #22, docs/task-input-integrity.md).
#
# Three consecutive audits defeated the review gate (issue #12) by editing the
# files the gate reads its ground truth from, not by breaking the gate's own
# rules: deleting dev-output.yaml/meta.yaml/status.yaml history, rewriting
# history[0].agent, rewriting dev-output.yaml's declared paths. Every one of
# those inputs lives in the same task directory the runner subprocess has
# file_write:true over. This module hashes the protected file set BEFORE the
# runner subprocess starts and compares it AFTER — a mismatch is a hard,
# recorded failure (docs/task-input-integrity.md), not a rule the reviewer's
# own output can talk its way around.
#
# Two hook points, both driven from run-agent.sh:
#   snapshot <task_dir> <task_id> <agent> <snapshot_file>   (before the runner subprocess)
#   verify   <task_dir> <task_id> <agent> <snapshot_file>   (after it returns, before output is trusted)
#
# Exit codes: 0 clean; 9 TAMPERED (a protected input changed); 3 could not
# snapshot/verify at all (STORE_ERROR — missing/unreadable snapshot file,
# unreadable protected file, malformed config). Both 9 and 3 are meant to be
# treated as a hard dispatch failure by the caller — see the doc's "fail
# closed" section for exactly what each represents.

require "yaml"
require "date"
require "digest"

module TaskInputIntegrity
  RECORD_FILENAME = "task-input-integrity.yaml"
  ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
  TAMPERED = 9
  STORE_ERROR = 3

  DEFAULT_FROZEN_FILES = %w[
    status.yaml meta.yaml preflight.yaml evidence-freshness.yaml gateway-events.yaml
  ].freeze
  DEFAULT_APPEND_ONLY_FILES = [{ "path" => "evidence.yaml", "entries_key" => "evidence" }].freeze

  Failure = Class.new(StandardError)

  module_function

  def now
    Time.now.utc
  end

  def iso(time)
    time.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
  end

  def with_lock(dir, name)
    lock = File.open(File.join(dir, name), File::RDWR | File::CREAT, 0o644)
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

  def load_yaml_relaxed(path)
    return nil unless File.exist?(path)

    YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  rescue Psych::SyntaxError, ArgumentError, Errno::EACCES, Errno::ENOENT
    :unreadable
  end

  # ── Config resolution ────────────────────────────────────────────────────
  # A malformed office.config.yaml already makes OfficeConfigResolver's own
  # loader `exit 1` (see resolve-office-config.rb#load_yaml) — that IS the
  # fail-closed behaviour this module wants when config cannot be trusted, so
  # it is allowed to propagate rather than being rescued here.
  def resolve_config(office_dir, profile)
    require_relative "resolve-office-config"
    resolver = OfficeConfigResolver.new(office_dir, profile: profile)

    enabled_raw = resolver.get("task_input_integrity.enabled", "true").to_s.strip.downcase
    enabled = %w[true yes on 1].include?(enabled_raw)

    frozen_files = Array(resolver.get("task_input_integrity.frozen_files", nil))
    frozen_files = DEFAULT_FROZEN_FILES if frozen_files.empty?

    append_only_raw = resolver.get("task_input_integrity.append_only_files", nil)
    append_only_files = Array(append_only_raw).map do |entry|
      next nil unless entry.is_a?(Hash) && entry["path"].to_s.strip != ""

      { "path" => entry["path"].to_s, "entries_key" => (entry["entries_key"] || "evidence").to_s }
    end.compact
    append_only_files = DEFAULT_APPEND_ONLY_FILES if append_only_files.empty?

    protect_role_outputs_raw = resolver.get("task_input_integrity.protect_role_outputs", "true").to_s.strip.downcase
    protect_role_outputs = %w[true yes on 1].include?(protect_role_outputs_raw)

    protect_run_records_raw = resolver.get("task_input_integrity.protect_run_records", "true").to_s.strip.downcase
    protect_run_records = %w[true yes on 1].include?(protect_run_records_raw)

    {
      enabled: enabled,
      frozen_files: frozen_files.map(&:to_s),
      append_only_files: append_only_files,
      protect_role_outputs: protect_role_outputs,
      protect_run_records: protect_run_records
    }
  end

  # ── The protected set, resolved for ONE dispatch ─────────────────────────
  # Bounded by construction: a handful of fixed filenames, at most
  # ROLES.length-1 role-output files, one append-only ledger's OWN entry
  # count (not the whole task's history), and the CURRENT set of
  # run-records/*.yaml filenames (existence check only — see
  # office.config.yaml's comment on why content is not hashed there). Nothing
  # here scales with the task's total dispatch count except that last,
  # cheap, filename-only listing.
  def resolve_targets(task_dir, agent, run_id, cfg)
    frozen = cfg[:frozen_files].dup

    if cfg[:protect_role_outputs]
      (ROLES - [agent.to_s]).each { |role| frozen << "#{role}-output.yaml" }
    end

    run_record_names = []
    if cfg[:protect_run_records]
      current = run_id.to_s.strip.empty? ? nil : "#{run_id}.yaml"
      Dir.glob(File.join(task_dir, "run-records", "*.yaml")).sort.each do |path|
        name = File.basename(path)
        next if name == current

        run_record_names << name
      end
    end

    { frozen: frozen.uniq, append_only: cfg[:append_only_files], run_records: run_record_names }
  end

  # ── Snapshot ──────────────────────────────────────────────────────────────
  def file_fingerprint(path)
    return { "exists" => false } unless File.exist?(path)

    begin
      { "exists" => true, "sha256" => Digest::SHA256.file(path).hexdigest }
    rescue Errno::EACCES, Errno::ENOENT => e
      raise Failure, "cannot read #{path} to snapshot it (#{e.message})"
    end
  end

  def append_only_fingerprint(path, entries_key)
    return { "exists" => false, "hashes" => [] } unless File.exist?(path)

    data = load_yaml_relaxed(path)
    raise Failure, "cannot read #{path} to snapshot it" if data == :unreadable
    raise Failure, "#{path} is not a mapping; cannot snapshot its #{entries_key} ledger" unless data.is_a?(Hash)

    entries = Array(data[entries_key])
    { "exists" => true, "hashes" => entries.map { |e| Digest::SHA256.hexdigest(YAML.dump(e)) } }
  end

  def snapshot(task_dir, task_id, agent, run_id, office_dir, profile)
    cfg = resolve_config(office_dir, profile)
    snap = {
      "task_id" => task_id, "agent" => agent, "run_id" => run_id,
      "taken_at" => iso(now), "enabled" => cfg[:enabled], "files" => {}, "append_only" => {},
      "run_records" => []
    }
    return snap unless cfg[:enabled]

    targets = resolve_targets(task_dir, agent, run_id, cfg)
    targets[:frozen].each do |rel|
      snap["files"][rel] = file_fingerprint(File.join(task_dir, rel))
    end
    targets[:append_only].each do |entry|
      snap["append_only"][entry["path"]] = append_only_fingerprint(File.join(task_dir, entry["path"]), entry["entries_key"])
                                             .merge("entries_key" => entry["entries_key"])
    end
    snap["run_records"] = targets[:run_records]
    snap
  end

  # ── Verify ────────────────────────────────────────────────────────────────
  def verify_frozen(task_dir, rel, baseline)
    path = File.join(task_dir, rel)
    now_fp = file_fingerprint(path)

    if baseline["exists"] && !now_fp["exists"]
      return { "path" => rel, "kind" => "deleted", "old_sha256" => baseline["sha256"], "new_sha256" => nil }
    end
    if !baseline["exists"] && now_fp["exists"]
      return { "path" => rel, "kind" => "appeared", "old_sha256" => nil, "new_sha256" => now_fp["sha256"] }
    end
    if baseline["exists"] && now_fp["exists"] && baseline["sha256"] != now_fp["sha256"]
      return { "path" => rel, "kind" => "modified", "old_sha256" => baseline["sha256"], "new_sha256" => now_fp["sha256"] }
    end
    nil
  rescue Failure => e
    { "path" => rel, "kind" => "unreadable", "old_sha256" => baseline["sha256"], "new_sha256" => nil, "detail" => e.message }
  end

  def verify_append_only(task_dir, rel, baseline)
    path = File.join(task_dir, rel)
    entries_key = baseline["entries_key"] || "evidence"
    old_hashes = Array(baseline["hashes"])

    unless File.exist?(path)
      return nil unless baseline["exists"]

      return { "path" => rel, "kind" => "deleted", "old_count" => old_hashes.length, "new_count" => 0 }
    end

    data = load_yaml_relaxed(path)
    if data == :unreadable
      return { "path" => rel, "kind" => "unreadable", "old_count" => old_hashes.length, "new_count" => nil }
    end
    unless data.is_a?(Hash)
      return { "path" => rel, "kind" => "malformed", "old_count" => old_hashes.length, "new_count" => nil }
    end

    now_hashes = Array(data[entries_key]).map { |e| Digest::SHA256.hexdigest(YAML.dump(e)) }
    if now_hashes.length < old_hashes.length
      return { "path" => rel, "kind" => "truncated", "old_count" => old_hashes.length, "new_count" => now_hashes.length }
    end
    old_hashes.each_with_index do |h, i|
      next if now_hashes[i] == h

      return { "path" => rel, "kind" => "rewritten", "old_count" => old_hashes.length,
                "new_count" => now_hashes.length, "first_diverging_index" => i }
    end
    nil
  end

  def verify_run_records(task_dir, baseline_names)
    baseline_names.filter_map do |name|
      path = File.join(task_dir, "run-records", name)
      next nil if File.exist?(path)

      { "path" => "run-records/#{name}", "kind" => "deleted", "old_sha256" => nil, "new_sha256" => nil }
    end
  end

  def verify(task_dir, task_id, agent, run_id, snapshot_path)
    raise Failure, "no snapshot file recorded (#{snapshot_path.inspect}); cannot verify without a baseline" \
      if snapshot_path.to_s.strip.empty? || !File.exist?(snapshot_path)

    snap = load_yaml_relaxed(snapshot_path)
    raise Failure, "snapshot file #{snapshot_path} is unreadable/malformed; refusing to verify without a trusted baseline" \
      if snap == :unreadable || !snap.is_a?(Hash)

    return { "ok" => true, "mismatches" => [], "enabled" => false } unless snap["enabled"]

    mismatches = []
    Hash(snap["files"]).each do |rel, baseline|
      m = verify_frozen(task_dir, rel, baseline)
      mismatches << m if m
    end
    Hash(snap["append_only"]).each do |rel, baseline|
      m = verify_append_only(task_dir, rel, baseline)
      mismatches << m if m
    end
    mismatches.concat(verify_run_records(task_dir, Array(snap["run_records"])))

    { "ok" => mismatches.empty?, "mismatches" => mismatches, "enabled" => true }
  end

  # ── Audit record (runs/<task>/task-input-integrity.yaml) ────────────────
  def record_result(task_dir, task_id, agent, run_id, result)
    path = File.join(task_dir, RECORD_FILENAME)
    with_lock(task_dir, ".lock") do
      doc = if File.exist?(path)
        YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
      else
        {}
      end
      doc["task_id"] ||= task_id
      doc["checks"] = [] unless doc["checks"].is_a?(Array)
      doc["checks"] << {
        "at" => iso(now),
        "agent" => agent,
        "run_id" => (run_id.to_s.empty? ? nil : run_id),
        "enabled" => result["enabled"],
        "verdict" => result["ok"] ? "ok" : "tampered",
        "mismatches" => result["mismatches"]
      }
      doc["updated_at"] = iso(now)
      write_atomic(path, doc)
    end
  end
end

# ── CLI ────────────────────────────────────────────────────────────────────
if $PROGRAM_NAME == __FILE__
  def die(message, code = TaskInputIntegrity::STORE_ERROR)
    warn "[task-input-integrity] #{message}"
    exit code
  end

  command = ARGV.shift
  task_dir, task_id, agent, snapshot_path = ARGV.shift(4)
  extra = ARGV
  office_dir = nil
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  profile = nil if profile.empty?
  i = 0
  while i < extra.length
    case extra[i]
    when "--office-dir" then office_dir = extra[i + 1]; i += 2
    when "--profile" then profile = extra[i + 1]; i += 2
    else i += 1
    end
  end
  office_dir ||= ENV["AI_DEV_OFFICE_HOME"] || File.expand_path("..", __dir__)

  die "usage: task-input-integrity.rb snapshot|verify <task_dir> <task_id> <agent> <snapshot_file> [--office-dir DIR] [--profile P]", 2 \
    if command.nil? || task_dir.nil? || task_id.nil? || agent.nil? || snapshot_path.nil?
  die "task dir not found: #{task_dir}" unless File.directory?(task_dir)

  run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s

  case command
  when "snapshot"
    begin
      snap = TaskInputIntegrity.snapshot(task_dir, task_id, agent, run_id, office_dir, profile)
    rescue TaskInputIntegrity::Failure => e
      die "could not take baseline snapshot: #{e.message}"
    rescue StandardError => e
      die "could not take baseline snapshot (#{e.class}): #{e.message}"
    end
    begin
      File.write(snapshot_path, YAML.dump(snap))
    rescue StandardError => e
      die "could not write snapshot to #{snapshot_path}: #{e.message}"
    end
    puts "snapshot written: #{snapshot_path} (enabled=#{snap['enabled']} files=#{snap['files'].size} " \
         "append_only=#{snap['append_only'].size} run_records=#{snap['run_records'].size})"

  when "verify"
    result = begin
      TaskInputIntegrity.verify(task_dir, task_id, agent, run_id, snapshot_path)
    rescue TaskInputIntegrity::Failure => e
      die "could not verify against baseline: #{e.message}"
    end

    unless result["enabled"]
      puts "task input integrity: disabled at snapshot time, nothing to verify"
      exit 0
    end

    TaskInputIntegrity.record_result(task_dir, task_id, agent, run_id, result)

    if result["ok"]
      puts "task input integrity: ok (0 mismatches)"
      exit 0
    end

    warn "[task-input-integrity] TAMPERED: #{result['mismatches'].length} protected input(s) changed during dispatch:"
    result["mismatches"].each do |m|
      warn "  - #{m['path']}: #{m['kind']} (old=#{m['old_sha256'] || m['old_count']} new=#{m['new_sha256'] || m['new_count']})"
    end
    exit TaskInputIntegrity::TAMPERED

  else
    die "unknown command: #{command} (use snapshot|verify)", 2
  end
end
