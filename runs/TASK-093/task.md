# TASK-093: Pin GitHub Actions to Commit SHAs Across Delivery Workflows

## Short name
`pin-actions-to-sha`

## Type
chore

## Priority
medium

## Parent / Epic
- Parent: `TASK-087`
- Epic: AI Office Capability Coverage

## Status

Follow-up to the medium findings recorded in TASK-084/086: third-party actions in
all deploy workflows are pinned to floating major tags (`@v4`, `@v5`). A moved tag
runs attacker code in CI with access to GH_PAT and KUBECONFIG. Pin every action to
its current commit SHA (with a `# vN` comment) — identical behavior, immutable ref.

## Scope

All 9 GitOps services' `.github/workflows/deploy.yml` (same 5 actions everywhere):

| Action | Pinned SHA |
| --- | --- |
| actions/checkout@v4 | 34e114876b0b11c390a56381ad16ebd13914f8d5 |
| docker/setup-buildx-action@v3 | 8d2750c68a42422c14e847fe6c8ac0403b4cbd6f |
| docker/login-action@v3 | c94ce9fb468520275223c153574b00df6fe4bcc9 |
| docker/build-push-action@v5 | ca052bb54ab0790a636c9b5f226502c73d547a25 |
| azure/setup-kubectl@v4 | 776406bce94f63e41d621b960d78ee25c8b76ede |

Excluded: Provider/shared-lib workflows (different pipelines, optional follow-up);
container non-root (separate pilot task); OIDC (platform decision, documented not done).

## Acceptance Criteria

- [ ] Every deploy.yml references actions by full commit SHA with `# vN` comment.
- [ ] No other change in any workflow (pure substitution).
- [ ] YAML validates per repo; one PR per repo for DevOps review.

## Assignment

- Primary: `devops`
- Parallel: `true`
