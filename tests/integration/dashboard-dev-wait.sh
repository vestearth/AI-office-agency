#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_JSON="$ROOT_DIR/dashboard/package.json"

node - "$PACKAGE_JSON" <<'NODE'
const fs = require('fs');

const packageJsonPath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const devScript = pkg.scripts && pkg.scripts.dev;
const waitScript = pkg.scripts && pkg.scripts['wait:server'];
const devScriptPath = packageJsonPath.replace(/package\.json$/, 'scripts/dev.js');

if (typeof devScript !== 'string') {
  throw new Error('dashboard/package.json must define scripts.dev');
}

if (typeof waitScript !== 'string') {
  throw new Error('dashboard/package.json must define scripts.wait:server');
}

if (!devScript.includes('scripts/dev.js')) {
  throw new Error('dashboard dev script must use dashboard/scripts/dev.js');
}

if (!waitScript.includes('scripts/wait-for-api.js')) {
  throw new Error('scripts.wait:server must use dashboard/scripts/wait-for-api.js');
}

const devScriptSource = fs.readFileSync(devScriptPath, 'utf8');
if (!devScriptSource.includes('process.argv.slice(2)')) {
  throw new Error('dashboard dev helper must read extra npm args from process.argv');
}

const waitScriptSource = fs.readFileSync(packageJsonPath.replace(/package\.json$/, 'scripts/wait-for-api.js'), 'utf8');
if (!waitScriptSource.includes('http://localhost:4310/api/health')) {
  throw new Error('dashboard wait helper must default to http://localhost:4310/api/health');
}

const waitIndex = devScriptSource.indexOf('npm run wait:server');
const clientIndex = devScriptSource.indexOf('npm run dev:client --');
if (waitIndex === -1 || clientIndex === -1 || waitIndex > clientIndex) {
  throw new Error('dashboard dev script must wait for the server before starting the client');
}

if (!devScriptSource.includes('forwardedClientArgs')) {
  throw new Error('dashboard dev helper must forward extra npm args to the client dev process');
}

if (!devScriptSource.includes('npm run dev:server')) {
  throw new Error('dashboard dev script must still start the server dev process');
}

if (!devScriptSource.includes('npm run dev:client')) {
  throw new Error('dashboard dev script must still start the client dev process');
}
NODE

dry_run_output="$(cd "$ROOT_DIR/dashboard" && DASHBOARD_DEV_DRY_RUN=1 npm run dev -- --host 0.0.0.0)"

if [[ "$dry_run_output" != *"npm run dev:client -- --host 0.0.0.0"* ]]; then
  echo "$dry_run_output" >&2
  echo "dashboard dev helper must forward --host args to the client command" >&2
  exit 1
fi

echo "[PASS] dashboard-dev-wait: dev helper forwards args and waits for the API"
