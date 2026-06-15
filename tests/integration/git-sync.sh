#!/usr/bin/env bash
# Multi-user git mode: office-git-sync.sh must publish run state across
# clones, recover from rejected pushes by rebasing, never sweep unrelated
# edits into its commits, and be a strict no-op when disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYNC="$ROOT/scripts/office-git-sync.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*"; exit 1; }

git_q() { git "$@" >/dev/null 2>&1; }

make_office_clone() {
  # $1 = clone dir. Each clone carries the sync script + resolver so the
  # script resolves OFFICE_DIR to the clone, mirroring the real layout.
  local dir="$1"
  git clone -q "$WORK/origin.git" "$dir"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config user.email "test@example.com"
  mkdir -p "$dir/scripts" "$dir/runs"
  cp "$SYNC" "$dir/scripts/"
  cp "$ROOT/scripts/resolve-office-config.rb" "$dir/scripts/"
  printf 'git_sync:\n  enabled: true\n' > "$dir/office.config.yaml"
}

git init -q --bare "$WORK/origin.git"

# Seed origin with an initial commit so later clones get an upstream branch.
# Include a base office.team.yaml so registry-conflict scenarios have a shared
# ancestor (line edits, not add/add).
make_office_clone "$WORK/seed" 2>/dev/null
printf 'prefixes: {}\n' > "$WORK/seed/office.team.yaml"
( cd "$WORK/seed" && git add -A && git commit -qm "seed" && git push -q -u origin HEAD )

echo "== Scenario 1: push publishes a run to origin =="
make_office_clone "$WORK/a"
mkdir -p "$WORK/a/runs/TASK-A-001"
echo "task_id: TASK-A-001" > "$WORK/a/runs/TASK-A-001/status.yaml"
bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-001 "TASK-A-001: pm step"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-A-001/status.yaml" \
  || fail "origin missing runs/TASK-A-001/status.yaml after push"
echo "[OK] run published"

echo "== Scenario 2: rejected push rebases and retries =="
make_office_clone "$WORK/b"
# A pushes first, so B's push is non-fast-forward and must rebase.
mkdir -p "$WORK/a/runs/TASK-A-002"
echo "task_id: TASK-A-002" > "$WORK/a/runs/TASK-A-002/status.yaml"
bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-002 "TASK-A-002: pm step"
mkdir -p "$WORK/b/runs/TASK-B-001"
echo "task_id: TASK-B-001" > "$WORK/b/runs/TASK-B-001/status.yaml"
bash "$WORK/b/scripts/office-git-sync.sh" push TASK-B-001 "TASK-B-001: pm step"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-B-001/status.yaml" \
  || fail "origin missing TASK-B-001 after rebase-retry push"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-A-002/status.yaml" \
  || fail "rebase-retry lost TASK-A-002"
echo "[OK] rebase-retry preserved both runs"

echo "== Scenario 3: unrelated edits are never swept into the commit =="
echo "unrelated" > "$WORK/a/unrelated.txt"
git -C "$WORK/a" add unrelated.txt
mkdir -p "$WORK/a/runs/TASK-A-003"
echo "task_id: TASK-A-003" > "$WORK/a/runs/TASK-A-003/status.yaml"
bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-003 "TASK-A-003: pm step"
git -C "$WORK/origin.git" cat-file -e "HEAD:unrelated.txt" 2>/dev/null \
  && fail "unrelated staged file was swept into the sync commit"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-A-003/status.yaml" \
  || fail "TASK-A-003 not pushed"
echo "[OK] commit scoped to the run pathspec"

echo "== Scenario 4: office.team.yaml rides along with a push =="
( cd "$WORK/a" && git rm -q --cached unrelated.txt && rm unrelated.txt )
printf 'prefixes:\n  EA: Earth\n' > "$WORK/a/office.team.yaml"
mkdir -p "$WORK/a/runs/TASK-A-004"
echo "task_id: TASK-A-004" > "$WORK/a/runs/TASK-A-004/status.yaml"
bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-004 "TASK-A-004: pm step"
git -C "$WORK/origin.git" cat-file -e "HEAD:office.team.yaml" \
  || fail "office.team.yaml did not ride along"
echo "[OK] registry claim published with the run"

echo "== Scenario 5: disabled sync is a strict no-op =="
make_office_clone "$WORK/c"
printf 'git_sync:\n  enabled: false\n' > "$WORK/c/office.config.yaml"
mkdir -p "$WORK/c/runs/TASK-C-001"
echo "task_id: TASK-C-001" > "$WORK/c/runs/TASK-C-001/status.yaml"
before="$(git -C "$WORK/c" rev-parse HEAD)"
bash "$WORK/c/scripts/office-git-sync.sh" push TASK-C-001 "TASK-C-001: pm step"
bash "$WORK/c/scripts/office-git-sync.sh" pull
after="$(git -C "$WORK/c" rev-parse HEAD)"
[[ "$before" == "$after" ]] || fail "disabled sync still created a commit"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-C-001/status.yaml" 2>/dev/null \
  && fail "disabled sync still pushed"
echo "[OK] disabled mode untouched the repo"

echo "== Scenario 6: env override flips enablement both ways =="
OFFICE_GIT_SYNC=1 bash "$WORK/c/scripts/office-git-sync.sh" push TASK-C-001 "TASK-C-001: env on"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-C-001/status.yaml" \
  || fail "OFFICE_GIT_SYNC=1 did not enable push"
mkdir -p "$WORK/a/runs/TASK-A-005"
echo "task_id: TASK-A-005" > "$WORK/a/runs/TASK-A-005/status.yaml"
OFFICE_GIT_SYNC=0 bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-005 "TASK-A-005: env off"
git -C "$WORK/origin.git" cat-file -e "HEAD:runs/TASK-A-005/status.yaml" 2>/dev/null \
  && fail "OFFICE_GIT_SYNC=0 did not disable push"
echo "[OK] env override honored"

no_rebase_in_progress() {
  # $1 = clone dir. Fails the test if a rebase is mid-flight or HEAD detached.
  local gd; gd="$(git -C "$1" rev-parse --absolute-git-dir)"
  [[ -d "$gd/rebase-merge" || -d "$gd/rebase-apply" ]] && fail "$2: left mid-rebase"
  git -C "$1" symbolic-ref -q HEAD >/dev/null || fail "$2: left on detached HEAD"
  return 0
}

echo "== Scenario 7: same-line office.team.yaml conflict never wedges the loser =="
# The feature's headline race: two machines claim the same prefix. The loser's
# push is rejected, the retry rebase conflicts on the same line — the repo must
# stay clean (attached HEAD, no in-progress rebase) and never commit markers.
make_office_clone "$WORK/d"
make_office_clone "$WORK/e"
printf 'prefixes:\n  SP: Alice\n' > "$WORK/d/office.team.yaml"
mkdir -p "$WORK/d/runs/TASK-D-001"; echo "task_id: TASK-D-001" > "$WORK/d/runs/TASK-D-001/status.yaml"
bash "$WORK/d/scripts/office-git-sync.sh" push TASK-D-001 "TASK-D-001: claim SP"
printf 'prefixes:\n  SP: Bob\n' > "$WORK/e/office.team.yaml"
mkdir -p "$WORK/e/runs/TASK-E-001"; echo "task_id: TASK-E-001" > "$WORK/e/runs/TASK-E-001/status.yaml"
bash "$WORK/e/scripts/office-git-sync.sh" push TASK-E-001 "TASK-E-001: claim SP"
no_rebase_in_progress "$WORK/e" "loser"
grep -q '<<<<<<<' "$WORK/e/office.team.yaml" && fail "conflict markers left in loser's worktree office.team.yaml"
git -C "$WORK/e" cat-file -e "HEAD:runs/TASK-E-001/status.yaml" || fail "loser lost its own run commit"
for sha in $(git -C "$WORK/e" rev-list HEAD); do
  if git -C "$WORK/e" cat-file -e "$sha:office.team.yaml" 2>/dev/null \
     && git -C "$WORK/e" show "$sha:office.team.yaml" | grep -q '<<<<<<<'; then
    fail "a loser commit contains conflict markers in office.team.yaml ($sha)"
  fi
done
git -C "$WORK/origin.git" show "main:office.team.yaml" | grep -q '<<<<<<<' && fail "markers published to remote"
echo "[OK] same-line conflict left the repo clean, attached, marker-free"

echo "== Scenario 8: rebase abort works when invoked from outside the office dir =="
# Regression for the cwd-relative rebase-state check: run-agent.sh invokes the
# script from the workspace root, not OFFICE_DIR.
make_office_clone "$WORK/f"
make_office_clone "$WORK/g"
printf 'prefixes:\n  XX: Alice\n' > "$WORK/f/office.team.yaml"
mkdir -p "$WORK/f/runs/TASK-F-001"; echo x > "$WORK/f/runs/TASK-F-001/status.yaml"
bash "$WORK/f/scripts/office-git-sync.sh" push TASK-F-001 "claim XX"
printf 'prefixes:\n  XX: Bob\n' > "$WORK/g/office.team.yaml"
git -C "$WORK/g" commit -qam "claim XX (Bob)"
( cd "$WORK" && OFFICE_GIT_SYNC=1 OFFICE_GIT_SYNC_ROOT="$WORK/g" bash "$WORK/g/scripts/office-git-sync.sh" pull )
no_rebase_in_progress "$WORK/g" "outside-cwd"
echo "[OK] rebase abort is cwd-independent"

echo "== Scenario 9: autostash-pop conflict rolls back to upstream, never publishes markers =="
# A dirty uncommitted office.team.yaml (dashboard claim not yet committed) plus
# an upstream change on the same line: rebase succeeds, autostash re-apply
# conflicts, exit 0. The dirty edit must be parked in the stash, the worktree
# rolled back marker-free, and no later push may publish markers.
make_office_clone "$WORK/h"
make_office_clone "$WORK/i"
printf 'prefixes:\n  YY: Alice\n' > "$WORK/h/office.team.yaml"
git -C "$WORK/h" commit -qam "claim YY"; git -C "$WORK/h" push -q
printf 'prefixes:\n  YY: Bob\n' > "$WORK/i/office.team.yaml"   # dirty, uncommitted
OFFICE_GIT_SYNC=1 bash "$WORK/i/scripts/office-git-sync.sh" pull
grep -q '<<<<<<<' "$WORK/i/office.team.yaml" && fail "autostash conflict left markers in worktree"
git -C "$WORK/i" stash list | grep -q . || fail "autostash edit not preserved in the stash"
no_rebase_in_progress "$WORK/i" "autostash"
mkdir -p "$WORK/i/runs/TASK-I-001"; echo x > "$WORK/i/runs/TASK-I-001/status.yaml"
OFFICE_GIT_SYNC=1 bash "$WORK/i/scripts/office-git-sync.sh" push TASK-I-001 "TASK-I-001: step"
git -C "$WORK/origin.git" show "main:office.team.yaml" | grep -q '<<<<<<<' && fail "conflict markers published to remote"
echo "[OK] autostash-pop conflict contained, run state still synced"

echo "== Scenario 10: pull soft-fails without a remote =="
rm -rf "$WORK/origin.git"
bash "$WORK/a/scripts/office-git-sync.sh" pull || fail "pull must exit 0 when offline"
bash "$WORK/a/scripts/office-git-sync.sh" push TASK-A-005 "TASK-A-005: offline" \
  || fail "push must exit 0 when offline"
echo "[OK] offline soft-fail honored"

echo "[PASS] git-sync scenarios passed"
