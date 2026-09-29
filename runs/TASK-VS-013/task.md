# TASK-VS-013 — Stop slip-api boot migrations logging full SQL

## Problem
TASK-VS-011 switched migrations.Run to a goose Provider with WithVerbose(true).
Verbose mode logs every SQL statement ("Excuting statement: ...") of each
pending migration at boot, which floods logs and would leak any data a future
migration seeds.

## Scope
- Drop WithVerbose; log one line per applied migration (name + duration) and
  the resulting version, so deploy checks can still find "goose: OK up <file>".
- Regression test that migration output contains the OK line but not the SQL.
