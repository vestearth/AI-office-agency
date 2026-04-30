#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD_SCRIPT="$ROOT_DIR/scripts/check-service-dependencies.sh"

cleanup() {
  rm -rf "$WORKSPACE_ROOT"
  # remove any pinned file placed at repo parent
  REPO_PARENT="$(cd "$ROOT_DIR/.." && pwd)"
  [[ -f "$REPO_PARENT/.shared-lib-version" ]] && rm -f "$REPO_PARENT/.shared-lib-version"
}
trap cleanup EXIT

  # remove any pinned file placed at repo parent
  REPO_PARENT="$(cd "$ROOT_DIR/.." && pwd)"
  [[ -f "$REPO_PARENT/.shared-lib-version" ]] && rm -f "$REPO_PARENT/.shared-lib-version"

assert_fail() {
  local cmd="$1"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "[FAIL] expected command to fail: $cmd"
    exit 1
  fi
}

assert_pass() {
  local cmd="$1"
  if ! eval "$cmd" >/dev/null 2>&1; then
    echo "[FAIL] expected command to pass: $cmd"
    exit 1
  fi
}

WORKSPACE_ROOT="$(mktemp -d)"

echo "Workspace: $WORKSPACE_ROOT"

# Helper to create a minimal Go module
create_service() {
  local name="$1"
  local mod_require="$2" # e.g. github.com/SparqLab/shared-lib v0.1.0
  local dockerfile_content="${3:-}"
  local replace_directive="${4:-}" # optional replace content
  mkdir -p "$WORKSPACE_ROOT/$name"
  cat > "$WORKSPACE_ROOT/$name/go.mod" <<EOF
module $name

go 1.21

require (
  $mod_require
)
EOF
  if [[ -n "$replace_directive" ]]; then
    echo "$replace_directive" >> "$WORKSPACE_ROOT/$name/go.mod"
  fi

  # default Dockerfile if not provided
  if [[ -z "$dockerfile_content" ]]; then
    dockerfile_content=$'FROM golang:1.21
WORKDIR /src
COPY . .
RUN go build -o app -mod=readonly ./cmd
'
  fi
  echo "$dockerfile_content" > "$WORKSPACE_ROOT/$name/Dockerfile"
}

echo "== Scenario: replace directive fails =="
create_service "svc-replace" "github.com/SparqLab/shared-lib v0.0.1" "" "replace github.com/SparqLab/shared-lib => ../shared-lib"
assert_fail "WORKSPACE_ROOT=$WORKSPACE_ROOT $GUARD_SCRIPT svc-replace"

echo "== Scenario: Dockerfile with 'go mod tidy' fails =="
create_service "svc-tidy" "github.com/SparqLab/shared-lib v0.0.1" $'FROM golang:1.21\nRUN go mod tidy\n'
assert_fail "WORKSPACE_ROOT=$WORKSPACE_ROOT $GUARD_SCRIPT svc-tidy"

echo "== Scenario: Dockerfile missing go build -mod=readonly fails =="
create_service "svc-nomodflag" "github.com/SparqLab/shared-lib v0.0.1" $'FROM golang:1.21\nRUN go build ./cmd\n'
assert_fail "WORKSPACE_ROOT=$WORKSPACE_ROOT $GUARD_SCRIPT svc-nomodflag"

echo "== Scenario: shared-lib mismatch fails under aligned policy =="
create_service "svc-a" "github.com/SparqLab/shared-lib v1.2.0" ""
create_service "svc-b" "github.com/SparqLab/shared-lib v1.3.0" ""
# run against both services; should fail due to mismatch
assert_fail "WORKSPACE_ROOT=$WORKSPACE_ROOT SHARED_LIB_POLICY=aligned $GUARD_SCRIPT svc-a svc-b"

echo "== Scenario: excluded service is skipped =="
create_service "svc-excluded" "github.com/SparqLab/shared-lib v0.0.1" ""
create_service "svc-ok" "github.com/SparqLab/shared-lib v0.0.1" ""
# provide a minimal ./cmd for svc-ok so compile step passes
mkdir -p "$WORKSPACE_ROOT/svc-ok/cmd"
cat > "$WORKSPACE_ROOT/svc-ok/go.mod" <<EOF
module svc-ok

go 1.21

require (
  github.com/SparqLab/shared-lib v0.0.1
)
EOF
cat > "$WORKSPACE_ROOT/svc-ok/cmd/main.go" <<'GO'
package main
import "fmt"
func main(){ fmt.Println("ok") }
GO
# mark svc-excluded as excluded
assert_pass "WORKSPACE_ROOT=$WORKSPACE_ROOT EXCLUDED_SERVICES=svc-excluded $GUARD_SCRIPT svc-excluded svc-ok"

echo "== Scenario: valid service passes CI-parity build =="
# create a simple main in ./cmd so go build succeeds
mkdir -p "$WORKSPACE_ROOT/svc-valid/cmd"
cat > "$WORKSPACE_ROOT/svc-valid/go.mod" <<EOF
module svc-valid

go 1.21

require (
  github.com/SparqLab/shared-lib v0.0.1
)
EOF
cat > "$WORKSPACE_ROOT/svc-valid/cmd/main.go" <<'GO'
package main
import "fmt"
func main(){ fmt.Println("ok") }
GO
echo $'FROM golang:1.21\nWORKDIR /src\nCOPY . .\nRUN go build -o app -mod=readonly ./cmd\n' > "$WORKSPACE_ROOT/svc-valid/Dockerfile"

assert_pass "WORKSPACE_ROOT=$WORKSPACE_ROOT BUILD_TARGET=./cmd $GUARD_SCRIPT svc-valid"

echo "== Scenario: pinned policy enforces .shared-lib-version (via env) =="
create_service "svc-p1" "github.com/SparqLab/shared-lib v9.9.9" ""
create_service "svc-p2" "github.com/SparqLab/shared-lib v9.9.9" ""
assert_pass "env GUARD_WORKSPACE_ROOT=$WORKSPACE_ROOT GUARD_SHARED_LIB_VERSION=v9.9.9 SHARED_LIB_POLICY=pinned $GUARD_SCRIPT svc-p1 svc-p2"

echo "== Scenario: pinned policy fails when mismatch =="
create_service "svc-pbad" "github.com/SparqLab/shared-lib v9.9.8" ""
assert_fail "env GUARD_WORKSPACE_ROOT=$WORKSPACE_ROOT GUARD_SHARED_LIB_VERSION=v9.9.9 SHARED_LIB_POLICY=pinned $GUARD_SCRIPT svc-p1 svc-pbad"

echo "[PASS] dependency guard integration tests passed"
