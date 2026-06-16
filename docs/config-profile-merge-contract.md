# Config/Profile Merge Contract

This document defines how AI Dev Office loads and merges framework config, profile config, local overrides, environment variables, and CLI flags.

## Load Order

Later sources win over earlier ones:

1. `office.config.yaml`
2. Selected profile config, such as `profiles/generic.yaml` or `profiles/games-labs.yaml`
3. `office.config.local.yaml`
4. Environment variables
5. CLI flags

## Profile Selection

A profile may be selected by CLI flag or environment variable:

```bash
./ai-dev-office/run-agent.sh --profile generic TASK-001 pm
OFFICE_PROFILE=generic ./ai-dev-office/run-agent.sh TASK-001 pm
```

If no profile is selected, the framework should use the default config without applying a project profile.

## Merge Strategy

- Maps: deep merge
- Scalars: later value overrides earlier value
- Arrays: replace by default
- ID-keyed arrays: merge by stable `id` when the file format supports it

## Protected Fields

These fields describe the framework contract and must not be overridden by normal profiles:

- `office.version`
- `state_model.source_of_truth`
- `handoff_contract.state_files`
- `agents[].id`
- `runner_selector.config_dir`

If a profile needs to change one of these fields, it is no longer acting like a portable overlay. Move the change into a new framework version or a separate target-project file.

## Allowed Overrides

Profiles may override behavior that is expected to vary by project:

- `dependency_guard`
- `context_provider`
- `external_repos`
- `knowledge`
- `runner_selector.priority`
- `loop_guard.max_iterations`
- `skills`
- `scripts`

## Local Files

These files are local-only and must stay out of git:

- `office.config.local.yaml`
- `profiles/*.local.yaml`
- `.env`
- `.env.*`
- `.socraticode.local.yaml`

## Environment Overrides

Supported environment overrides include:

- `AI_SKILLS_PATH` -> `external_repos.ai_skills_path`
- `KNOWLEDGE_BASE_PATH` -> `external_repos.knowledge_base_path`
- `OFFICE_KNOWLEDGE_MODE` -> `knowledge.mode`

## Practical Rule

Keep the core framework generic, then layer project-specific behavior through profiles and local config. If the merge behavior is unclear, assume later sources win and the framework contract stays stable.
