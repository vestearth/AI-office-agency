#!/usr/bin/env bash
set -euo pipefail

# run-agent.sh launches ~60 Ruby helpers per dispatch. Loading RubyGems is most
# of each launch (~50ms with it, ~14ms without), and every helper needs only the
# standard library, so the driver runs its helpers with --disable-gems.
#   G: every library the office's Ruby requires loads without RubyGems, so a
#      gem-only require cannot slip in and break the driver.
#   D: every Ruby the driver itself launches during a real dispatch gets
#      --disable-gems (Ruby launched by Ruby, e.g. Open3, is out of scope).

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$WORK"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

fail() { echo "[FAIL] $1"; exit 1; }
ok() { echo "  ok: $1"; }

echo "== G: stdlib only =="
libs="$(cat "$ROOT_DIR"/scripts/*.rb "$ROOT_DIR/validate-yaml.rb" "$ROOT_DIR/run-agent.sh" \
  | ruby -Eutf-8 -e 'puts STDIN.read.scrub.scan(/^\s*require\s+["\x27]([\w\/]+)["\x27]/).flatten.uniq.sort')"
[[ -n "$libs" ]] || fail "G: found no require lines to check"
for lib in $libs; do
  ruby --disable-gems -e "require '$lib'" 2>/dev/null \
    || fail "G: '$lib' does not load without RubyGems; the driver runs its helpers with --disable-gems"
done
ok "G: $(echo "$libs" | wc -l | tr -d ' ') required libraries load with --disable-gems"

echo "== D: driver launches =="
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW OFFICE_PROFILE \
  AI_DEV_OFFICE_INPUT_SOURCE AI_DEV_OFFICE_GIT_SYNCED AI_DEV_OFFICE_CONFIG_DIR
export OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false
OFFICE="$WORK/office"; RUNS="$WORK/runs"; BIN="$WORK/bin"; LOG="$WORK/ruby-calls.log"
mkdir -p "$OFFICE" "$RUNS" "$BIN"
export AI_OFFICE_RUNS_DIR="$RUNS"
for f in run-agent.sh validate-yaml.rb office.config.yaml office.team.yaml; do cp "$ROOT_DIR/$f" "$OFFICE/"; done
for d in agents scripts schemas workflows templates profiles runners; do cp -R "$ROOT_DIR/$d" "$OFFICE/"; done

# Stub runner, and a `ruby` shim that records whether the driver passed
# --disable-gems (parent command line names run-agent.sh) before running Ruby.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/codex"
REAL_RUBY="$(command -v ruby)"
cat > "$BIN/ruby" <<SHIM
#!/usr/bin/env bash
parent="\$(ps -o args= -p \$PPID 2>/dev/null || true)"
if [[ "\$parent" == *run-agent.sh* ]]; then
  if [[ "\${1:-}" == "--disable-gems" ]]; then echo "flag \${*:2:2}" >> "$LOG"; else echo "noflag \$*" >> "$LOG"; fi
fi
exec "$REAL_RUBY" "\$@"
SHIM
chmod +x "$BIN/codex" "$BIN/ruby"

mkdir -p "$RUNS/TASK-NG-001"
cat > "$RUNS/TASK-NG-001/status.yaml" <<YAML
task_id: TASK-NG-001
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-10-10"
updated_at: "2026-10-10"
history: []
YAML

PATH="$BIN:$PATH" bash "$OFFICE/run-agent.sh" TASK-NG-001 dev codex > "$WORK/dispatch.log" 2>&1 \
  || fail "D: the dispatch failed: $(tail -5 "$WORK/dispatch.log")"
calls="$(grep -c '' "$LOG" 2>/dev/null || echo 0)"
[[ "$calls" -ge 10 ]] || fail "D: expected the driver to launch Ruby many times, saw $calls (shim not on the path?)"
if grep -q '^noflag ' "$LOG"; then
  fail "D: driver Ruby launched without --disable-gems: $(grep '^noflag ' "$LOG" | head -3 | tr '\n' ';')"
fi
ok "D: all $calls Ruby launches by run-agent.sh pass --disable-gems"

SUITE_DONE=1
echo "[PASS] driver-ruby-no-gems: the driver's Ruby helpers run without RubyGems"
