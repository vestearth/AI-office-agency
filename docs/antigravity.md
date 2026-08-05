# Antigravity CLI Subagent and Advisory Guide

## Purpose

**Antigravity CLI** is the default **research / wide-context subagent** in AI Dev
Office: an operator a conductor (Claude or Codex) may delegate scoped sub-work
to — typically research, alternative design, or wide-context review — and it may
also be used as a manual advisory lane for critique and draft responses
formatted like AI Dev Office role outputs. See the operator model in
[AGENTS.md](../AGENTS.md).

Older docs named this slot **Gemini**. That label was documentation drift: the
operator surface is Antigravity CLI (which may host a Gemini chat surface). Do
not confuse this with the Games Labs User **Gemini translation API**
(`GEMINI_API_KEY` / `GEMINI_MODEL`) — that is a product integration, not an
office operator.

## What This Is Not

Antigravity is not a configured runner in AI Dev Office. Do not describe it as
part of `runner_selector.priority`, `fallback`, `auto`, or `dispatch`. As an
operator, it is never written into a machine field; provenance belongs in
free-text `reason`/`notes`. Delegation happens inside a conductor's interactive
session, not through `run-agent.sh`.

## Operating Modes

`advice mode`

Use this mode when you want critique, questions, alternatives, risk review, or a
second opinion. The response is advisory and should inform the human operator
rather than replace task state directly.

`role response mode`

Use this mode when you want a draft response formatted like an AI Dev Office
role output. The result remains draft material until a human normalizes it into
`runs/<task-id>/<agent>-output.yaml` and runs
`ruby ai-dev-office/validate-yaml.rb <task-id>`.

## Best Role Fit

Recommended manual-use cases are `pm` and `reviewer` (scope critique, assumption
challenge, second-opinion review). `dev` and `debugger` are selective follow-ons
for tradeoffs, RCA hypotheses, or implementation critique.

## Manual Workflow

1. Read `agents/<role>.md`.
2. Read `runs/<task-id>/task.md` and `runs/<task-id>/status.yaml`.
3. Gather prior `runs/<task-id>/*-output.yaml` files if relevant.
4. Choose either `advice mode` or `role response mode`.
5. Ask Antigravity CLI for advisory feedback or a draft role-shaped response.
6. Treat the result as draft and non-official.
7. If it should become workflow state, have a human normalize it into
   `runs/<task-id>/<agent>-output.yaml`.
8. Run `ruby ai-dev-office/validate-yaml.rb <task-id>` before treating it as official.

## Starter Prompt Pattern

```text
You are assisting within AI Dev Office as a manual advisory lane (Antigravity).
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

Antigravity output is non-official until a human normalizes it into
`runs/<task-id>/<agent>-output.yaml` and runs
`ruby ai-dev-office/validate-yaml.rb <task-id>`. Until then, treat it as advisory
draft material.

## Limitations

- This lane does not invoke Antigravity through `run-agent.sh`.
- This guide does not change configured runner routing.
- Manual output may still need evidence checks, rewriting, and YAML normalization.
- If advice conflicts with code, tests, logs, or validated task artifacts, resolve
  with evidence rather than model preference.

## Related Docs

- [gemini.md](gemini.md) — superseded pointer (historical Gemini naming)
- [codex.md](codex.md)
- [cursor.md](cursor.md)
- [claude.md](claude.md)
- [getting-started.md](getting-started.md)
