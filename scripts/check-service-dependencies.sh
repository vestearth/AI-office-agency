#!/usr/bin/env bash
set -euo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$OFFICE_DIR/.." && pwd)}"
EXCLUDED_SERVICES=("Games-Labs-Provider")

SERVICES=("$@")

is_excluded_service() {
  local candidate="$1"
  for excluded in "${EXCLUDED_SERVICES[@]}"; do
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

fail() {
  echo "[FAIL] $1"
  errors=$((errors + 1))
}

info() {
  echo "[INFO] $1"
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

resolve_latest_shared_lib

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  fail "no repositories found that depend on github.com/SparqLab/shared-lib"
fi

info "guarded repositories: ${SERVICES[*]}"

for service in "${SERVICES[@]}"; do
  service_dir="$WORKSPACE_ROOT/$service"
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
for pair in "${shared_versions[@]}"; do
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

if [[ -n "$latest_shared_lib_version" ]]; then
  for pair in "${shared_versions[@]}"; do
    service="${pair%%:*}"
    version="${pair#*:}"
    if [[ "$version" != "$latest_shared_lib_version" ]]; then
      fail "shared-lib latest mismatch: $service uses $version, expected latest $latest_shared_lib_version"
    fi
  done
fi

for service in "${SERVICES[@]}"; do
  service_dir="$WORKSPACE_ROOT/$service"
  [[ -d "$service_dir" ]] || continue
  [[ -f "$service_dir/go.mod" ]] || continue

  info "$service: running CI-parity compile with GOWORK=off"
  if ! (
    cd "$service_dir"
    GOWORK=off GOFLAGS=-mod=readonly go build -o "/tmp/${service}-dependency-guard-bin" ./cmd
  ); then
    fail "$service: CI-parity build failed (GOWORK=off GOFLAGS=-mod=readonly go build ./cmd)"
  fi
done

if [[ "$errors" -gt 0 ]]; then
  echo "[ERROR] dependency guard failed with $errors issue(s)"
  exit 1
fi

echo "[PASS] dependency guard passed for services: ${SERVICES[*]}"
