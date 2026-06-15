# TASK-096 Verification Evidence

Date: 2026-06-15

## Commands

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Missions
go test ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Missions
GOWORK=off go build -mod=readonly ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub/shared-lib
make buf
go test ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub
node -e 'for (const p of ["api-gateway/docs/Games-Labs-APIs.postman_collection.json","docs/Games-Labs-APIs.postman_collection.json"]){JSON.parse(require("fs").readFileSync(p,"utf8")); console.log(p+": ok")}'
```

Result: both Postman collection JSON files parsed successfully.

```bash
cd /Users/earth/Documents/GitHub/ai-dev-office
ruby validate-yaml.rb TASK-096
```

Result: `Validation passed: TASK-096`.

```bash
cd /Users/earth/Documents/GitHub/api-gateway
go test ./...
GOWORK=off go build -mod=readonly ./...
```

Result: passed.

## Remaining Gate

The original shared-lib publish gate has been cleared. On 2026-06-15,
`shared-lib` main was verified at `c2ee35cb5a67`, then `Games-Labs-Missions`
and `api-gateway` were bumped to
`github.com/SparqLab/shared-lib v0.0.0-20260615054934-c2ee35cb5a67` without
local `replace` directives.

Additional verification after unblock:

```bash
cd /Users/earth/Documents/GitHub/Games-Labs-Missions
go test ./internal/handlers/mission/grpc -count=1
go test ./...
GOWORK=off go build -mod=readonly ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub/api-gateway
go test ./...
GOWORK=off go build -mod=readonly ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub
node -e 'for (const p of ["api-gateway/docs/Games-Labs-APIs.postman_collection.json","docs/Games-Labs-APIs.postman_collection.json"]){JSON.parse(require("fs").readFileSync(p,"utf8")); console.log(p+": ok")}'
```

Result: both Postman collection JSON files parsed successfully.

Closure update on 2026-06-15:

```bash
cd /Users/earth/Documents/GitHub/api-gateway
go test ./...
GOWORK=off go build -mod=readonly ./...
```

Result: passed.

```bash
cd /Users/earth/Documents/GitHub
node -e 'for (const p of ["api-gateway/docs/Games-Labs-APIs.postman_collection.json"]){JSON.parse(require("fs").readFileSync(p,"utf8")); console.log(p+": ok")}'
```

Result: Postman collection JSON parsed successfully.

```bash
cd /Users/earth/Documents/GitHub/ai-dev-office
ruby validate-yaml.rb TASK-096
```

Result: `Validation passed: TASK-096`.

The task was closed after review found no blocking issue. Deploy smoke for
`POST /api/v1/missions/check-in/days/{day}/claim` remains an external rollout
activity, not an open task blocker.
