#!/usr/bin/env bash
# Cursor/Claude MCP entrypoint: prefer remote SocratiCode, fall back to local Docker.
# Fail fast when the host is unreachable (ConnectTimeout) and never hang on an
# auth prompt (BatchMode). Local fallback remaps d:\llm → local workspace root.
#
# Portable defaults (override with env):
#   SOCRATICODE_LOCAL_PROJECT / SOCRATICODE_FALLBACK_PROJECT
#   SOCRATICODE_LOCAL_MCP_PROXY
#   SOCRATICODE_REMOTE_* / SOCRATICODE_REMOTE_CANONICAL_PROJECT
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [[ -h "$SCRIPT_SOURCE" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" != /* ]] && SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" && pwd)"
# ai-dev-office/scripts → workspace root (parent of ai-dev-office)
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REMOTE_HOST="${SOCRATICODE_REMOTE_HOST:-socraticode@192.168.1.140}"
REMOTE_SSH_KEY="${SOCRATICODE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_PORT="${SOCRATICODE_REMOTE_PORT:-4444}"
LOCAL_PROJECT="${SOCRATICODE_LOCAL_PROJECT:-${SOCRATICODE_FALLBACK_PROJECT:-$REPO_ROOT}}"
LOCAL_PROXY="${SOCRATICODE_LOCAL_MCP_PROXY:-$SCRIPT_DIR/socraticode-local-mcp-proxy.mjs}"
NODE_BIN="${SOCRATICODE_NODE:-$(command -v node || true)}"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

export SOCRATICODE_LOCAL_PROJECT="$LOCAL_PROJECT"

if [[ ! -f "$LOCAL_PROXY" ]]; then
  echo "socraticode-remote: local MCP proxy not found: $LOCAL_PROXY" >&2
  echo "Set SOCRATICODE_LOCAL_MCP_PROXY or install ai-dev-office/scripts next to the workspace root." >&2
  exit 1
fi

ssh -i "$REMOTE_SSH_KEY" -T \
  -o ConnectTimeout=5 -o BatchMode=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  "$REMOTE_HOST" \
  "powershell -ExecutionPolicy Bypass -NoProfile -Command \"\$env:SOCRATICODE_REMOTE_PORT='$REMOTE_PORT'; cd D:\\llm; npx.cmd -y socraticode\"" \
  || exec "$NODE_BIN" "$LOCAL_PROXY"
