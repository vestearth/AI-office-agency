#!/usr/bin/env bash
set -euo pipefail

# Issue #28 — governed writers store non-ASCII ARGV as UTF-8 text.
#
# With no locale (LANG/LC_ALL/LC_CTYPE unset) Ruby tags ARGV as ASCII-8BIT, so
# a Thai --reason/--ran-by/--scope was dumped as YAML `!binary` and the gate
# view rendered "ran.by is not UTF-8 text". Both writers must store the plain
# UTF-8 string, and refuse an argument that is not valid UTF-8 (exit 2,
# nothing written). Sections: G update-completion-gate.rb,
# A record-authorization.rb.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
RUN_AGENT="$ROOT/run-agent.sh"
THAI="ทดสอบ"
BAD=$'\xff\xfe'

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# no_locale <cmd...> — run with no locale, as a bare agent shell does.
no_locale() { env -u LANG -u LC_ALL -u LC_CTYPE "$@"; }
# utf8_field <file> <dotted.path> — the stored value, only if it is UTF-8 text.
utf8_field() {
  LANG=en_US.UTF-8 ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) do |node, key|
  if node.is_a?(Array) && key.match?(/\A\d+\z/) then node[key.to_i]
  elsif node.is_a?(Hash) then node[key]
  end
end
abort "not UTF-8 text: #{value.inspect} (#{value.encoding})" unless value.is_a?(String) && value.encoding == Encoding::UTF_8 && value.valid_encoding?
print value
RUBY
}
task() {
  local dir="$RUNS/$1"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: implementation
state: implementation
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-01'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}
# expect_refusal <label> <file> <cmd...> — exit 2, a message naming UTF-8, and <file> untouched.
expect_refusal() {
  local label="$1" file="$2"; shift 2
  local before="$RUNS/before.copy"
  if [[ -e "$file" ]]; then cp "$file" "$before"; else rm -f "$before"; fi
  rc=0; no_locale "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "2" "$label exit ($(cat "$RUNS/refusal.log"))"
  grep -q "UTF-8" "$RUNS/refusal.log" || fail "$label message does not name UTF-8: $(cat "$RUNS/refusal.log")"
  if [[ -e "$before" ]]; then
    cmp -s "$file" "$before" || fail "$label wrote $file"
  else
    [[ ! -e "$file" ]] || fail "$label created $file"
  fi
}

# --- G: update-completion-gate.rb ---
D="$(task TASK-2001)"
no_locale ruby "$GATE" TASK-2001 declare g --actor pm --reason "$THAI" >/dev/null
grep -q '!binary' "$D/status.yaml" && fail "G declare stored a !binary value"
assert_eq "$(utf8_field "$D/status.yaml" completion_gates.g.reason)" "$THAI" "G declare reason"
assert_eq "$(utf8_field "$D/status.yaml" history.0.reason)" "$THAI" "G history reason"
no_locale ruby "$GATE" TASK-2001 pass g --actor dev --reason "$THAI" --ran-by "ผู้ทดสอบ" --ran-ref abc --ran-url "https://x.example/ทดสอบ" >/dev/null
grep -q '!binary' "$D/status.yaml" && fail "G pass stored a !binary value"
assert_eq "$(utf8_field "$D/status.yaml" completion_gates.g.ran.by)" "ผู้ทดสอบ" "G ran.by"
assert_eq "$(utf8_field "$D/status.yaml" completion_gates.g.ran.url)" "https://x.example/ทดสอบ" "G ran.url"
view="$(no_locale bash "$RUN_AGENT" status TASK-2001 2>&1)"
grep -qxF "Gates: 1/1 resolved" <<<"$view" || fail "G gate view is not readable: $(grep '^Gates' <<<"$view")"
expect_refusal "G invalid UTF-8 --reason" "$D/status.yaml" ruby "$GATE" TASK-2001 declare h --actor pm --reason "bad${BAD}"
expect_refusal "G invalid UTF-8 --actor" "$D/status.yaml" ruby "$GATE" TASK-2001 declare h --actor "pm${BAD}" --reason r

# --- A: record-authorization.rb ---
D="$(task TASK-2002)"
expect_refusal "A invalid UTF-8 --reason" "$D/authorization.yaml" \
  ruby "$AUTHZ" TASK-2002 grant --action deploy_staging --scope staging --actor operator --via chat --reason "bad${BAD}"
no_locale ruby "$AUTHZ" TASK-2002 grant --action deploy_staging --scope "สเตจจิ้ง" --actor operator --via "แชท" --reason "$THAI" >/dev/null
grep -q '!binary' "$D/authorization.yaml" && fail "A grant stored a !binary value"
assert_eq "$(utf8_field "$D/authorization.yaml" authorizations.0.reason)" "$THAI" "A reason"
assert_eq "$(utf8_field "$D/authorization.yaml" authorizations.0.scope)" "สเตจจิ้ง" "A scope"
assert_eq "$(utf8_field "$D/authorization.yaml" authorizations.0.via)" "แชท" "A via"
expect_refusal "A invalid UTF-8 revoke --via" "$D/authorization.yaml" \
  ruby "$AUTHZ" TASK-2002 revoke authz-001 --actor operator --via "chat${BAD}" --reason r

echo "[PASS] writer-argv-utf8: governed writers store non-ASCII arguments as UTF-8 (#28)"
