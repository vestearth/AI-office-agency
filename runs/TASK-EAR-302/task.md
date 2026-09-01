# TASK-EAR-302 — Restore AWS Service Discovery diagnostics for the 8/14 production outage

## Origin

Multica issue SPAR-25 — Prod: restore AWS Service Discovery diagnostics for 8/14 outage.

## Type / workstream / priority

Investigation / devops / critical

## Goal

Restore a verified, read-only operator path to investigate the production Cloud Map
service-discovery regression identified in TASK-EAR-273. This task is diagnostics
only; it must not change ECS, Cloud Map, networking, or application code.

## Scope

- The approved production AWS account, Cloud Map namespace, and registered instances.
- An approved AWS CLI/profile or equivalent operator runner.
- Evidence recorded in this task run only.

## Acceptance criteria

1. The approved AWS CLI/profile or operator runner is available without committing
   credentials or configuration secrets.
2. The operator runs `aws servicediscovery list-namespaces --output json` against
   the approved production account and records the resulting namespace evidence.
3. The relevant namespace and service instances are inspected read-only to establish
   whether the production task points at a resolvable Cloud Map target.
4. Any remediation is proposed separately with exact target, rollback, and fresh
   authorization; this task performs no deployment or infrastructure mutation.

## Dependencies and blockers

- An approved AWS operator context for the intended production account.
- `aws` is not installed in the current workspace shell, so a verified alternative
  runner or explicit installation authorization is required before execution.

## Verification

Capture the command, account/region context, namespace list, and instance evidence.
Do not treat a workflow file or a successful deploy as runtime proof.
