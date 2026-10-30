#!/usr/bin/env bash
# scripts/sweep-worktrees.rb: list (default) or remove (--apply) linked worktrees that
# are merged, clean and idle; delete merged local branches with --branches; list stashes
# with --stashes and never drop them. Runs against a scratch workspace of throwaway repos.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="$(mktemp -d)"
# bash 3.2 can enter the EXIT trap with $?=0 after a set -u abort: completion is
# proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=
finish() {
  local rc=$?
  rm -rf "$WS"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT
SWEEP="$ROOT/scripts/sweep-worktrees.rb"

fail() { echo "[FAIL] $1"; echo "--- output:"; cat "$WS/out.txt" 2>/dev/null || true; exit 1; }
g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
sweep() { ruby "$SWEEP" --root "$WS" "$@" >"$WS/out.txt" 2>&1 || fail "sweep $* exited non-zero"; }
line_for() { grep -F "$1" "$WS/out.txt" || true; }

# A workspace repo `app` with origin main and staging.
g init -q --bare "$WS/origin.git"
g clone -q "$WS/origin.git" "$WS/app" 2>/dev/null
echo base >"$WS/app/file.txt"
g -C "$WS/app" add file.txt && g -C "$WS/app" commit -q -m base
g -C "$WS/app" push -q origin main
g -C "$WS/app" push -q origin main:staging

mk_branch() { # name, merged(yes|no)
  g -C "$WS/app" checkout -q -b "$1" main
  echo "$1" >"$WS/app/$1.txt"
  g -C "$WS/app" add "$1.txt" && g -C "$WS/app" commit -q -m "$1"
  if [[ "$2" == yes ]]; then
    g -C "$WS/app" checkout -q main && g -C "$WS/app" merge -q --no-ff -m "merge $1" "$1"
    g -C "$WS/app" push -q origin main
  else
    g -C "$WS/app" checkout -q main
  fi
}
mk_branch merged yes
mk_branch unmerged no
mk_branch dirty yes
mk_branch nodemods yes
mk_branch gone yes
mk_branch locked yes
mk_branch dash yes
mk_branch merged-loose yes
mk_branch unmerged-loose no
g -C "$WS/app" fetch -q origin

mkdir -p "$WS/.worktrees"
for b in merged unmerged dirty nodemods gone locked dash; do
  g -C "$WS/app" worktree add -q "$WS/.worktrees/app-$b" "$b"
done
echo changed >>"$WS/.worktrees/app-dirty/file.txt"
mkdir -p "$WS/.worktrees/app-nodemods/node_modules/pkg" && echo x >"$WS/.worktrees/app-nodemods/node_modules/pkg/index.js"
rm -rf "$WS/.worktrees/app-gone"
g -C "$WS/app" worktree lock "$WS/.worktrees/app-locked"
cat >"$WS/.worktrees/.dashboard-worktrees.json" <<JSON
{"worktrees":[{"task":"TASK-1","repo":"app","path":"$WS/.worktrees/app-dash","branch":"dash","origin":"created"}]}
JSON
echo wip >>"$WS/app/file.txt"
g -C "$WS/app" stash push -q -m keep-me
[[ "$(g -C "$WS/app" stash list | wc -l | tr -d ' ')" == 1 ]] || fail "test setup: stash not created"

# A read-only reference repo: never touched, even when its worktree is merged and clean.
RO="Games-Lab-""Android"
g init -q --bare "$WS/ro-origin.git"
g clone -q "$WS/ro-origin.git" "$WS/$RO" 2>/dev/null
echo r >"$WS/$RO/r.txt" && g -C "$WS/$RO" add r.txt && g -C "$WS/$RO" commit -q -m r && g -C "$WS/$RO" push -q origin main
g -C "$WS/$RO" worktree add -q -b ro-wt "$WS/.worktrees/ro-wt" main

# A worktree with unmerged work under /tmp, which macOS purges after 3 days.
TMPWT="$(mktemp -d /private/tmp/sweep-test-XXXXXX)"
rmdir "$TMPWT"
g -C "$WS/app" worktree add -q -b tmp-work "$TMPWT" unmerged
trap 'rm -rf "$TMPWT"; finish' EXIT

# 1. Default idle guard: everything was just touched, so nothing is removable.
sweep
grep -q "remove" "$WS/out.txt" && fail "fresh worktrees must not be removable under the default idle guard"
line_for "app-merged" | grep -q "recently used" || fail "app-merged should be kept as recently used"

# 2. Dry run with the guard off: verdicts, nothing changed.
sweep --min-idle-hours 0 --branches --stashes
line_for "app-merged " | grep -q "^remove" || fail "app-merged should be removable"
line_for "app-nodemods" | grep -q "^remove" || fail "only node_modules is untracked in app-nodemods: removable"
line_for "app-unmerged" | grep -q "not merged" || fail "app-unmerged should be kept: not merged"
line_for "app-dirty" | grep -q "uncommitted" || fail "app-dirty should be kept: uncommitted changes"
line_for "app-locked" | grep -q "locked" || fail "app-locked should be kept: locked"
line_for "app-dash" | grep -q "dashboard" || fail "app-dash should be kept: dashboard-managed"
line_for "app-gone" | grep -q "^prune" || fail "app-gone should be pruned: directory missing"
grep -q "ro-wt" "$WS/out.txt" && fail "the read-only repo must not be listed"
grep -F "$TMPWT" "$WS/out.txt" | grep -q "^warn .*under /tmp" || fail "a kept worktree under /tmp should get the purge warning"
grep "^warn" "$WS/out.txt" | grep -qv "$TMPWT" && fail "only the /tmp worktree should be warned about"
line_for "merged-loose" | grep -q "^delete branch" || fail "merged-loose should be a deletable branch"
grep -q "unmerged-loose" "$WS/out.txt" && fail "unmerged-loose must never be offered for deletion"
grep -q "delete branch app merged$" "$WS/out.txt" && fail "a branch checked out in a worktree must not be deleted"
grep -q "keep-me" "$WS/out.txt" || fail "stashes should be listed"
[[ -d "$WS/.worktrees/app-merged" ]] || fail "dry run removed a worktree"
g -C "$WS/app" rev-parse -q --verify merged-loose >/dev/null || fail "dry run deleted a branch"

# 3. Apply.
sweep --min-idle-hours 0 --branches --stashes --apply
[[ ! -d "$WS/.worktrees/app-merged" ]] || fail "app-merged was not removed"
[[ ! -d "$WS/.worktrees/app-nodemods" ]] || fail "app-nodemods was not removed"
for keep in unmerged dirty locked dash; do
  [[ -d "$WS/.worktrees/app-$keep" ]] || fail "app-$keep must be kept"
done
[[ -d "$WS/.worktrees/ro-wt" ]] || fail "the read-only repo's worktree must be kept"
g -C "$WS/app" worktree list --porcelain | grep -q "app-gone" && fail "app-gone was not pruned"
g -C "$WS/app" rev-parse -q --verify merged-loose >/dev/null && fail "merged-loose was not deleted"
g -C "$WS/app" rev-parse -q --verify unmerged-loose >/dev/null || fail "unmerged-loose must survive"
g -C "$WS/app" rev-parse -q --verify merged >/dev/null || fail "a branch whose worktree was just removed is deleted only on the next run"
[[ "$(g -C "$WS/app" stash list | wc -l | tr -d ' ')" == 1 ]] || fail "stashes must never be dropped"
grep -q "changed" "$WS/.worktrees/app-dirty/file.txt" || fail "app-dirty lost its uncommitted change"

SUITE_DONE=1
echo "[PASS] sweep-worktrees: idle guard, dry run, merged/clean removal, keeps (unmerged, dirty, locked, dashboard, read-only), prune, merged branch delete, stashes listed only"
