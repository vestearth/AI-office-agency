# Knowledge tab — readability and information restructure — Design

**Status:** Approved (brainstorm complete 2026-07-25), ready for implementation plan
**Surface:** Dashboard client, Knowledge tab (`/?tab=knowledge`)
**Branch:** `feat/knowledge-tab-readability` (cut from `main`)

## Goal

Make the Knowledge Reviews tab scannable. A reader should be able to pick the
review that matters out of 52 rows without reading every one, and then read a
single review without meeting a wall of text.

This is a presentation change plus one additive field on an existing API
projection. It does not change what a Knowledge Librarian audit means, does not
apply changes, and does not alter the read-only boundary.

## Context

The tab already went through one polish pass (`1de937c`, "Enhance Knowledge
Reviews UI with filtering and improved layout"). It has a working list/detail
split, free-text filter, priority colours and clamping. What it does not have is
an information hierarchy that matches the shape of the real corpus — the previous
pass styled the fields it was given, one per field, without asking which fields
carry signal.

The measurements below were taken against the live dev server (52 reviews, 114
findings, 99 changes) on 2026-07-25.

## Evidence

Every decision in this document traces to one of these. Measured via the running
API on `localhost:4310` and `getComputedStyle`/`getBoundingClientRect` on the
rendered page at a 1440x900 viewport.

| # | Observation | Measurement |
|---|---|---|
| E1 | Prose line length is roughly 1.5x the comfortable maximum | `.knowledge-summary-text` renders at **998px @ 16px** ≈ 110+ characters per line (target 65–75) |
| E2 | The list shows the same string twice on most rows | normalised `scope.product` is identical to the review-id slug on 9/52 rows and a substring of it on another 26 — **35/52 (67%)** are duplicates |
| E3 | `scope.product` is not a usable category | 52 reviews yield **17 distinct values**; only `games_labs` (30), `ai_office_agency` (6) and `games_labs_missions` (2) repeat. The rest are one-offs, several of them full sentences (e.g. `Games Labs Backoffice coupon/store-items aborted implementation attempt`) |
| E4 | Scope paths are dense and repetitive | median 6 paths, p90 12, max 18; **23/52 reviews carry more than 6**. First path segment is a real repo/vault root in the large majority (`Knowledge Base` 69, `Games-Labs-Missions` 50, `ai-dev-office` 47, `Games-Labs-backoffice` 45, `knowledge-base` 40, `Games-Labs-Order` 28, …) |
| E5 | Some `scope.paths` entries are not paths | free text appears in the same array — `https:`, `Games-Labs-Wallet draft PR #9`, `parent-thread supplied Monthly Check-in screenshots`, bare commit SHAs |
| E6 | `reviewMode` is 100% redundant with `writeMode` | `pre_write` = `proposal_only` = 43, `post_write` = `approved_scope_auto_write` = 9. Exact 1:1 across the corpus |
| E7 | Priority is real signal and is invisible in the list | 114 findings: **critical 3, high 72, medium 26, low 13**. The list shows only a neutral grey "N findings" chip |
| E8 | The detail view is a long scroll with no anchors | worst review renders **3,314px into a 690px viewport** (4.8 screens), 16 records, no collapse and no jump |
| E9 | The answer clamp fires on most findings | answer length median 359 chars, p90 782, max 1,897 — **67/114 (59%) exceed the 280-char clamp**, so "Show more" is the common case, not the exception |
| E10 | Summaries are long | median 609 chars, p90 925, max 2,690 — at E1's measure the max is a single 20-line block |
| E11 | Findings per review are few but uneven | median 2, p90 4, max 8; 3 reviews have none |
| E12 | The list panel reserves space it does not use | `min-height: 420px` holds a full-height empty panel when a filter matches one row |
| E13 | Acronyms are mangled | `humanizeLabel` title-cases every word, so `vip` renders as "Vip" |
| E14 | The summary projection already holds the data it discards | `loadAll()` parses each full `KnowledgeReviewDetail` including findings; `toSummary()` then destructures `findings` away. Priority aggregates cost no additional I/O |

## Decisions

1. **Cap the measure, not the layout.** Long-form text (`summary`, finding
   `answer`) is capped at `72ch`. Cards, grids and chrome keep the full column
   width. Fixes E1 without making the page feel narrow.
2. **Drop the duplicated product kicker.** Show `scope.product` in a list row
   only when its normalised form is not contained in the normalised title, and
   vice versa. Covers E2; the ~17 rows where product carries independent
   information keep it.
3. **Replace the kicker with repos touched.** Derive from `scope.paths`, which
   the list payload already carries. Show the first two distinct roots plus
   `+N`. Addresses E3 — repo is the grouping a reader actually recognises, and
   `product` is not.
4. **Surface priority in the list.** A left accent bar coloured by the review's
   highest finding priority, plus a `N critical` / `N high` count when non-zero.
   Requires decision 8. Addresses E7.
5. **Drop the `Review mode` tile.** E6 proves it duplicates the badge already in
   the detail header. The remaining three facts collapse from a 4-tile grid to a
   single meta line (`22 Jul 2026, 16:43 · 3 notes reviewed · 0 applied`).
6. **Group scope paths by root.** Render one labelled group per first segment,
   with the shared prefix lifted into the group heading and the remainder as
   plain monospace text rather than pills. Reviews above 6 paths (E4) collapse to
   the first three groups behind a "Show all N paths" control. Entries that do
   not look like paths (E5) fall into a trailing `Other` group verbatim — they are
   not silently dropped.
7. **Sort findings by priority** (critical → high → medium → low, stable within a
   tier). E7 plus E11 mean the one finding that matters can currently sit last.
   Each finding gets a left priority bar, a single-line chip row replacing the
   4-column `<dl>`, and a 6-line answer clamp (E9).
8. **Add `priorityCounts` to the list projection.** Additive, optional field on
   `KnowledgeReviewSummary`. Computed in `toSummary()` from findings that are
   already in memory (E14) — no extra file reads, no new endpoint, no breaking
   change for any other consumer.
9. **Add `vitest` to the client** so the new pure functions are verifiable.
   *New dependency — flagged for veto.* The client currently has no test runner,
   which also leaves the existing `client/src/intake/intakeApi.test.ts` orphaned
   (the server's `npm test` glob only covers `server/src/**/*.test.ts`). Vitest
   is the standard Vite companion and needs no other config. If vetoed, the pure
   helpers still get extracted but ship unverified by unit test.
10. **Split the view.** `KnowledgeReviewsView.tsx` is 361 lines holding page
    state, two list components, four detail components and six formatting
    helpers, and this change grows all three groups. Extract into a
    `views/knowledge/` folder so the pure logic is importable and testable.

## Component design

### List row

```
▎ Store avatar list · VIP boundary                        22 Jul
▎ Games-Labs-Missions · Games-Labs-Order  +4
▎ 2 high · 8 findings · 8 changes
```

- Left bar colour = highest finding priority (`critical`/`high` red,
  `medium` amber, `low`/none neutral). Selection stays the accent-blue inset
  shadow, so selection and priority never compete for the same channel.
- Title first, at 14px/500. Product prefix only per decision 2.
- Repo line from `scope.paths` roots, monospace, 11px.
- Meta line: priority count (coloured, only when critical/high present), then
  findings, changes, then `auto-write` only when `writeMode` is
  `approved_scope_auto_write` — the 43 `proposal_only` rows say nothing, because
  it is the default.
- Dates: `22 Jul` for anything older than 48h, relative below that. Removes the
  current mix of `3h ago` and `7/13/2026` in one column.

### Detail header

- Title, review id, and one badge (`Proposal only` / `Auto-write approved`).
- Single meta line replacing the 4-tile grid (decision 5).
- The header block is `position: sticky` within the detail scroller so the
  review being read stays identified through E8's 4.8 screens.

### Scope paths

One row per root: label (count) on the left, paths joined by `·` on the right,
shared prefix removed. Collapses per decision 6.

### Finding record

```
▎ Should the Missions project note explicitly distinguish avatar catalog
▎ visibility from buy-time VIP eligibility enforcement?
▎ high | resolved · evidence confirmed · mixed scope · update note
▎ Yes. Catalog visibility and purchase eligibility are separate gates; …
▎ Knowledge Base / 10 Projects/Games Labs Missions/Project Map.md
```

Question at 14px/500 capped at 62ch, chip row at 11px, answer at 13px capped at
72ch with a 6-line clamp, note path as muted monospace (not a pill).

### Changes

Same chip treatment. `applied` (13 of 99) reads as success-toned; `proposed`
stays neutral — currently both render as generic status badges.

### Responsive

The existing breakpoints are 1100px (fact grid to 2 columns), 920px (layout to
one column, list capped at 360px) and 620px (headings stack, grids to 1 column).
Decisions 5 and 7 delete `.knowledge-fact-grid` and `.knowledge-record-facts`
outright, which leaves most of those rules targeting selectors that no longer
exist. The 920px single-column collapse is the only one that survives as-is and
must be preserved; the rest are replaced by rules for the new meta line, chip
row and path groups — the chip row wraps rather than re-gridding.

### States

- List panel height follows content; `min-height: 420px` removed (E12).
- Loading renders skeleton rows matching final geometry instead of a spinner
  block that changes layout height on resolve.
- Section counts move inline (`Findings 8`) from the far-right muted position.

## Data contract change

```ts
// shared/types.ts
export type KnowledgeFindingPriorityCounts = Partial<
  Record<KnowledgeFindingPriority, number>
>;

export interface KnowledgeReviewSummary {
  // …existing fields unchanged
  priorityCounts?: KnowledgeFindingPriorityCounts;
}
```

`toSummary()` builds it by reducing `review.findings`. Optional so any existing
consumer and any fixture without the field keeps type-checking. `getById` is
untouched — the detail response already carries full findings.

## Files

| File | Change |
|---|---|
| `dashboard/shared/types.ts` | add `KnowledgeFindingPriorityCounts`, optional field on `KnowledgeReviewSummary` |
| `dashboard/server/src/services/knowledgeReviews.ts` | compute `priorityCounts` in `toSummary()` |
| `dashboard/server/src/services/knowledgeReviews.test.ts` | assert the new aggregate, including the zero-findings case |
| `dashboard/client/src/views/knowledge/KnowledgeReviewsView.tsx` | page state, layout, loading/empty states |
| `dashboard/client/src/views/knowledge/ReviewListItem.tsx` | new list row |
| `dashboard/client/src/views/knowledge/ReviewDetail.tsx` | header, meta line, sections |
| `dashboard/client/src/views/knowledge/ScopePaths.tsx` | grouped paths + collapse |
| `dashboard/client/src/views/knowledge/FindingRecord.tsx` | finding and change records |
| `dashboard/client/src/views/knowledge/format.ts` | `humanizeLabel` (+ acronym map), `groupPathsByRoot`, `shouldShowProduct`, `formatReviewDate`, `maxPriority`, `sortFindingsByPriority` |
| `dashboard/client/src/views/knowledge/format.test.ts` | unit tests for the above |
| `dashboard/client/src/views/KnowledgeReviewsView.tsx` | deleted; import site in `App.tsx` repointed |
| `dashboard/client/src/styles/globals.css` | rewrite the `.knowledge-*` block (lines 532–1051) **and its three responsive blocks** (1053–1094) |
| `dashboard/client/package.json` | `vitest` devDependency + `test` script (decision 9) |

## Verification

1. `npm test --prefix dashboard/server` — `priorityCounts` aggregate, existing
   suite green.
2. `npx vitest run` in `dashboard/client` — `format.ts` units, with cases drawn
   from the real corpus: the 9 identical / 26 substring / 17 distinct product
   rows (E2), the non-path entries (E5), `vip` → `VIP` (E13), an 18-path review
   (E4), a zero-findings review (E11).
3. `npm run build --prefix dashboard/client` — `tsc` clean.
4. Browser verification against the live dev server at 1440x900 and 1280x800:
   - `.knowledge-summary-text` measured width ≤ 72ch (E1 closed).
   - The `games-labs-store-avatar-list-vip-boundary` review (8 findings, 13
     paths) reads without a horizontal or nested-scroll defect, and its detail
     scroll height drops materially from 3,314px (E8).
   - Filtering to a single result leaves no empty panel (E12).
   - Console and network clean.
5. Screenshots before/after for the list column and the dense detail.

## Out of scope

- Deep-linking the selected review into the URL. Worth doing; separate change.
- Filtering or sorting by priority, write mode, or repo. The data now supports
  it, but the ask was readability.
- Fixing the upstream Knowledge Librarian generator so `scope.product` is a
  controlled vocabulary and `scope.paths` holds only paths. Decisions 2, 3 and 6
  are deliberately defensive because the generator is not being changed here.
  This is the real fix for E3 and E5 and should be raised separately.
- Pagination or virtualisation. 52 rows do not need it.

## Risks

- **Repo grouping depends on a path convention.** Mitigated by the `Other` group
  (E5) and by tests over the real corpus, but a future review with a new root
  shape will land in `Other` rather than break.
- **`priorityCounts` is computed from validated artifacts only.** Invalid files
  are already excluded upstream by `loadAll()`, so the aggregate inherits that
  boundary — a review that fails validation contributes nothing, same as today.
- **The dedupe rule is heuristic.** Worst case it hides a product label that
  would have been mildly useful, or shows one that reads redundantly. It never
  hides the title.
