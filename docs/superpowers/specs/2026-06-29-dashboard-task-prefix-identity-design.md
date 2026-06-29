# Dashboard-Owned Task Prefix Identity Design

## Goal

Make every newly created ordinary task use the namespace of the person currently
selected in the Dashboard, for example `TASK-EAR-030` for `Earth` and
`TASK-BOB-001` for `Bob`. The prefix is identity-derived state, not a hardcoded
workspace value and not a task title.

Existing `TASK-NNN` and `TASK-PKG-NNN` runs remain readable and runnable. This
change only tightens creation of new ordinary tasks while the team prefix
registry is active.

## Current Behavior and Gap

The Dashboard derives a prefix from the actor name only when no effective prefix
already exists. Once `office.config.local.yaml` contains a prefix, saving a
different actor keeps that prefix and reports a registry conflict. On a shared
machine, selecting `Bob` after `Earth` can therefore leave intake configured for
`EAR`.

The runner also enforces registered prefixes only in `intake`. A direct new-task
command such as `run-agent.sh TASK-114 pm` can bypass the identity namespace,
and the PM prompt still describes new ids as `TASK-NNN`.

## Design Decisions

### 1. Reconcile prefix from the selected Dashboard identity

Saving a Dashboard actor performs identity reconciliation in this order:

1. Normalize and validate the actor name.
2. If the registry already contains a prefix owned by that exact actor, reuse it.
3. Otherwise, if the currently configured prefix is unowned, claim it for the
   actor to preserve explicit manual configuration.
4. Otherwise derive the first available candidate from the actor name.
5. Register a newly derived prefix without overwriting another owner's claim.
6. Atomically update `office.config.local.yaml` to the selected actor's prefix.
7. Return the effective prefix to the client so the badge immediately reflects
   `TASK-<PREFIX>-...`.

Registry ownership remains append-only during identity switching. Switching from
Earth to Bob does not delete Earth's claim; switching back to Earth reuses the
existing `EAR` claim.

For compatibility, explicitly configured prefixes may still be claimed when
unowned. They must not be silently reassigned when owned by another actor.

### 2. Enforce the active namespace only when creating a new run

When `run-agent.sh <TASK_ID> pm` would create a new task directory and the team
registry is active:

- resolve the current effective task prefix;
- require the id to match `TASK-<CURRENT_PREFIX>-NNN`;
- require that prefix to be registered to an owner;
- reject unprefixed `TASK-NNN`, another user's prefix, and arbitrary namespaces
  with a message directing the operator to Dashboard identity or `intake`.

This check applies only to new task creation. Existing legacy and namespaced task
directories continue through PM, Dev, Reviewer, status, verify, and cleanup
without migration or rename.

`TASK-PKG-NNN` remains a reserved special namespace. The ordinary Dashboard and
intake flow does not allocate it, and this change does not define a new package
task allocation workflow.

### 3. Keep task identity separate from task metadata

The task id carries only the actor namespace and sequence number. Human-readable
classification remains in:

- `task.title`
- `task.short_name`
- `task.epic`
- `task.workstream`

The PM contract and examples will use `TASK-<PREFIX>-NNN` for new tasks and
explicitly describe `TASK-NNN` as legacy rather than the default.

### 4. Close operator hook and prompt leaks

Active hooks, trigger metadata, skills, templates, and operator instructions
must not recommend inventing a plain `TASK-NNN` for new work. Any surface that
starts or suggests PM task creation must either:

- run `run-agent.sh intake "<request>"` and use the returned id; or
- refer generically to `<TASK_ID>` while stating that new ids come from the
  active Dashboard identity namespace.

This includes both portable template sources and their installed workspace
copies, especially PM agent trigger metadata. Examples used only to operate an
existing historical task may remain generic `<TASK_ID>` examples; plain
`TASK-NNN` may appear only when explicitly labelled legacy or when documenting
the backward-compatible accepted shapes.

Add a focused policy regression check over the active task-creation guidance
allowlist. It must fail when a hook, PM prompt, or intake instruction again
recommends plain `TASK-NNN` as the new-task default, without flagging historical
plans, backups, runtime records, or compatibility documentation.

## Component Changes

### Dashboard identity service and route

- Add registry lookup by owner.
- Allow the local effective prefix to change when the selected actor changes.
- Preserve atomic writes and unrelated local configuration keys.
- Return whether the prefix was reused, registered, or switched.
- Keep collision handling fail-closed.

### Runner

- Reuse the existing config resolver and registry rules before the PM creates a
  missing task directory.
- Validate new-task ids against the effective registered prefix.
- Leave dispatch of existing task directories unchanged.

### PM and operator documentation

- Update `agents/pm.md`, getting-started/intake guidance, examples, and portable
  templates that describe new task allocation.
- Update installed operator surfaces such as `.cursor/agents` and relevant root
  instructions together with their portable template sources.
- Make task-creation hooks call intake or consume its returned `<TASK_ID>` rather
  than constructing a plain numeric id.
- Keep the validator's three compatible id shapes because historical runs still
  use all three.

## Error Handling

- A name with no usable Latin prefix candidates returns a clear manual-prefix
  instruction and does not alter config or registry.
- A registry parse failure blocks identity reconciliation and new task creation.
- A claimed prefix is never overwritten for a different actor.
- If registry registration succeeds but the local config write fails, return an
  error; the registry claim remains safe and can be reused on retry.
- If the Dashboard actor is unset, new PM task creation is rejected while the
  registry is active, with guidance to set the Dashboard name first.

## Testing

Add focused tests for:

- `Earth` derives or reuses `EAR`; `Bob` derives or reuses `BOB`.
- switching Earth -> Bob -> Earth updates local config on each switch and keeps
  both registry claims;
- a collision selects the next valid candidate without stealing ownership;
- explicitly configured, unowned prefixes can be claimed;
- Thai-only names and malformed registries fail without partial local writes;
- new PM creation accepts only the current actor namespace when registry mode is
  active;
- direct unprefixed or other-user PM creation is rejected;
- existing `TASK-NNN`, `TASK-PKG-NNN`, and other-user task directories remain
  runnable;
- active PM hooks/prompts do not suggest plain `TASK-NNN` for new work, and the
  policy regression check catches a reintroduction;
- Dashboard server tests, runner integration tests, runtime YAML validation, and
  portable contract checks pass.

## Non-Goals

- Renaming historical task directories.
- Encoding task title, service, or workstream in the task id.
- Removing `TASK-NNN` or `TASK-PKG-NNN` support from scanners and validators.
- Creating a multi-actor session model or authentication system for Dashboard.
- Changing task assignment or reviewer ownership rules.

## Acceptance Criteria

- The Dashboard-selected actor determines the local task prefix even after a
  different actor previously used the same machine.
- `intake` produces `TASK-<SELECTED_ACTOR_PREFIX>-NNN` without a hardcoded `EAR`.
- New direct PM task creation cannot bypass an active registered namespace.
- Active task-creation hooks, prompts, templates, and installed copies obtain the
  namespaced id from intake and never recommend plain `TASK-NNN` as the default.
- Existing task runs work without rename or migration.
- PM guidance, runner behavior, Dashboard behavior, schemas, and tests describe
  one consistent task-creation contract.
