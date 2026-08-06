# TASK-EAR-218 — Player audit modal header shows a mock identity over a real player

## Type

fix

## Priority

medium

## Discovered

2026-08-06, during TASK-EAR-215's live re-verification of the audit-events route.
The verifier opened the audit modal on staging player `8218a35f-…` (real username
`test01`) and the modal header read **`Frances Swann` / `UoyRP88` / `WEL980`** —
a mock identity — directly above a table of that player's *real* audit rows.

Pre-existing; not introduced by TASK-EAR-208 (PR #76), which wired the table only.

## Why this matters more than it looks

The modal now renders **real audit data under a fabricated player identity**. An
admin reading it can reasonably conclude the VIP change belonged to Frances Swann.
That is a wrong-subject defect in an audit surface — the one place in the product
whose entire job is saying *who did what to whom*.

This is the same class of bug TASK-EAR-144 already fixed one field away, in this
same file, with the comment:

> *"Showing a mock player's address next to a credential action is a
> wrong-recipient defect."*

That fix covered email/phone and stopped there. The header identity was missed.

## Root cause

`app/pages/admin/manage/player/edit/[id].vue:20`

```js
const player = computed(() => mockPlayerDetail(playerId.value))
```

and at :1068

```html
<PlayerAuditLogModal :player="player" :user-id="playerId" />
```

`:user-id` is the real route param and drives the live table (correct). `:player`
is the mock object and drives the header. `mockPlayerDetail` falls back to an
arbitrary fake player when the id does not match a mock row — which is always
true for a real UUID.

`PlayerAuditLogModal.vue` reads `player.username` (:179), `player.userId` (:184),
`player.referralCode` (:189) and `player.status` (:107, :115).

## The fix

The real values already exist on the page, API-backed, with mock fallbacks already
stripped out by earlier runs — reuse them rather than inventing a new fetch:

- `displayEditUserName` (:208) — real username
- `displayEditUserId` (:212) — real full user id
- `displayEditReferral` (:217) — real referral, `-` when absent

Feed those into the modal instead of the mock object. Either pass discrete props
or build a computed that overlays the real values; pick whichever reads more
naturally alongside the existing code and say why in the PR.

`status` also comes from mock today — check whether a real status is available on
the page (`editPlayerStatus` / `profileSummary` / `listRowMatch` are all in play
around :481-487) and use it if so. If no real status exists, **leave the status
chip alone and say so** rather than inventing one; a wrong status badge would be
the same defect in a new place.

**Any field with no real source must render `—`/`-`, never a mock value and never
a fabricated one.** That rule is the whole point of this run.

## Constraints

- **Preserve the designed UX.** Standing operator rule: this is a data-source
  change only. Do not restyle, re-lay-out, or "improve" the modal header.
- **PR only, do NOT merge.** Backoffice `main` merge is a real k3s/ArgoCD deploy.
  State that in the PR body.
- Do not touch the audit table wiring from TASK-EAR-208 — it is correct and live.

## Acceptance criteria

- Opening the audit modal on a real player shows that player's real username, id
  and referral in the header.
- No mock identity can reach the header for any player id, including ids absent
  from the mock list.
- Tests in the repo's existing style (`tests/*.test.mjs`).
- Authenticated staging smoke with a screenshot on player
  `8218a35f-e869-437a-8844-3c97f08ed428` (real username `test01`, has a genuine
  `user.vip_level.set` row), showing header and row agreeing. The harness pattern
  is in the workspace memory note `backoffice-authenticated-smoke`, and
  `runs/TASK-EAR-208/artifacts/` holds the scripts and prior screenshots.
  If the harness cannot run, say exactly why — do not fabricate a screenshot.

## Out of scope

- Removing `mockPlayerDetail` from the page entirely. Other panels still read it;
  untangling all of them is a bigger run than this defect warrants.
