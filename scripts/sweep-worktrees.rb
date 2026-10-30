#!/usr/bin/env ruby
# frozen_string_literal: true

# Sweeps what agents leave behind across the workspace repos: linked worktrees whose
# work is merged, and (with --branches) local branches already merged. Read-only by
# default; --apply removes. Stashes (--stashes) are only listed: they may hold someone's
# unfinished work, so dropping one stays a person's decision.
#
# ruby scripts/sweep-worktrees.rb [--root DIR] [--apply] [--branches] [--stashes] [--min-idle-hours N]
#
# A worktree is removed only when all hold, otherwise it is kept with the reason:
# - its repo is not read-only, and it is not the repo's main checkout, not locked,
#   and not recorded in <root>/.worktrees/.dashboard-worktrees.json (the dashboard
#   cleans those up itself);
# - its HEAD is in origin's main/master/staging/prod (as of the last fetch);
# - it has no changes besides untracked build output (node_modules, .nuxt, dist, ...);
# - nothing touched it for --min-idle-hours (default 24), so a session still working
#   in it is left alone.
# A worktree whose directory is gone is pruned. A branch is deleted only when its tip
# is in one of those origin branches and no worktree has it checked out. A kept
# worktree under /tmp gets a warning line: macOS purges files there after 3 days.

require "json"
require "open3"
require "set"

READ_ONLY_REPOS = %w[Games-Lab-Android].freeze
# macOS's daily periodic job deletes files under /tmp not accessed for 3 days and leaves the
# directories, so uncommitted work in a worktree there disappears (TASK-VS-004 lost its
# slip-system diff this way on 2026-10-31).
PURGED_TEMP = %r{\A/(private/)?tmp/}
BASE_BRANCHES = %w[main master staging prod production develop].freeze
REGENERABLE = %r{\A(node_modules|\.nuxt|\.output|dist|build|coverage|\.cache|\.turbo|\.vite)/}

def usage(message)
  warn "sweep-worktrees: #{message}"
  warn "usage: sweep-worktrees.rb [--root DIR] [--apply] [--branches] [--stashes] [--min-idle-hours N]"
  exit 2
end

opts = { root: File.expand_path("../..", __dir__), apply: false, branches: false, stashes: false, idle: 24.0 }
args = ARGV.dup
until args.empty?
  case (arg = args.shift)
  when "--root" then opts[:root] = File.expand_path(args.shift || usage("--root needs a value"))
  when "--apply" then opts[:apply] = true
  when "--branches" then opts[:branches] = true
  when "--stashes" then opts[:stashes] = true
  when "--min-idle-hours"
    value = args.shift
    usage("--min-idle-hours needs a number") unless value&.match?(/\A\d+(\.\d+)?\z/)
    opts[:idle] = value.to_f
  else usage("unknown argument #{arg.inspect}")
  end
end
usage("no such directory #{opts[:root]}") unless File.directory?(opts[:root])

def git(dir, *args)
  out, status = Open3.capture2e("git", "-C", dir, *args)
  [out, status.success?]
end

def ancestor?(repo, commit, ref)
  _, ok = git(repo, "merge-base", "--is-ancestor", commit, ref)
  ok
end

# Main checkouts directly under root: their git dir is <dir>/.git (a linked worktree's is not).
def main_repos(root)
  Dir.children(root).sort.map do |name|
    dir = File.join(root, name)
    next unless File.directory?(File.join(dir, ".git"))
    next if READ_ONLY_REPOS.include?(name)

    dir
  end.compact
end

def origin_bases(repo)
  out, = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin")
  out.lines.map(&:strip).select { |ref| BASE_BRANCHES.include?(ref.delete_prefix("origin/")) }
end

def worktrees(repo)
  out, = git(repo, "worktree", "list", "--porcelain")
  out.split("\n\n").map do |block|
    entry = {}
    block.each_line do |line|
      key, value = line.chomp.split(" ", 2)
      entry[key] = value || true
    end
    entry
  end
end

def dashboard_paths(root)
  file = File.join(root, ".worktrees", ".dashboard-worktrees.json")
  return Set.new unless File.file?(file)

  Set.new(Array(JSON.parse(File.read(file))["worktrees"]).map { |w| w["path"] && canonical(w["path"]) }.compact)
rescue JSON::ParserError
  Set.new
end

# git reports resolved paths (/private/var/...) where a record may hold the symlinked one (/var/...).
def canonical(path)
  File.realpath(path)
rescue SystemCallError
  File.expand_path(path)
end

def idle_hours(path)
  git_dir, ok = git(path, "rev-parse", "--absolute-git-dir")
  index = File.join(git_dir.strip, "index") if ok
  touched = [index, path].compact.select { |p| File.exist?(p) }.map { |p| File.mtime(p) }.max
  touched ? (Time.now - touched) / 3600.0 : Float::INFINITY
end

def local_changes(path)
  out, = git(path, "status", "--porcelain", "--untracked-files=normal")
  out.lines.map(&:chomp).reject { |line| line.start_with?("?? ") && line[3..].match?(REGENERABLE) }
end

def verdict(repo, wt, bases, dashboard, idle_limit)
  path = wt["worktree"]
  return [:prune, "directory missing"] if wt.key?("prunable") || !File.directory?(path)
  return [:keep, "locked"] if wt.key?("locked")
  return [:keep, "dashboard-managed"] if dashboard.include?(canonical(path))

  head = wt["HEAD"]
  merged_into = bases.find { |base| ancestor?(repo, head, base) }
  return [:keep, "not merged into #{bases.empty? ? 'any origin base' : bases.join('|')}"] unless merged_into

  changes = local_changes(path)
  return [:keep, "uncommitted changes (#{changes.size})"] unless changes.empty?

  idle = idle_hours(path)
  return [:keep, format("recently used (%.1fh ago)", idle)] if idle < idle_limit

  [:remove, "merged into #{merged_into}"]
end

root = opts[:root]
dashboard = dashboard_paths(root)
removed = kept = pruned = deleted = 0
main_repos(root).each do |repo|
  name = File.basename(repo)
  bases = origin_bases(repo)
  linked = worktrees(repo).drop(1)
  checked_out = Set.new(worktrees(repo).map { |w| w["branch"]&.delete_prefix("refs/heads/") }.compact)

  linked.each do |wt|
    action, reason = verdict(repo, wt, bases, dashboard, opts[:idle])
    branch = wt["branch"]&.delete_prefix("refs/heads/") || "(detached)"
    puts "#{action} #{name} #{wt['worktree']} [#{branch}] #{reason}"
    if action == :keep && wt["worktree"].match?(PURGED_TEMP)
      puts "warn #{name} #{wt['worktree']} is under /tmp: macOS deletes files there after 3 days; commit and push its work"
    end
    next unless opts[:apply]

    case action
    when :remove
      _, ok = git(repo, "worktree", "remove", "--force", wt["worktree"])
      ok ? removed += 1 : warn("could not remove #{wt['worktree']}")
    when :prune then pruned += 1
    else kept += 1
    end
  end
  git(repo, "worktree", "prune") if opts[:apply] && linked.any? { |wt| verdict(repo, wt, bases, dashboard, opts[:idle]).first == :prune }

  if opts[:branches]
    out, = git(repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")
    out.lines.map(&:split).each do |branch, sha|
      next if BASE_BRANCHES.include?(branch) || checked_out.include?(branch)
      next unless (base = bases.find { |b| ancestor?(repo, sha, b) })

      puts "delete branch #{name} #{branch}"
      next unless opts[:apply]

      _, ok = git(repo, "branch", "-D", branch)
      ok ? deleted += 1 : warn("could not delete #{name} #{branch} (merged into #{base})")
    end
  end

  next unless opts[:stashes]

  out, = git(repo, "stash", "list", "--format=%gd %ci %gs")
  out.each_line { |line| puts "stash #{name} #{line.chomp}" }
end

puts(opts[:apply] ? "applied: #{removed} removed, #{pruned} pruned, #{deleted} branches deleted" : "dry run: nothing changed (add --apply)")
