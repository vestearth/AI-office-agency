#!/usr/bin/env bash
# office-git-sync.sh — opt-in git auto-sync for multi-user mode
# (docs/multi-user-git.md). run-agent.sh calls this around every dispatch so
# the manual pull/push ritual disappears once git_sync.enabled is true.
#
# Subcommands:
#   pull                    rebase-pull the office repo
#   push <task-id> [label]  commit runs/<task-id> (+ office.team.yaml) and push
#   enabled                 exit 0 if git sync is on, 1 otherwise
#
# Soft-fail contract: pull/push NEVER exit nonzero on git/network trouble —
# they warn on stderr and exit 0 so a flaky network can't block agent work.
# A failed push still leaves the commit local; the next push catches up. The
# tree is ALSO never left mid-rebase or with conflict markers: a stuck rebase
# is aborted, an autostash-pop conflict is rolled back to upstream content,
# and a conflicted office.team.yaml is never staged for publish.
#
# Enablement: env OFFICE_GIT_SYNC=1/0 overrides config git_sync.enabled.
# Push/pull always target the current branch's configured upstream.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# OFFICE_GIT_SYNC_ROOT is a test hook: integration tests point it at a sandbox.
OFFICE_DIR="${OFFICE_GIT_SYNC_ROOT:-$(dirname "$SCRIPT_DIR")}"
CONFIG_RESOLVER="$SCRIPT_DIR/resolve-office-config.rb"

warn() { echo "[git-sync] $*" >&2; }

git_office() { git -C "$OFFICE_DIR" "$@"; }

sync_enabled() {
  case "${OFFICE_GIT_SYNC:-}" in
    1|true|TRUE|yes) return 0 ;;
    0|false|FALSE|no) return 1 ;;
  esac
  local v
  # Keep the soft-fail contract (never block) but don't go silent: a broken
  # office.config.local.yaml shouldn't disable sync with zero signal.
  if ! v="$(ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" git_sync.enabled false 2>&1)"; then
    warn "config resolver failed (${v//$'\n'/ }); treating git sync as disabled"
    return 1
  fi
  [[ "$v" == "true" ]]
}

# Absolute git common dir, so rebase-state checks are independent of the
# caller's cwd — run-agent.sh runs from the workspace root, not OFFICE_DIR, so
# a cwd-relative `.git/rebase-merge` test would probe the wrong repo.
git_common_dir() { git_office rev-parse --absolute-git-dir 2>/dev/null; }

rebase_in_progress() {
  local gd
  gd="$(git_common_dir)" || return 1
  [[ -n "$gd" && ( -d "$gd/rebase-merge" || -d "$gd/rebase-apply" ) ]]
}

# Never leave the tree mid-rebase: a stuck rebase corrupts every later status
# write. Abort any in-progress rebase; return 0 iff one was found and aborted.
abort_stale_rebase() {
  if rebase_in_progress; then
    git_office rebase --abort >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

# `git pull --rebase --autostash` can exit 0 yet leave the autostash POP in
# conflict: unmerged index entries + conflict markers in the worktree, with the
# local edit safe in the stash. Roll the conflicted files back to the rebased
# upstream content (the local edit stays recoverable via `git stash list`) so a
# marker-laden file can never be staged/committed/pushed downstream.
resolve_autostash_conflict() {
  local unmerged
  unmerged="$(git_office diff --name-only --diff-filter=U 2>/dev/null)" || return 0
  [[ -z "$unmerged" ]] && return 0
  warn "autostash re-apply conflicted on: $(echo "$unmerged" | tr '\n' ' ')"
  warn "  rolled back to upstream content; your local edits are kept in 'git -C $OFFICE_DIR stash list' — re-apply manually"
  # shellcheck disable=SC2086
  git_office checkout HEAD -- $unmerged >/dev/null 2>&1 || true
}

# Pull --rebase, leaving the tree clean and attached no matter what. Returns 0
# when it is safe to keep working (incl. after rolling back an autostash
# conflict); nonzero when the rebase was aborted or the pull simply failed
# (offline), to tell do_push that retrying the push is pointless.
safe_pull_rebase() {
  if git_office pull --rebase --autostash --quiet 2>/dev/null; then
    resolve_autostash_conflict
    return 0
  fi
  if abort_stale_rebase; then
    warn "rebase conflict; aborted. Resolve manually: git -C $OFFICE_DIR pull --rebase"
    return 1
  fi
  warn "pull failed (offline?); continuing with local state"
  return 1
}

do_pull() {
  sync_enabled || return 0
  git_office rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    warn "not a git repository: $OFFICE_DIR — skipping"
    return 0
  }
  # Recover a rebase wedged by an earlier crash/kill BEFORE the upstream check:
  # a detached mid-rebase HEAD has no @{u}, which would otherwise skip recovery.
  abort_stale_rebase && warn "found a stale in-progress rebase; aborted to restore branch state"
  git_office rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || {
    warn "current branch has no upstream — skipping"
    return 0
  }
  safe_pull_rebase || true
  return 0
}

# Refuse to publish a registry with unresolved merge state or that doesn't
# parse — committing conflict markers would silently disable prefix enforcement
# team-wide on everyone's next pull.
team_yaml_publishable() {
  [[ -z "$(git_office ls-files -u -- office.team.yaml 2>/dev/null)" ]] || return 1
  ruby -ryaml -e 'YAML.safe_load(File.read(ARGV[0]))' "$OFFICE_DIR/office.team.yaml" >/dev/null 2>&1
}

do_push() {
  local task_id="${1:-}"
  local label="${2:-office auto-sync}"
  if [[ -z "$task_id" ]]; then
    warn "push requires a task id"
    return 0
  fi
  sync_enabled || return 0
  git_office rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    warn "not a git repository: $OFFICE_DIR — skipping"
    return 0
  }
  # Same guard as do_pull: don't commit onto a detached mid-rebase HEAD.
  abort_stale_rebase && warn "found a stale in-progress rebase; aborted before publishing"

  # Publish only this run's state (plus the team prefix registry, so a claim
  # made via the dashboard rides along) — never sweep unrelated edits.
  local pathspec=("runs/$task_id")
  if [[ -f "$OFFICE_DIR/office.team.yaml" ]]; then
    if team_yaml_publishable; then
      pathspec+=("office.team.yaml")
    else
      warn "office.team.yaml has unmerged/unparseable content; NOT publishing it (resolve the conflict; it rides the next push)"
    fi
  fi

  if [[ -z "$(git_office status --porcelain -- "${pathspec[@]}" 2>/dev/null)" ]]; then
    return 0
  fi

  git_office add -- "${pathspec[@]}" 2>/dev/null || true
  if ! git_office commit --quiet -m "$label" -- "${pathspec[@]}" 2>/dev/null; then
    # Same-machine contention (parallel lanes hitting index.lock) or
    # misconfigured user.name — leave it for the next step's push.
    warn "commit failed for runs/$task_id; will retry on the next step"
    return 0
  fi

  if ! git_office rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    warn "no upstream — committed locally only"
    return 0
  fi

  local attempt
  for attempt in 1 2; do
    if git_office push --quiet 2>/dev/null; then
      return 0
    fi
    warn "push rejected; rebasing and retrying ($attempt/2)"
    # On a rebase conflict safe_pull_rebase aborts (tree clean, our commit
    # intact on the branch) and returns nonzero — retrying the push from there
    # can never succeed, so stop and let the next step's push catch up.
    safe_pull_rebase || break
  done
  warn "push failed after retry; state is committed locally — push manually when online"
  return 0
}

case "${1:-}" in
  pull) do_pull ;;
  push) shift; do_push "$@" ;;
  enabled) sync_enabled ;;
  *)
    echo "usage: office-git-sync.sh pull | push <task-id> [label] | enabled" >&2
    exit 2
    ;;
esac
