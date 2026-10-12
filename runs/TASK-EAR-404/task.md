# TASK-EAR-404: Dashboard CLI adapters: complete Codex and add Claude execution

## Goal
Continue the Dashboard CLI integration. The operator will give Claude and Codex this task to finish their own CLI adapters. Work on the Dashboard framework, NOT on TASK-EAR-234 (only used for UI inspection).

## Workspace
C:/Code/Earth-brain/AI-office-agency. Existing implementation is UNCOMMITTED in this checkout. Inspect git status and preserve all changes. No agents have been dispatched by this handoff.

## Current implementation
- dashboard/server/src/services/cliRunner.ts: Codex discovery on PATH; spawn without shell; prompt via stdin; read-only/workspace-write; duplicate-run prevention; bounded output; timeout; process-tree Stop; shutdown cleanup.
- dashboard/server/src/routes/cli.ts: localhost/Origin/auth boundary, CLI availability and start/status/stop API, existing-task and Git-workspace validation.
- dashboard/server/src/services/cliRunner.test.ts: 5 passing tests, including installed Codex help mode and Stop of a real descendant process.
- dashboard/server/src/index.ts: route and shutdown wiring.
- dashboard/client/src/views/DesktopHandoffDialog.tsx, CliRunPanel.tsx, CommandView.tsx and styles/globals.css: prompt/workspace/role preview, permission selection, Run/Stop and polled output.
- dashboard/README.md: API and current limitations.
- scripts/open-task.rb: small Windows portability fix made while opening this task; native Windows Ruby does not support HUP, so only INT/TERM are registered on mswin/mingw. Unix still registers HUP.

## Claude lane
Check the actual installed Claude CLI and official command contract. Add executable discovery and a dedicated noninteractive adapter covering prompt input, permissions, streamed output, errors, login failures and cancellation. Report unavailability when not installed. Do not invent flags or claim real support from mocked tests alone.

## Codex lane
Finish and verify the existing adapter against the installed CLI. Check real authentication, harmless read-only model execution, workspace-write in a disposable fixture, JSONL output, failure states, cancellation and Windows process trees. Current verification used Codex help mode only; no model-backed task has been run. Do not launch TASK-EAR-234 as a smoke test.

## Shared integration and coordination
Agree on the adapter contract first. Use separate worktrees/branches when concurrent, and designate one integrator for cliRunner.ts, routes/cli.ts, CliRunPanel.tsx and shared UI. Keep CLI operator, workflow role, execution status and task completion distinct. Read repository guidance and current source before treating this handoff as evidence.

## Acceptance criteria
- Claude and Codex are selectable only when adapter and executable are usable; unavailable/login errors are visible.
- CLI, role, actual target repository, prompt and permissions are reviewable before Run.
- No shell command concatenation or sandbox/permission bypass. Preserve localhost, Origin and auth guards.
- Duplicate active task execution is rejected. Stop terminates the relevant process tree, not unrelated processes.
- Output, failure, cancellation and exit status are visible. Exit 0 does not mark task completion or gates passed.
- Existing desktop links/copy flow still works.
- Record adapter/API/UI checks and both builds through scripts/record-evidence.sh for this task.
- Verify Windows task opening and review existing open-task integration coverage for the portability fix.
- Document actual coverage and remaining limits.

## Verified baseline
Server/client builds passed; all 5 cliRunner tests passed. Live API rejected forbidden Origin (403), invalid CLI and missing workspace (400). UI showed permission selection and backend validation error. TASK-EAR-234 has not been launched. Logs/execution history are in memory and lost on server restart. Claude/Cursor CLI adapters are not implemented.

## Scope boundary
No merge, push, deployment, automatic task completion or work on TASK-EAR-234. Cursor CLI, durable execution history and automatic workflow dispatch are follow-ups requiring an operator scope decision. Keep this task open for operator-directed continuation.

## Local runtime note
Ruby is available temporarily at C:/Users/USER/AppData/Local/Temp/earth-brain-task-ruby/rubyinstaller-4.0.7-1-x64/bin/ruby.exe. It was extracted from the official RubyInstaller portable archive; global PATH was not changed. Git Bash is C:/Program Files/Git/bin/bash.exe. Set PATH in the local command environment before running framework scripts.

## Recorded baseline evidence
- ev-001 (TASK-EAR-404): cliRunner tests, exit 0; see evidence.yaml and evidence/ev-001.log.
- Task status validated with validate-yaml.rb after canonical run-agent.sh open.

