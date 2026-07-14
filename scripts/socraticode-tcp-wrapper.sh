#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${SOCRATICODE_REMOTE_HOST:-socraticode@192.168.1.140}"
REMOTE_SSH_KEY="${SOCRATICODE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_PORT="${SOCRATICODE_REMOTE_PORT:-4444}"
REMOTE_PROJECT="${SOCRATICODE_REMOTE_PROJECT:-/app}"
REMOTE_CANONICAL_PROJECT="${SOCRATICODE_REMOTE_CANONICAL_PROJECT:-D:\\llm}"
LOCAL_PROJECT_ROOT="${SOCRATICODE_LOCAL_PROJECT:-/Users/earth/Documents/GitHub}"  # local Docker SocratiCode index root (not remote SSH)
GRAPH_PROJECT_ROOT="${SOCRATICODE_GRAPH_ROOT:-$LOCAL_PROJECT_ROOT}"
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -h "$SCRIPT_SOURCE" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
LOCAL_MCP_CLIENT="$SCRIPT_DIR/socraticode-local-mcp-client.js"
SSH_CONNECT_TIMEOUT="${SOCRATICODE_SSH_TIMEOUT:-8}"
REMOTE_BACKEND="${SOCRATICODE_BACKEND:-auto}" # auto | remote | local

usage() {
  cat <<'EOF'
Usage:
  socraticode context --role <role> --task-file <path> --status-file <path> --pm-output <path>
  socraticode codebase_status
  socraticode codebase_search --query <text> [--fileFilter <path>] [--languageFilter <lang>] [--includeLinked] [--limit <n>] [--minScore <n>] [--projectPath <path>]
  socraticode codebase_symbol --name <symbol> [--file <path>] [--projectPath <path>]
  socraticode codebase_graph_query --file <path> [--projectPath <path>]
  socraticode codebase_graph_stats [--projectPath <path>]
  socraticode codebase_graph_circular [--projectPath <path>]

Environment:
  SOCRATICODE_REMOTE_HOST
  SOCRATICODE_REMOTE_PORT
  SOCRATICODE_REMOTE_PROJECT
  SOCRATICODE_SSH_KEY
  SOCRATICODE_SSH_TIMEOUT
  SOCRATICODE_LOCAL_PROJECT
  SOCRATICODE_GRAPH_ROOT
  SOCRATICODE_BACKEND          auto | remote | local (default: auto)
  SOCRATICODE_LOCAL_COMMAND    default: npx
  SOCRATICODE_LOCAL_ARGS       default: -y socraticode
  SOCRATICODE_NPM_CACHE        default: ~/.npm (avoids broken sandbox npx cache)
EOF
}

build_request_json() {
  local method="$1"
  shift || true

  node - "$method" "$@" <<'NODE'
const [method, ...pairs] = process.argv.slice(2);
const params = {};
function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+|\d+\.\d+)$/.test(value)) return Number(value);
  return value;
}
for (let i = 0; i < pairs.length; i += 2) {
  const key = pairs[i];
  const value = pairs[i + 1];
  if (!key) continue;
  params[key] = value === undefined ? "" : parseValue(value);
}
process.stdout.write(JSON.stringify({ method, params }));
NODE
}

ssh_remote() {
  ssh \
    -o "ConnectTimeout=$SSH_CONNECT_TIMEOUT" \
    -o BatchMode=yes \
    -i "$REMOTE_SSH_KEY" \
    -T "$REMOTE_HOST" \
    "$@"
}

remote_request() {
  local method="$1"
  shift || true
  local payload_json
  local ps_script
  local encoded
  local output

  payload_json="$(build_request_json "$method" "$@")"

  ps_script=$(cat <<PS
\$ErrorActionPreference = 'Stop'
\$payload = @'
$payload_json
'@
\$client = New-Object System.Net.Sockets.TcpClient("127.0.0.1",$REMOTE_PORT)
\$stream = \$client.GetStream()
\$writer = New-Object System.IO.StreamWriter(\$stream)
\$writer.AutoFlush = \$true
\$reader = New-Object System.IO.StreamReader(\$stream)
\$writer.WriteLine(\$payload)
\$response = \$reader.ReadLine()
if (\$null -eq \$response) { exit 1 }
Write-Output \$response
\$client.Close()
PS
)

  encoded="$(printf '%s' "$ps_script" | iconv -t UTF-16LE | base64 | tr -d '\n')"
  output="$(ssh_remote powershell -NoProfile -EncodedCommand "$encoded" 2>&1)" || {
    if printf '%s' "$output" | grep -qi "Operation not permitted\|connect to host .* port 22\|Connection timed out\|Operation timed out"; then
      return 1
    fi
    printf '%s\n' "$output" >&2
    return 1
  }
  printf '%s\n' "$output"
}

remote_backend_enabled() {
  [[ "$REMOTE_BACKEND" != "local" ]]
}

local_backend_enabled() {
  [[ "$REMOTE_BACKEND" != "remote" ]]
}

json_is_success() {
  local payload="$1"
  printf '%s' "$payload" | grep -q '"type"[[:space:]]*:[[:space:]]*"success"'
}

local_docker_mcp() {
  node "$LOCAL_MCP_CLIENT" "$@"
}

local_docker_probe() {
  local payload
  payload="$(local_docker_mcp codebase_status --projectPath "$LOCAL_PROJECT_ROOT" 2>/dev/null || true)"
  json_is_success "$payload"
}

format_local_status_json() {
  local project_path="$1"
  local payload
  payload="$(local_docker_mcp codebase_status --projectPath "$project_path")"
  SOCRATICODE_PAYLOAD="$payload" SOCRATICODE_PROJECT_PATH="$project_path" node <<'NODE'
const input = JSON.parse(process.env.SOCRATICODE_PAYLOAD || "{}");
const projectPath = process.env.SOCRATICODE_PROJECT_PATH || "";
if (input.type !== "success") {
  process.stdout.write(JSON.stringify(input));
  process.exit(0);
}
const text = String(input.text || "").trim();
const active = /Status:\s*green/i.test(text);
process.stdout.write(JSON.stringify({
  type: "success",
  method: "codebase_status",
  backend: "local-docker",
  projectPath,
  message: text,
  status: active ? "active" : "unknown",
}));
NODE
}

format_local_tool_json() {
  local method="$1"
  local project_path="$2"
  shift 2
  local payload
  payload="$(local_docker_mcp "$method" --projectPath "$project_path" "$@")"
  SOCRATICODE_METHOD="$method" \
  SOCRATICODE_PAYLOAD="$payload" \
  SOCRATICODE_PROJECT_PATH="$project_path" \
  node <<'NODE'
const input = JSON.parse(process.env.SOCRATICODE_PAYLOAD || "{}");
const method = process.env.SOCRATICODE_METHOD || "unknown";
const projectPath = process.env.SOCRATICODE_PROJECT_PATH || "";
if (input.type !== "success") {
  process.stdout.write(JSON.stringify(input));
  process.exit(0);
}
const text = String(input.text || "").trim();
process.stdout.write(JSON.stringify({
  type: "success",
  method,
  backend: "local-docker",
  projectPath,
  message: text,
  raw_text: text,
}));
NODE
}

run_local_graph() {
  local subcmd="$1"
  local project_path="$2"
  local file="${3:-}"
  local root
  root="$(resolve_local_project_root "$project_path" 2>/dev/null || printf '%s' "$LOCAL_PROJECT_ROOT")"
  if [[ -n "$file" ]]; then
    node "$SCRIPT_DIR/socraticode-graph-helper.js" "$subcmd" --file "$file" --projectPath "$root"
  else
    node "$SCRIPT_DIR/socraticode-graph-helper.js" "$subcmd" --projectPath "$root"
  fi
}

remote_probe() {
  local ps_script
  local encoded
  if remote_request codebase_status >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

normalize_remote_path() {
  local requested="${1:-}"
  local normalized
  local remote_norm
  local local_norm

  if [[ -z "$requested" ]]; then
    printf '\n'
    return 0
  fi

  normalized="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')"
  remote_norm="$(printf '%s' "$REMOTE_CANONICAL_PROJECT" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')"
  local_norm="$(printf '%s' "$LOCAL_PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')"

  case "$normalized" in
    "$remote_norm"|"$remote_norm"/*|d:/llm|d:/llm/*)
      printf '%s\n' "${requested//\//\\}"
      return 0
      ;;
    "$local_norm"|"$local_norm"/*)
      local suffix="${requested#"$LOCAL_PROJECT_ROOT"}"
      suffix="${suffix#\"}"
      suffix="${suffix#/}"
      suffix="${suffix//\//\\}"
      if [[ -n "$suffix" ]]; then
        printf '%s\\%s\n' "$REMOTE_CANONICAL_PROJECT" "$suffix"
      else
        printf '%s\n' "$REMOTE_CANONICAL_PROJECT"
      fi
      return 0
      ;;
  esac

  printf '%s\n' "$requested"
}

ps_quote() {
  local value="${1:-}"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

remote_node_request() {
  local ps_command="$1"
  local ps_script
  local encoded
  local output

  ps_script=$(cat <<PS
\$ErrorActionPreference = 'Stop'
${ps_command}
PS
)

  encoded="$(printf '%s' "$ps_script" | iconv -t UTF-16LE | base64 | tr -d '\n')"
  output="$(ssh_remote powershell -NoProfile -EncodedCommand "$encoded" 2>&1)" || {
    if printf '%s' "$output" | grep -qi "Operation not permitted\|connect to host .* port 22\|Connection timed out\|Operation timed out"; then
      return 1
    fi
    printf '%s\n' "$output" >&2
    return 1
  }
  printf '%s\n' "$output"
}

local_search_json() {
  local query="$1"
  local file_filter="$2"
  local language_filter="$3"
  local include_linked="$4"
  local limit="$5"
  local root="$6"

  SOCRATICODE_QUERY="$query" \
  SOCRATICODE_FILE_FILTER="$file_filter" \
  SOCRATICODE_LANGUAGE_FILTER="$language_filter" \
  SOCRATICODE_INCLUDE_LINKED="$include_linked" \
  SOCRATICODE_LIMIT="$limit" \
  SOCRATICODE_ROOT="$root" \
  node <<'NODE'
const { spawnSync } = require("child_process");
const path = require("path");

function normalizeRelative(filePath) {
  return filePath.replace(/\\/g, "/");
}

function languageMatches(filePath, languageFilter) {
  if (!languageFilter) return true;
  const ext = path.extname(filePath).toLowerCase();
  const mapping = {
    go: [".go"],
    javascript: [".js", ".mjs", ".cjs", ".jsx"],
    typescript: [".ts", ".tsx"],
    json: [".json"],
    yaml: [".yaml", ".yml"],
    markdown: [".md"],
    text: [".txt"],
    shell: [".sh", ".ps1"],
    sql: [".sql"],
    html: [".html"],
    css: [".css"],
    proto: [".proto"],
  };
  const allowed = mapping[String(languageFilter).toLowerCase()];
  if (!allowed) return true;
  return allowed.includes(ext);
}

const root = process.env.SOCRATICODE_ROOT || "/Users/earth/Documents/GitHub";
const query = (process.env.SOCRATICODE_QUERY || "").trim();
const fileFilter = (process.env.SOCRATICODE_FILE_FILTER || "").trim().toLowerCase();
const languageFilter = (process.env.SOCRATICODE_LANGUAGE_FILTER || "").trim();
const includeLinked = String(process.env.SOCRATICODE_INCLUDE_LINKED || "false") === "true";
const limit = Math.max(1, Math.min(Number(process.env.SOCRATICODE_LIMIT || 20) || 20, 100));

if (!query) {
  process.stdout.write(JSON.stringify({
    type: "error",
    method: "codebase_search",
    error: "Missing query parameter",
  }));
  process.exit(0);
}

const rg = spawnSync("rg", [
  "--json",
  "--hidden",
  "--glob", "!**/node_modules/**",
  "--glob", "!**/.git/**",
  "--glob", "!**/dist/**",
  "--glob", "!**/build/**",
  "-F",
  query,
  root,
], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

if (rg.error) {
  process.stdout.write(JSON.stringify({
    type: "error",
    method: "codebase_search",
    error: rg.error.message,
  }));
  process.exit(0);
}

const matches = [];
for (const line of (rg.stdout || "").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }

  if (event.type !== "match") continue;
  const file = normalizeRelative(path.relative(root, event.data.path.text));
  if (fileFilter && !file.toLowerCase().includes(fileFilter)) continue;
  if (!languageMatches(file, languageFilter)) continue;

  matches.push({
    file,
    line: event.data.line_number,
    snippet: event.data.lines.text.replace(/\r?\n$/, "").trim().slice(0, 240),
    score: 1,
  });

  if (matches.length >= limit) break;
}

process.stdout.write(JSON.stringify({
  type: "success",
  method: "codebase_search",
  message: matches.length > 0 ? `Found ${matches.length} matching lines for "${query}"` : `No matches found for "${query}"`,
  query,
  projectPath: root,
  includeLinked,
  count: matches.length,
  results: matches,
}));
NODE
}

local_symbol_json() {
  local name="$1"
  local file_filter="$2"
  local limit="$3"
  local root="$4"

  SOCRATICODE_NAME="$name" \
  SOCRATICODE_FILE_FILTER="$file_filter" \
  SOCRATICODE_LIMIT="$limit" \
  SOCRATICODE_ROOT="$root" \
  node <<'NODE'
const { spawnSync } = require("child_process");
const path = require("path");

function normalizeRelative(filePath) {
  return filePath.replace(/\\/g, "/");
}

function classify(line, symbolName) {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const checks = [
    { kind: "function", regex: new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`) },
    { kind: "class", regex: new RegExp(`^\\s*(?:export\\s+)?class\\s+${escaped}\\b`) },
    { kind: "type", regex: new RegExp(`^\\s*(?:export\\s+)?type\\s+${escaped}\\b`) },
    { kind: "interface", regex: new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escaped}\\b`) },
    { kind: "const", regex: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`) },
    { kind: "method", regex: new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?${escaped}\\s*\\(`) },
    { kind: "method", regex: new RegExp(`^\\s*func\\s*\\([^)]*\\)\\s*${escaped}\\s*\\(`) },
    { kind: "assignment", regex: new RegExp(`^\\s*${escaped}\\s*=\\s*(?:async\\s+)?\\(`) },
  ];
  for (const check of checks) {
    if (check.regex.test(line)) return check.kind;
  }
  return "reference";
}

const root = process.env.SOCRATICODE_ROOT || "/Users/earth/Documents/GitHub";
const name = (process.env.SOCRATICODE_NAME || "").trim();
const fileFilter = (process.env.SOCRATICODE_FILE_FILTER || "").trim().toLowerCase();
const limit = Math.max(1, Math.min(Number(process.env.SOCRATICODE_LIMIT || 20) || 20, 100));

if (!name) {
  process.stdout.write(JSON.stringify({
    type: "error",
    method: "codebase_symbol",
    error: "Missing name parameter",
  }));
  process.exit(0);
}

const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rg = spawnSync("rg", [
  "--json",
  "--hidden",
  "--glob", "!**/node_modules/**",
  "--glob", "!**/.git/**",
  "--glob", "!**/dist/**",
  "--glob", "!**/build/**",
  "-n",
  "-S",
  `\\b${escaped}\\b`,
  root,
], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

if (rg.error) {
  process.stdout.write(JSON.stringify({
    type: "error",
    method: "codebase_symbol",
    error: rg.error.message,
  }));
  process.exit(0);
}

const matches = [];
for (const line of (rg.stdout || "").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }

  if (event.type !== "match") continue;
  const file = normalizeRelative(path.relative(root, event.data.path.text));
  if (fileFilter && !file.toLowerCase().includes(fileFilter)) continue;

  const snippet = event.data.lines.text.replace(/\r?\n$/, "").trim().slice(0, 240);
  const kind = classify(snippet, name);
  matches.push({
    file,
    line: event.data.line_number,
    kind,
    isDefinition: kind !== "reference",
    snippet,
  });

  if (matches.length >= limit) break;
}

matches.sort((a, b) => Number(b.isDefinition) - Number(a.isDefinition) || a.file.localeCompare(b.file) || a.line - b.line);
const definition = matches.find((match) => match.isDefinition) || null;

process.stdout.write(JSON.stringify({
  type: "success",
  method: "codebase_symbol",
  message: matches.length > 0 ? `Found ${matches.length} matches for symbol "${name}"` : `No matches found for symbol "${name}"`,
  name,
  projectPath: root,
  count: matches.length,
  definition,
  matches,
}));
NODE
}

print_context() {
  local role="$1"
  local task_file="$2"
  local status_file="$3"
  local pm_output="$4"
  local task_title=""
  local freshness="unknown"
  local confidence="low"
  local status="unavailable"
  local backend="none"
  local note="Remote and local Docker SocratiCode were unreachable."

  if remote_backend_enabled && remote_probe; then
    backend="remote"
    freshness="current"
    confidence="medium"
    status="used"
    note="Remote SocratiCode TCP server responded to codebase_status on d:\\llm."
  elif local_backend_enabled && local_docker_probe; then
    backend="local-docker"
    freshness="current"
    confidence="medium"
    status="used"
    note="Local Docker SocratiCode responded to codebase_status for ${LOCAL_PROJECT_ROOT}."
  fi

  if [[ -f "$task_file" ]]; then
    task_title="$(grep -m1 '^# ' "$task_file" | sed 's/^# *//' || true)"
  fi

  cat <<EOF
freshness: $freshness
confidence: $confidence
status: $status
backend: $backend
project_path: $LOCAL_PROJECT_ROOT
role: ${role:-unknown}
task_title: ${task_title:-unknown}
task_file: ${task_file:-unknown}
status_file: ${status_file:-unknown}
pm_output: ${pm_output:-unknown}
queries:
  - "${role:-unknown} ${task_title:-task}"
note: "$note"
EOF
}

print_status() {
  local output=""
  if remote_backend_enabled; then
    output="$(remote_request codebase_status 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    format_local_status_json "$LOCAL_PROJECT_ROOT"
    return 0
  fi

  print_json_error "codebase_status" "Remote and local Docker SocratiCode are unavailable."
}

print_json_error() {
  local method="$1"
  local message="$2"

  node -e 'const [method, error] = process.argv.slice(1); process.stdout.write(JSON.stringify({ type: "error", method, error }));' "$method" "$message"
}

resolve_local_project_root() {
  local requested_root="${1:-}"
  local effective_root="$LOCAL_PROJECT_ROOT"

  if [[ -n "$requested_root" ]]; then
    effective_root="$requested_root"
  fi

  local normalized_root
  local local_norm
  normalized_root="$(printf '%s' "$effective_root" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')"
  local_norm="$(printf '%s' "$LOCAL_PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')"
  normalized_root="${normalized_root%/}"
  local_norm="${local_norm%/}"

  case "$normalized_root" in
    d:/llm|d:/llm/*)
      local suffix="${normalized_root#d:/llm}"
      suffix="${suffix#/}"
      if [[ -n "$suffix" ]]; then
        effective_root="$LOCAL_PROJECT_ROOT/$suffix"
      else
        effective_root="$LOCAL_PROJECT_ROOT"
      fi
      ;;
    "$local_norm/d:/llm"|"$local_norm/d:/llm"/*)
      # Relative-join mangling when local backend treats d:\llm as relative.
      local mangled_suffix="${normalized_root#"$local_norm/d:/llm"}"
      mangled_suffix="${mangled_suffix#/}"
      if [[ -n "$mangled_suffix" ]]; then
        effective_root="$LOCAL_PROJECT_ROOT/$mangled_suffix"
      else
        effective_root="$LOCAL_PROJECT_ROOT"
      fi
      ;;
  esac

  if [[ "$effective_root" != /* ]]; then
    effective_root="$(cd "$LOCAL_PROJECT_ROOT" 2>/dev/null && cd "$effective_root" 2>/dev/null && pwd -P || true)"
  fi

  if [[ -z "$effective_root" || ! -d "$effective_root" ]]; then
    return 1
  fi

  printf '%s\n' "$effective_root"
}

print_search() {
  local query=""
  local file_filter=""
  local language_filter=""
  local include_linked="false"
  local limit=""
  local min_score=""
  local project_path="$LOCAL_PROJECT_ROOT"
  local resolved_root="$REMOTE_CANONICAL_PROJECT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --query)
        query="${2:-}"
        shift 2
        ;;
      --fileFilter)
        file_filter="${2:-}"
        shift 2
        ;;
      --languageFilter)
        language_filter="${2:-}"
        shift 2
        ;;
      --includeLinked)
        include_linked="true"
        shift
        ;;
      --limit)
        limit="${2:-}"
        shift 2
        ;;
      --minScore)
        min_score="${2:-}"
        shift 2
        ;;
      --projectPath)
        project_path="${2:-}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -n "$project_path" ]]; then
    resolved_root="$(normalize_remote_path "$(resolve_local_project_root "$project_path" 2>/dev/null || printf '%s' "$project_path")")"
    [[ -n "$resolved_root" ]] || resolved_root="$REMOTE_CANONICAL_PROJECT"
  fi

  local ps_command="Set-Location $(ps_quote "$REMOTE_CANONICAL_PROJECT"); node $(ps_quote "$REMOTE_CANONICAL_PROJECT\\ai-dev-office\\scripts\\socraticode-central-query.js") codebase_search --query $(ps_quote "$query")"
  if [[ -n "$file_filter" ]]; then
    ps_command+=" --fileFilter $(ps_quote "$(normalize_remote_path "$file_filter")")"
  fi
  if [[ -n "$language_filter" ]]; then
    ps_command+=" --languageFilter $(ps_quote "$language_filter")"
  fi
  if [[ "$include_linked" == "true" ]]; then
    ps_command+=" --includeLinked true"
  fi
  if [[ -n "$limit" ]]; then
    ps_command+=" --limit $(ps_quote "$limit")"
  fi
  ps_command+=" --projectPath $(ps_quote "$resolved_root")"
  if remote_backend_enabled; then
    local output=""
    output="$(remote_node_request "$ps_command" 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    local local_root
    local_root="$(resolve_local_project_root "$project_path" 2>/dev/null || printf '%s' "$LOCAL_PROJECT_ROOT")"
    local extra_args=(--query "$query")
    [[ -n "$limit" ]] && extra_args+=(--limit "$limit")
    [[ -n "$file_filter" ]] && extra_args+=(--fileFilter "$file_filter")
    [[ -n "$language_filter" ]] && extra_args+=(--languageFilter "$language_filter")
    format_local_tool_json "codebase_search" "$local_root" "${extra_args[@]}"
    return 0
  fi

  print_json_error "codebase_search" "Remote and local Docker SocratiCode are unavailable."
}

print_symbol() {
  local name=""
  local file=""
  local limit=""
  local project_path="$LOCAL_PROJECT_ROOT"
  local resolved_root="$REMOTE_CANONICAL_PROJECT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)
        name="${2:-}"
        shift 2
        ;;
      --file)
        file="${2:-}"
        shift 2
        ;;
      --projectPath)
        project_path="${2:-}"
        shift 2
        ;;
      --limit)
        limit="${2:-}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -n "$project_path" ]]; then
    resolved_root="$(normalize_remote_path "$(resolve_local_project_root "$project_path" 2>/dev/null || printf '%s' "$project_path")")"
    [[ -n "$resolved_root" ]] || resolved_root="$REMOTE_CANONICAL_PROJECT"
  fi

  local ps_command="Set-Location $(ps_quote "$REMOTE_CANONICAL_PROJECT"); node $(ps_quote "$REMOTE_CANONICAL_PROJECT\\ai-dev-office\\scripts\\socraticode-central-query.js") codebase_symbol --name $(ps_quote "$name")"
  if [[ -n "$file" ]]; then
    ps_command+=" --file $(ps_quote "$(normalize_remote_path "$file")")"
  fi
  if [[ -n "$limit" ]]; then
    ps_command+=" --limit $(ps_quote "$limit")"
  fi
  ps_command+=" --projectPath $(ps_quote "$resolved_root")"
  if remote_backend_enabled; then
    local output=""
    output="$(remote_node_request "$ps_command" 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    local local_root
    local_root="$(resolve_local_project_root "$project_path" 2>/dev/null || printf '%s' "$LOCAL_PROJECT_ROOT")"
    local extra_args=(--name "$name")
    [[ -n "$file" ]] && extra_args+=(--file "$file")
    [[ -n "$limit" ]] && extra_args+=(--limit "$limit")
    format_local_tool_json "codebase_symbol" "$local_root" "${extra_args[@]}"
    return 0
  fi

  print_json_error "codebase_symbol" "Remote and local Docker SocratiCode are unavailable."
}

print_graph_query() {
  local file=""
  local project_path="$GRAPH_PROJECT_ROOT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file)
        file="${2:-}"
        shift 2
        ;;
      --projectPath)
        project_path="${2:-}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  local ps_command="Set-Location $(ps_quote "$REMOTE_CANONICAL_PROJECT"); node $(ps_quote "$REMOTE_CANONICAL_PROJECT\\ai-dev-office\\scripts\\socraticode-graph-helper.js") codebase_graph_query --file $(ps_quote "$(normalize_remote_path "$file")") --projectPath $(ps_quote "$(normalize_remote_path "$project_path")")"
  if remote_backend_enabled; then
    local output=""
    output="$(remote_node_request "$ps_command" 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    run_local_graph codebase_graph_query "$project_path" "$file"
    return 0
  fi

  print_json_error "codebase_graph_query" "Remote and local graph analysis are unavailable."
}

print_graph_stats() {
  local project_path="$GRAPH_PROJECT_ROOT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --projectPath)
        project_path="${2:-}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  local ps_command="Set-Location $(ps_quote "$REMOTE_CANONICAL_PROJECT"); node $(ps_quote "$REMOTE_CANONICAL_PROJECT\\ai-dev-office\\scripts\\socraticode-graph-helper.js") codebase_graph_stats --projectPath $(ps_quote "$(normalize_remote_path "$project_path")")"
  if remote_backend_enabled; then
    local output=""
    output="$(remote_node_request "$ps_command" 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    run_local_graph codebase_graph_stats "$project_path"
    return 0
  fi

  print_json_error "codebase_graph_stats" "Remote and local graph analysis are unavailable."
}

print_graph_circular() {
  local project_path="$GRAPH_PROJECT_ROOT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --projectPath)
        project_path="${2:-}"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        shift
        ;;
    esac
  done

  local ps_command="Set-Location $(ps_quote "$REMOTE_CANONICAL_PROJECT"); node $(ps_quote "$REMOTE_CANONICAL_PROJECT\\ai-dev-office\\scripts\\socraticode-graph-helper.js") codebase_graph_circular --projectPath $(ps_quote "$(normalize_remote_path "$project_path")")"
  if remote_backend_enabled; then
    local output=""
    output="$(remote_node_request "$ps_command" 2>/dev/null || true)"
    if json_is_success "$output"; then
      printf '%s\n' "$output"
      return 0
    fi
  fi

  if local_backend_enabled; then
    run_local_graph codebase_graph_circular "$project_path"
    return 0
  fi

  print_json_error "codebase_graph_circular" "Remote and local graph analysis are unavailable."
}

cmd="${1:-context}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$cmd" in
  context)
    role=""
    task_file=""
    status_file=""
    pm_output=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --role)
          role="${2:-}"
          shift 2
          ;;
        --task-file)
          task_file="${2:-}"
          shift 2
          ;;
        --status-file)
          status_file="${2:-}"
          shift 2
          ;;
        --pm-output)
          pm_output="${2:-}"
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        *)
          shift
          ;;
      esac
    done
    print_context "$role" "$task_file" "$status_file" "$pm_output"
    ;;
  codebase_status)
    print_status
    ;;
  codebase_search)
    print_search "$@"
    ;;
  codebase_symbol)
    print_symbol "$@"
    ;;
  codebase_graph_query)
    print_graph_query "$@"
    ;;
  codebase_graph_stats)
    print_graph_stats "$@"
    ;;
  codebase_graph_circular)
    print_graph_circular "$@"
    ;;
  --help|-h|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
