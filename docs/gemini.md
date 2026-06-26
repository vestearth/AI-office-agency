# Gemini Subagent and Advisory Guide

## Purpose

Gemini is a default **subagent** in AI Dev Office: an operator a conductor (Claude
or Codex) delegates scoped sub-work to — typically research, alternative design,
or wide-context review — and it may also be used as a manual advisory lane for
critique and draft responses formatted like AI Dev Office role outputs. See the
operator model in [AGENTS.md](../AGENTS.md). This guide keeps that usage aligned
with the existing task artifact and validation contract without changing the
configured runner model.

## What This Is Not

Gemini is not a configured runner in AI Dev Office. Do not describe Gemini as part of `runner_selector.priority`, `fallback`, `auto`, or `dispatch`. As an operator, Gemini is never written into a machine field; its provenance belongs in free-text `reason`/`notes`. Delegation to Gemini happens inside a conductor's interactive session, not through `run-agent.sh`.

## Operating Modes

`advice mode`

Use this mode when you want critique, questions, alternatives, risk review, or a second opinion. The response is advisory and should inform the human operator rather than replace task state directly.

`role response mode`

Use this mode when you want Gemini to draft a response formatted like an AI Dev Office role output. The result remains draft material until a human normalizes it into `runs/<task-id>/<agent>-output.yaml` and runs `ruby ai-dev-office/validate-yaml.rb <task-id>`.

## Best Role Fit

Recommended manual-use cases are `pm` and `reviewer`, where Gemini can help tighten scope, question assumptions, and provide a second-opinion review. `dev` and `debugger` are selective follow-on uses when you want an extra pass on tradeoffs, RCA hypotheses, or implementation critique.

## Manual Workflow

1. Read `agents/<role>.md`.
2. Read `runs/<task-id>/task.md` and `runs/<task-id>/status.yaml`.
3. Gather prior `runs/<task-id>/*-output.yaml` files if they are relevant to the question.
4. Choose either `advice mode` or `role response mode`.
5. Ask Gemini for advisory feedback or for a draft response formatted like an AI Dev Office role output.
6. Treat the result as draft and non-official.
7. If the output should become workflow state, have a human operator normalize it into `runs/<task-id>/<agent>-output.yaml`.
8. Run `ruby ai-dev-office/validate-yaml.rb <task-id>` before treating the result as official.

## Starter Prompt Pattern

```text
You are assisting within AI Dev Office as a manual advisory lane.
Read:
1. agents/<role>.md
2. runs/<task-id>/task.md
3. runs/<task-id>/status.yaml
4. prior output files if relevant

Mode: <advice mode | role response mode>

Constraints:
- Do not assume you are the official runner.
- Keep recommendations evidence-oriented.
- If producing a draft response formatted like an AI Dev Office role output, match the AI Dev Office output contract as closely as possible.
- The response will remain draft until normalized and validated by a human operator.
```

## Normalization And Validation Boundary

Gemini output is non-official until a human operator normalizes it into `runs/<task-id>/<agent>-output.yaml` and runs `ruby ai-dev-office/validate-yaml.rb <task-id>`. Until that happens, treat the response as advisory draft material rather than accepted AI Dev Office state.

## Limitations

- This manual advisory lane does not invoke Gemini through `run-agent.sh`.
- This guide does not change configured runner routing.
- Manual output may still need evidence checks, rewriting, and YAML normalization before it is usable.
- If Gemini advice conflicts with code, tests, logs, or validated task artifacts, resolve the conflict with evidence rather than model preference.

## Related Docs

- [codex.md](codex.md)
- [cursor.md](cursor.md)
- [getting-started.md](getting-started.md)
