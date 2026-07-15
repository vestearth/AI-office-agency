# Knowledge Librarian Workflow

This workflow reviews `knowledge-base/` for stale, unsupported, contradictory,
or operationally useful knowledge. It stays outside the AI Dev Office role and
phase machine: it never becomes `current_agent`, never mutates `status.yaml`,
and does not require a TASK id.

Repository source, tests, CI, logs, runtime config, current contracts, and
actual runtime behavior remain stronger evidence than the vault.

## Invocation And Limits

- Run weekly or on demand against an explicit scope.
- Default limit: at most 5 notes or 20 minutes, whichever comes first.
- Prefer high-risk notes first: current-behavior ADRs, end-to-end flows,
  frequently referenced notes, and publication candidates.
- Write the audit artifact to:

```text
knowledge-reviews/<timestamp>-<scope>.yaml
```

The artifact must match `schemas/knowledge-librarian-output.schema.json` and
pass `scripts/validate-knowledge-librarian.rb`.

## Process

1. **Detect** — run or consume `knowledge-base/scripts/check_vault_links.py` and
   inspect the scoped notes for source, freshness, link, duplicate, orphan, and
   publication risks.
2. **Prioritize** — select the smallest high-value batch within the run limits.
3. **Source-review** — apply `ai-skills/skills/knowledge-source-review/SKILL.md`.
   Compare durable claims with current repository or runtime evidence.
4. **Track lifecycle** — give each finding a stable fingerprint and record
   `new`, `recurring`, `resolved`, or `suppressed`. A resolved finding requires
   an answer, closure evidence, and `closed_at`.
5. **Propose or write** — use the policy below. Record every proposed or applied
   change in the audit artifact.
6. **Verify** — validate the artifact and run the vault checker after any
   applied write.

## Capture Triggers

The librarian may capture completed work when it discovers durable knowledge:

- **Large feature** — completion is verified and the work introduces or changes
  a cross-repository flow, API/contract/schema, user-facing capability,
  operational behavior, or durable implementation decision. Diff size alone is
  not evidence that a feature is large.
- **Resolved debugging** — root cause, fix, and regression or runtime
  verification are all available. If any part is missing, keep the question
  open with `evidence_state: partial` instead of claiming resolution.

Search existing notes first and prefer updating the owning project note or flow
over creating a duplicate.

## Write Policy

### Default

Use `write_mode: proposal_only`. Do not edit the vault. Human review happens
before a proposal is applied.

### Explicitly approved scope

Use `write_mode: approved_scope_auto_write` only when the target workspace's
`knowledge-base/AGENTS.md` explicitly names the product scope and allowed write
targets. The audit artifact must cite that policy in `authorization`.

The authorization must point to a machine-readable policy file. The validator
loads that file and checks the approved scope, approver/date, target class,
path, action, and resulting status for every applied change. Human-readable
evidence and decision boundaries remain in the target `knowledge-base/AGENTS.md`.

Auto-written changes use `review_mode: post_write`; they are reviewed during
Weekly Review. The librarian never commits or pushes.

## Output Rules

- `requires_human_review` remains `true`: proposal-only work is reviewed before
  write, approved-scope work is reviewed after write.
- Every finding has at least one source, explicit verification scope,
  confidence, closure criteria, and a proposed patch (which may be empty for
  `no_change`).
- Every applied change points to its finding fingerprint and matches the
  machine-readable authorization policy.
- Do not invent evidence, silently upgrade staging evidence to production, or
  close a question that still requires human judgment.
- Do not auto-publish or auto-promote shared knowledge.
