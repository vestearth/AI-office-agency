#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$OFFICE_DIR/.." && pwd)}"
# Allow explicit override for callers/tests to avoid environment collision
if [[ -n "${GUARD_WORKSPACE_ROOT:-}" ]]; then
  WORKSPACE_ROOT="$GUARD_WORKSPACE_ROOT"
fi

# Configurable behavior
# SHARED_LIB_POLICY: aligned|latest (default: aligned)
SHARED_LIB_POLICY="${SHARED_LIB_POLICY:-aligned}"

# EXCLUDED_SERVICES may be provided as a comma-separated env var, e.g. EXCLUDED_SERVICES=Foo,Bar
if [[ -n "${EXCLUDED_SERVICES:-}" ]]; then
  IFS=',' read -r -a EXCLUDED_SERVICES_ARRAY <<<"$EXCLUDED_SERVICES"
else
  EXCLUDED_SERVICES_ARRAY=("Games-Labs-Provider")
fi

# BUILD_TARGET: default build target for CI-parity compile (e.g. ./cmd or ./...)
BUILD_TARGET="${BUILD_TARGET:-./cmd}"

SERVICES=("$@")

is_excluded_service() {
  local candidate="$1"
  for excluded in "${EXCLUDED_SERVICES_ARRAY[@]}"; do
    if [[ "$candidate" == "$excluded" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  while IFS= read -r go_mod_file; do
    service_dir="${go_mod_file%/go.mod}"
    service_name="${service_dir##*/}"

    # Skip shared-lib itself; guard applies to dependent repos.
    if [[ "$service_name" == "shared-lib" ]]; then
      continue
    fi

    if is_excluded_service "$service_name"; then
      continue
    fi

    SERVICES+=("$service_name")
  done < <(rg -l "github.com/SparqLab/shared-lib" "$WORKSPACE_ROOT" --glob "**/go.mod")
else
  filtered_services=()
  for service_name in "${SERVICES[@]}"; do
    if is_excluded_service "$service_name"; then
      echo "[INFO] skipping excluded repository: $service_name"
      continue
    fi
    filtered_services+=("$service_name")
  done
  SERVICES=("${filtered_services[@]}")
fi

errors=0
shared_versions=()
latest_shared_lib_version=""
# pinned version (when SHARED_LIB_POLICY=pinned)
pinned_shared_lib_version=""

fail() {
  echo "[FAIL] $1"
  errors=$((errors + 1))
}

info() {
  echo "[INFO] $1"
}

# Debug helper controlled by DEBUG_GUARD env var
DEBUG_GUARD="${DEBUG_GUARD:-false}"
debug() {
  if [[ "$DEBUG_GUARD" == "true" ]]; then
    echo "[DEBUG] $*" >&2
  fi
}

resolve_latest_shared_lib() {
  # Resolve the latest version once, then enforce all services against it.
  latest_shared_lib_version="$(
    cd "$WORKSPACE_ROOT" &&
      GOWORK=off go list -m -mod=mod -f '{{.Version}}' github.com/SparqLab/shared-lib@latest 2>/dev/null || true
  )"

  if [[ -z "$latest_shared_lib_version" ]]; then
    fail "unable to resolve github.com/SparqLab/shared-lib@latest (check network/access and Go environment)"
  else
    info "resolved shared-lib@latest => $latest_shared_lib_version"
  fi
}

# Only resolve remote latest when policy explicitly requests it. This avoids
# network/private module access on every run for deterministic checks.
if [[ "$SHARED_LIB_POLICY" == "latest" ]]; then
  resolve_latest_shared_lib
elif [[ "$SHARED_LIB_POLICY" == "pinned" ]]; then
  # allow tests/callers to pass pinned version directly via GUARD_SHARED_LIB_VERSION
  if [[ -n "${GUARD_SHARED_LIB_VERSION:-}" ]]; then
    pinned_shared_lib_version="$GUARD_SHARED_LIB_VERSION"
    info "using pinned shared-lib version => $pinned_shared_lib_version (from GUARD_SHARED_LIB_VERSION)"
  else
    # read pinned version from .shared-lib-version at workspace root, with fallback to office parent
    pinned_file_candidates=("$WORKSPACE_ROOT/.shared-lib-version" "$OFFICE_DIR/../.shared-lib-version")
    for candidate in "${pinned_file_candidates[@]}"; do
      if [[ -f "$candidate" ]]; then
        pinned_file="$candidate"
        break
      fi
    done
    if [[ -z "${pinned_file:-}" || ! -f "$pinned_file" ]]; then
      fail "SHARED_LIB_POLICY=pinned but no .shared-lib-version found in expected locations"
    else
      pinned_shared_lib_version="$(tr -d '\n' < "$pinned_file" )"
      if [[ -z "$pinned_shared_lib_version" ]]; then
        fail "pinned shared-lib version file $pinned_file is empty"
      fi
      info "using pinned shared-lib version => $pinned_shared_lib_version (from $pinned_file)"
    fi
  fi
else
  info "SHARED_LIB_POLICY=$SHARED_LIB_POLICY; skipping network resolution of shared-lib@latest"
fi

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  fail "no repositories found that depend on github.com/SparqLab/shared-lib"
fi

info "guarded repositories: ${SERVICES[*]}"
debug "WORKSPACE_ROOT=$WORKSPACE_ROOT GUARD_WORKSPACE_ROOT=${GUARD_WORKSPACE_ROOT:-} OFFICE_DIR=$OFFICE_DIR"

for service in "${SERVICES[@]}"; do
  service_dir="$WORKSPACE_ROOT/$service"
  debug "checking service '$service' at path: $service_dir"
  go_mod_file="$service_dir/go.mod"
  dockerfile="$service_dir/Dockerfile"

  if [[ ! -d "$service_dir" ]]; then
    fail "$service: service directory not found at $service_dir"
    continue
  fi

  if [[ -f "$service_dir/go.work" ]]; then
    fail "$service: go.work is not allowed. Remove $service_dir/go.work"
  fi

  if [[ ! -f "$go_mod_file" ]]; then
    fail "$service: missing go.mod"
    continue
  fi

  if rg -n "^replace\\s+" "$go_mod_file" >/dev/null 2>&1; then
    fail "$service: go.mod must not contain any replace directive"
  fi

  shared_lib_version="$(awk '/github.com\/SparqLab\/shared-lib/ {print $2; exit}' "$go_mod_file")"
  if [[ -z "$shared_lib_version" ]]; then
    fail "$service: github.com/SparqLab/shared-lib not found in go.mod"
  else
    shared_versions+=("${service}:${shared_lib_version}")
    info "$service: shared-lib version $shared_lib_version"
  fi

  if [[ -f "$dockerfile" ]]; then
    if rg -n "go mod tidy" "$dockerfile" >/dev/null 2>&1; then
      fail "$service: Dockerfile must not run 'go mod tidy' during image build"
    fi

    if ! rg -n "go build( .*| )-mod=readonly" "$dockerfile" >/dev/null 2>&1; then
      fail "$service: Dockerfile build step must use 'go build -mod=readonly'"
    fi

  else
    fail "$service: missing Dockerfile"
  fi
done

reference_version=""
reference_service=""
for pair in "${shared_versions[@]:-}"; do
  service="${pair%%:*}"
  version="${pair#*:}"
  if [[ -z "$reference_version" ]]; then
    reference_version="$version"
    reference_service="$service"
    continue
  fi
  if [[ "$version" != "$reference_version" ]]; then
    fail "shared-lib version mismatch: $service uses $version, expected $reference_version (from $reference_service)"
  fi
done

# Policy-specific checks
case "$SHARED_LIB_POLICY" in
  aligned)
    # already enforced above: all services must match one reference version
    ;;
  latest)
    if [[ -z "$latest_shared_lib_version" ]]; then
      fail "SHARED_LIB_POLICY=latest but could not resolve latest shared-lib version"
    else
      for pair in "${shared_versions[@]:-}"; do
        service="${pair%%:*}"
        version="${pair#*:}"
        if [[ "$version" != "$latest_shared_lib_version" ]]; then
          fail "shared-lib latest mismatch: $service uses $version, expected latest $latest_shared_lib_version"
        fi
      done
    fi
    ;;
  pinned)
    if [[ -z "$pinned_shared_lib_version" ]]; then
      fail "SHARED_LIB_POLICY=pinned but no pinned_shared_lib_version available"
    else
      for pair in "${shared_versions[@]:-}"; do
        service="${pair%%:*}"
        version="${pair#*:}"
        if [[ "$version" != "$pinned_shared_lib_version" ]]; then
          fail "shared-lib pinned mismatch: $service uses $version, expected pinned $pinned_shared_lib_version"
        fi
      done
    fi
    ;;
  *)
    fail "unknown SHARED_LIB_POLICY: $SHARED_LIB_POLICY"
    ;;
esac

for service in "${SERVICES[@]}"; do
  service_dir="$WORKSPACE_ROOT/$service"
  [[ -d "$service_dir" ]] || continue
  [[ -f "$service_dir/go.mod" ]] || continue

  info "$service: running CI-parity compile with GOWORK=off"
  if ! (
    cd "$service_dir"
    GOWORK=off GOFLAGS=-mod=readonly go build -o "/tmp/${service}-dependency-guard-bin" $BUILD_TARGET
  ); then
    fail "$service: CI-parity build failed (GOWORK=off GOFLAGS=-mod=readonly go build $BUILD_TARGET)"
  fi
done

if [[ "$errors" -gt 0 ]]; then
  echo "[ERROR] dependency guard failed with $errors issue(s)"
  exit 1
fi

echo "[PASS] dependency guard passed for services: ${SERVICES[*]}"
