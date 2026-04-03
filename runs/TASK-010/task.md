# TASK-010: Standardize Shared-Lib Dependency Management & Dockerfile Cleanup

## Description
Previously, services used local `replace` directives (`replace github.com/SparqLab/shared-lib => ../shared-lib`) in their `go.mod` files for local development. This caused Docker builds to fail because the local `../shared-lib` path is unavailable inside the Docker context.

We have decided to **permanently remove** the local `replace` directives from all microservices and rely strictly on fetching the latest `shared-lib` module from the private GitHub repository during both local development and Docker builds.

This task is to clean up the residual workarounds from the Dockerfiles and ensure all `go.mod` files are standardized.

## Objectives
1. **Audit All `go.mod` Files**: Check the `go.mod` file inside every microservice repository:
   - `Games-Labs-Auth`
   - `Games-Labs-Game`
   - `Games-Labs-Logs`
   - `Games-Labs-Missions`
   - `Games-Labs-Order`
   - `Games-Labs-Provider`
   - `Games-Labs-User`
   - `Games-Labs-Wallet`
   - `api-gateway`
   Ensure that **no** `replace github.com/SparqLab/shared-lib` directives exist. If found, remove them and run `go get github.com/SparqLab/shared-lib@latest` followed by `go mod tidy`.

2. **Clean Up Dockerfiles**: Since the `replace` directive is permanently removed from the source code, the previous Dockerfile workarounds are no longer needed.
   - Remove any instances of `RUN go mod edit -dropreplace github.com/SparqLab/shared-lib || true` from all Dockerfiles.
   - Remove any instances of `RUN sed -i '/replace.../d' go.mod` from all Dockerfiles.
   - Ensure the build secret `GH_PAT` usage remains intact for `go mod download` and `go mod tidy` / `go build`.

## Technical Requirements
- Ensure all services can build successfully using the remote `shared-lib` module.
- Keep the Dockerfiles clean, maintaining only the necessary `GH_PAT` configuration for accessing private modules.

## Assigned Agent
`dev-2`
