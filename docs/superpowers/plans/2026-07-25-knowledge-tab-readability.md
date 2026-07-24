# Knowledge Tab Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard Knowledge Reviews tab scannable — pick the review that matters out of 52 rows without reading every one, then read it without meeting a wall of text.

**Architecture:** One additive server field (`priorityCounts`, computed from findings `toSummary()` already holds in memory), a new `views/knowledge/` folder that splits the 361-line view into a page plus five components and one pure-logic module, and a rewrite of the `.knowledge-*` CSS block. The read-only boundary is untouched: no new mutating route, no apply path, no change to what an audit means.

**Tech Stack:** React 18 + TypeScript + Vite (client), Express + ts-node (server), plain CSS with custom properties in `globals.css`, `node --test` (server), Vitest (client, added by Task 2).

**Design spec:** [`docs/superpowers/specs/2026-07-25-knowledge-tab-readability-design.md`](../specs/2026-07-25-knowledge-tab-readability-design.md) — evidence ids `E1`–`E14` below refer to its Evidence table.

## Global Constraints

- Branch `feat/knowledge-tab-readability`, cut from `main`. All work lands here.
- Working directory for every command is the worktree `/Users/earth/Documents/GitHub/ai-dev-office/.worktrees/knowledge-tab-readability` unless a step says otherwise. This is NOT the main checkout — a parallel session works there on `feat/intake-owner-review`, and committing from it once already put three commits on the wrong branch. Run `git branch --show-current` before your first commit and abort if it is not `feat/knowledge-tab-readability`.
- No AI Dev Office `TASK-` run is required — `ai-dev-office/` is a meta/tooling repo, explicitly exempted by the workspace `CLAUDE.md`.
- Dark theme only. Use the existing custom properties in `globals.css:1-17` (`--bg-color`, `--card-bg`, `--card-bg-elevated`, `--text-primary` `#c9d1d9`, `--text-secondary` `#8b949e`, `--text-muted` `#6e7681`, `--accent-color` `#58a6ff`, `--accent-cyan` `#22d3ee`, `--border-color` `#30363d`, `--status-error` `#da3633`, `--status-warning` `#d29922`, `--status-success` `#238636`). Never hardcode a hex that duplicates one of these.
- Do not touch `dashboard/docs/` (untracked, belongs to the parallel M5 intake work).
- The dev server for this worktree is already running: client `localhost:3100`, API `localhost:4311`. It runs the worktree code against the canonical data root via `AI_OFFICE_ROOT`, so the corpus is the real 52 reviews. Ports 3000/4310 belong to the main checkout and serve different code — never verify against those. Do not start another with Bash — use the preview/browser tools. `nodemon` restarts the API on server edits; wait for `/api/health` to return 200 before hitting the API again.
- `client/tsconfig.json` excludes `src/**/*.test.ts`, so `npm run build` does not type-check test files. This is pre-existing and stays as-is.
- Commit after every task. Message style follows the repo: `type(scope): summary`, imperative, with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Client code imports shared types by relative path, never by alias.** `dashboard/client/tsconfig.json` has no `paths` mapping — the `@shared` alias exists only in `vite.config.ts`, so `tsc` in `npm run build` cannot resolve it, and `tsc` type-checks every file under `src` whether or not anything imports it. Every existing client file uses a relative specifier: `'../../../shared/types'` from `src/views/`, therefore `'../../../../shared/types'` from `src/views/knowledge/`. Follow that convention; do not add a paths mapping. The server is the opposite — its tsconfig does map the alias, so server code keeps using it.
- **All `globals.css` line numbers refer to the file as it stands at the start of Task 1.** Each task shifts them. Locate the block to replace by its first and last selector, not by line number.

---

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/shared/types.ts` | add `KnowledgeFindingPriorityCounts`; optional `priorityCounts` on `KnowledgeReviewSummary` |
| `dashboard/server/src/services/knowledgeReviews.ts` | compute the aggregate inside `toSummary()` |
| `dashboard/server/src/services/knowledgeReviews.test.ts` | prove the aggregate, including the zero-findings case |
| `dashboard/client/package.json` | Vitest devDependency + `test` script |
| `dashboard/client/tests/commandLogTime.test.ts` | convert `node:test` → Vitest (currently never runs) |
| `dashboard/client/src/intake/intakeApi.test.ts` | same conversion |
| `dashboard/client/src/intake-review/columns.test.ts` | same conversion |
| `dashboard/client/src/views/knowledge/format.ts` | all pure logic: labels, dates, path grouping, priority ordering. No React. |
| `dashboard/client/src/views/knowledge/format.test.ts` | unit tests over cases drawn from the real corpus |
| `dashboard/client/src/views/knowledge/KnowledgeReviewsView.tsx` | page: data fetching, selection, filter, layout, states |
| `dashboard/client/src/views/knowledge/ReviewListItem.tsx` | one row in the left list |
| `dashboard/client/src/views/knowledge/ReviewDetail.tsx` | detail header, meta line, section shells |
| `dashboard/client/src/views/knowledge/ScopePaths.tsx` | grouped scope paths + collapse |
| `dashboard/client/src/views/knowledge/FindingRecord.tsx` | one finding and one change record |
| `dashboard/client/src/views/knowledge/ViewState.tsx` | shared loading / empty / error panel |
| `dashboard/client/src/views/KnowledgeReviewsView.tsx` | **deleted** by Task 4 |
| `dashboard/client/src/App.tsx:15` | import repointed to `./views/knowledge/KnowledgeReviewsView` |
| `dashboard/client/src/styles/globals.css` | `.knowledge-*` block, lines 532–1051, plus its responsive blocks at 1053–1094 |

---

### Task 1: `priorityCounts` on the list projection

Server-side only. `loadAll()` already parses every full `KnowledgeReviewDetail` including findings, and `toSummary()` currently destructures `findings` away (E14). This turns that discarded data into the aggregate the list needs (E7), with no extra file read and no new endpoint.

**Files:**
- Modify: `dashboard/shared/types.ts:415-438`
- Modify: `dashboard/server/src/services/knowledgeReviews.ts:5-9,62-65`
- Test: `dashboard/server/src/services/knowledgeReviews.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `KnowledgeFindingPriorityCounts = Partial<Record<KnowledgeFindingPriority, number>>`, exported from `@shared/types`; optional field `priorityCounts?: KnowledgeFindingPriorityCounts` on `KnowledgeReviewSummary` (and therefore on `KnowledgeReviewDetail`, which extends it). Tasks 3 and 5 depend on both names.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/server/src/services/knowledgeReviews.test.ts`. The fixture helper below has been verified end-to-end against `ruby scripts/validate-knowledge-librarian.rb --json` — the same call `loadCanonicalReview` makes — for both the four-finding and the zero-finding shape.

```ts
function fixtureWithPriorities(reviewId: string, generatedAt: string, priorities: string[]): string {
  const findings = priorities
    .map((priority, index) => `  - fingerprint: ai-office:test-${index}
    note_path: "Knowledge Base/10 Projects/AI Office Agency/Project Map.md"
    question: "Is item ${index} current?"
    issue_type: source_drift
    status: new
    priority: ${priority}
    evidence_state: confirmed
    verification_scope: source
    sources: ["ai-dev-office/README.md"]
    recommended_action: update_note
    closure_criteria: "Current repository evidence confirms the answer"
    answer: "Yes"
    opened_at: "2026-07-21T11:00:00Z"
    closed_at: null
    confidence: high
    proposed_patch: "Update the source reference"`)
    .join('\n');

  return `
artifact_type: knowledge_librarian_review
schema_version: 1
review_id: ${reviewId}
generated_at: "${generatedAt}"
scope:
  product: ai-office
  paths: ["Knowledge Base/10 Projects/AI Office Agency/"]
  max_notes: 5
  timebox_minutes: 20
write_mode: proposal_only
review_mode: pre_write
authorization: null
requires_human_review: true
notes_reviewed: ["Knowledge Base/10 Projects/AI Office Agency/Project Map.md"]
findings:
${findings || ' []'}
changes: []
summary: "Reviewed one note."
`;
}

test('list projection aggregates finding priorities without a second read', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-review-priority-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'mixed.yaml'),
    fixtureWithPriorities('KLR-20260721T120000Z-mixed', '2026-07-21T12:00:00Z', ['critical', 'high', 'high', 'low']),
  );
  await fs.writeFile(
    path.join(dir, 'empty.yaml'),
    fixtureWithPriorities('KLR-20260721T110000Z-empty', '2026-07-21T11:00:00Z', []),
  );

  const result = await service(dir).list();

  assert.equal(result.total, 2);
  assert.deepEqual(result.reviews[0].priorityCounts, { critical: 1, high: 2, low: 1 });
  assert.deepEqual(result.reviews[1].priorityCounts, {});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npm test --prefix dashboard/server
```

Expected: the new test fails on the first `deepEqual` because `priorityCounts` is `undefined`. Every pre-existing test still passes.

- [ ] **Step 3: Add the type**

In `dashboard/shared/types.ts`, directly after the `KnowledgeEvidenceState` alias (line 417):

```ts
export type KnowledgeFindingPriorityCounts = Partial<Record<KnowledgeFindingPriority, number>>;
```

Then add one field to `KnowledgeReviewSummary`, after `summary: string;`:

```ts
  priorityCounts?: KnowledgeFindingPriorityCounts;
```

It is optional so every existing consumer and every fixture without the field keeps type-checking.

- [ ] **Step 4: Compute it in the projection**

In `dashboard/server/src/services/knowledgeReviews.ts`, add `KnowledgeFindingPriorityCounts` to the existing `import type { … } from '@shared/types'` block, then replace `toSummary` (lines 62-65) with:

```ts
function countPriorities(findings: KnowledgeReviewDetail['findings']): KnowledgeFindingPriorityCounts {
  const counts: KnowledgeFindingPriorityCounts = {};
  for (const finding of findings) {
    counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
  }
  return counts;
}

function toSummary(review: KnowledgeReviewDetail): KnowledgeReviewSummary {
  const { authorization: _authorization, notesReviewed: _notesReviewed, findings, changes: _changes, ...summary } = review;
  return { ...summary, priorityCounts: countPriorities(findings) };
}
```

Note the destructure changes from `findings: _findings` to `findings` — the value is now used rather than discarded.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm test --prefix dashboard/server
```

Expected: all tests pass, including the new one.

- [ ] **Step 6: Confirm the live API serves the field**

`nodemon` restarts on the edit. Wait for health, then check a review that has findings:

```bash
curl -s http://localhost:4311/api/knowledge-reviews | python3 -c "import json,sys; r=json.load(sys.stdin)['reviews']; print([x['priorityCounts'] for x in r[:5]])"
```

Expected: real aggregates, e.g. `[{'low': 1}, …]`, not a list of `None`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/shared/types.ts dashboard/server/src/services/knowledgeReviews.ts dashboard/server/src/services/knowledgeReviews.test.ts
git commit -m "feat(dashboard): aggregate finding priorities into the knowledge review list projection

Computed from findings toSummary() already held in memory, so the list can
show priority without a second read or a new endpoint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Client test harness

The client has three tracked test files and no runner. They are written against `node:test`, and nothing in any `package.json` executes them — the server's `test` script globs `server/src/**/*.test.ts` only. A probe run confirmed all eight assertions inside them currently pass, but Vitest reports `No test suite found` for all three because the registrations go to Node's runner instead of Vitest's. Converting the import is a one-line change per file and brings eight dormant tests to life.

**Files:**
- Modify: `dashboard/client/package.json`
- Modify: `dashboard/client/tests/commandLogTime.test.ts:2`
- Modify: `dashboard/client/src/intake/intakeApi.test.ts:1`
- Modify: `dashboard/client/src/intake-review/columns.test.ts:1`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test --prefix dashboard/client` runs Vitest. Task 3 relies on it.

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev --prefix dashboard/client vitest@^2.1.9
```

No config file is needed. Vitest reads `client/vite.config.ts`, which already declares the `@shared` alias, and the default `node` environment suits pure-logic tests.

- [ ] **Step 2: Add the test script**

In `dashboard/client/package.json`, add to `scripts`:

```json
    "test": "TZ=UTC vitest run"
```

`TZ=UTC` keeps the suite deterministic on any host. `formatReviewDate` (Task 3) renders in the viewer's local timezone to match the rest of the dashboard, which makes its absolute-date assertions host-dependent — on a UTC-10 host, `2026-07-22T08:24:02Z` renders as `21 Jul`, not `22 Jul`. Pinning the runner's zone fixes the test without changing what users see. The only other date-sensitive client test asserts a pattern rather than a value, so it is unaffected.

- [ ] **Step 3: Run it and confirm the three suites fail**

```bash
npm test --prefix dashboard/client
```

Expected: `Test Files 3 failed (3)`, each with `Error: No test suite found in file …`. The individual assertions still print as passing above the failure summary — that is Node's runner writing to stdout, and it is exactly the bug being fixed.

- [ ] **Step 4: Convert the three imports**

`dashboard/client/tests/commandLogTime.test.ts` line 2 — this one is a default import:

```ts
import { test } from 'vitest';
```

`dashboard/client/src/intake/intakeApi.test.ts` line 1 and `dashboard/client/src/intake-review/columns.test.ts` line 1:

```ts
import { test } from 'vitest';
```

Leave `import assert from 'node:assert/strict'` alone in all three. Vitest reports a thrown `AssertionError` as a normal failure, so the existing assertions keep working unchanged.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npm test --prefix dashboard/client
```

Expected: `Test Files 3 passed (3)`, `Tests 8 passed (8)`.

- [ ] **Step 6: Confirm the production build is unaffected**

```bash
npm run build --prefix dashboard/client
```

Expected: `tsc` clean, Vite build succeeds. (`tsconfig.json` excludes test files, so the Vitest import is never type-checked by the build.)

- [ ] **Step 7: Commit**

```bash
git add dashboard/client/package.json dashboard/client/package-lock.json dashboard/client/tests/commandLogTime.test.ts dashboard/client/src/intake/intakeApi.test.ts dashboard/client/src/intake-review/columns.test.ts
git commit -m "test(dashboard): run the client test suite with vitest

Three tracked test files were written against node:test and executed by
nothing. Converting the import brings eight dormant assertions into CI reach.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Pure formatting and grouping logic

Every heuristic in this change lives here, isolated from React so it can be tested against the real corpus. Nothing renders yet.

**Files:**
- Create: `dashboard/client/src/views/knowledge/format.ts`
- Test: `dashboard/client/src/views/knowledge/format.test.ts`

**Interfaces:**
- Consumes: `KnowledgeFindingPriorityCounts` from Task 1.
- Produces, all from `./format`:
  - `PRIORITY_ORDER: KnowledgeFindingPriority[]`
  - `OTHER_PATH_GROUP: 'Other'`
  - `humanizeLabel(value: string): string`
  - `normalizeLabel(value: string): string`
  - `reviewSlug(reviewId: string): string`
  - `reviewTitle(reviewId: string, product: string): string`
  - `shouldShowProduct(product: string, title: string): boolean`
  - `formatReviewDate(iso: string, now?: Date): string`
  - `interface ScopePathGroup { root: string; paths: string[] }`
  - `groupPathsByRoot(paths: string[]): ScopePathGroup[]`
  - `reviewRepos(paths: string[]): string[]`
  - `maxPriority(counts: KnowledgeFindingPriorityCounts | undefined): KnowledgeFindingPriority | null`
  - `sortFindingsByPriority(findings: KnowledgeReviewFinding[]): KnowledgeReviewFinding[]`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/client/src/views/knowledge/format.test.ts`. Every case is drawn from the live corpus of 52 reviews.

```ts
import { describe, test, expect } from 'vitest';
import {
  formatReviewDate,
  groupPathsByRoot,
  humanizeLabel,
  maxPriority,
  normalizeLabel,
  reviewRepos,
  reviewTitle,
  shouldShowProduct,
  sortFindingsByPriority,
  OTHER_PATH_GROUP,
} from './format';
import type { KnowledgeReviewFinding } from '../../../../shared/types';

describe('humanizeLabel', () => {
  test('title-cases separated words', () => {
    expect(humanizeLabel('games-labs-store_items')).toBe('Games Labs Store Items');
  });

  test('keeps known acronyms upper-case', () => {
    expect(humanizeLabel('games-labs-vip-profile-display-contract')).toBe('Games Labs VIP Profile Display Contract');
    expect(humanizeLabel('adr-and-api-and-ui')).toBe('ADR And API And UI');
  });

  test('survives empty input', () => {
    expect(humanizeLabel('')).toBe('');
  });
});

describe('reviewTitle', () => {
  test('strips the KLR timestamp prefix', () => {
    expect(reviewTitle('KLR-20260722T082402Z-games-labs-store-avatar-list-vip-boundary', 'games_labs'))
      .toBe('Games Labs Store Avatar List VIP Boundary');
  });

  test('falls back to the product when the slug is empty', () => {
    expect(reviewTitle('KLR-20260722T082402Z-', 'games_labs')).toBe('Games Labs');
  });
});

describe('shouldShowProduct', () => {
  test('hides a product identical to the title', () => {
    const title = reviewTitle('KLR-20260724T102918Z-games-labs-backoffice-pass-game-support', 'games_labs_backoffice_pass_game_support');
    expect(shouldShowProduct('games_labs_backoffice_pass_game_support', title)).toBe(false);
  });

  test('hides a product the title already contains', () => {
    const title = reviewTitle('KLR-20260722T082402Z-games-labs-store-avatar-list-vip-boundary', 'games_labs');
    expect(shouldShowProduct('games_labs', title)).toBe(false);
  });

  test('shows a product that carries independent information', () => {
    const title = reviewTitle('KLR-20260724T180805Z-ai-office-dashboard-knowledge-tab', 'ai_office_agency');
    expect(shouldShowProduct('ai_office_agency', title)).toBe(true);
  });

  test('hides an empty product', () => {
    expect(shouldShowProduct('', 'Anything')).toBe(false);
  });
});

describe('normalizeLabel', () => {
  test('reduces to lower-case alphanumerics', () => {
    expect(normalizeLabel('Games Labs weekly review 2026W30')).toBe('gameslabsweeklyreview2026w30');
  });
});

describe('groupPathsByRoot', () => {
  test('groups by first segment and strips the shared prefix', () => {
    const groups = groupPathsByRoot([
      'Games-Labs-Missions/proto/missionspb/missions.proto',
      'Knowledge Base/10 Projects/Games Labs Missions/Project Map.md',
      'Games-Labs-Missions/internal/models/models.go',
    ]);
    expect(groups).toEqual([
      { root: 'Games-Labs-Missions', paths: ['proto/missionspb/missions.proto', 'internal/models/models.go'] },
      { root: 'Knowledge Base', paths: ['10 Projects/Games Labs Missions/Project Map.md'] },
    ]);
  });

  test('sinks non-path entries into a trailing catch-all, verbatim', () => {
    const groups = groupPathsByRoot([
      'Games-Labs-Wallet draft PR #9',
      'https://sparqlab.example/thing',
      'shared-lib/pkg/localized/localized.go',
      'AGENTS.md',
    ]);
    expect(groups[0]).toEqual({ root: 'shared-lib', paths: ['pkg/localized/localized.go'] });
    expect(groups[groups.length - 1]).toEqual({
      root: OTHER_PATH_GROUP,
      paths: ['Games-Labs-Wallet draft PR #9', 'https://sparqlab.example/thing', 'AGENTS.md'],
    });
  });

  test('treats a leading slash as unrooted rather than an empty group', () => {
    const groups = groupPathsByRoot(['/absolute/path.md']);
    expect(groups).toEqual([{ root: OTHER_PATH_GROUP, paths: ['/absolute/path.md'] }]);
  });

  test('returns nothing for no paths', () => {
    expect(groupPathsByRoot([])).toEqual([]);
  });
});

describe('reviewRepos', () => {
  test('lists real roots only, largest group first', () => {
    expect(reviewRepos([
      'Knowledge Base/Review Queue.md',
      'Games-Labs-Order/services/ordersvc/service.go',
      'Games-Labs-Order/admin/adminorderpb/adminorder.proto',
      'some free text',
    ])).toEqual(['Games-Labs-Order', 'Knowledge Base']);
  });
});

describe('maxPriority', () => {
  test('picks the most severe present', () => {
    expect(maxPriority({ high: 2, low: 1 })).toBe('high');
    expect(maxPriority({ critical: 1, high: 2, low: 1 })).toBe('critical');
    expect(maxPriority({ low: 3 })).toBe('low');
  });

  test('returns null for no findings or a missing field', () => {
    expect(maxPriority({})).toBe(null);
    expect(maxPriority(undefined)).toBe(null);
  });
});

describe('sortFindingsByPriority', () => {
  const finding = (fingerprint: string, priority: KnowledgeReviewFinding['priority']) =>
    ({ fingerprint, priority } as KnowledgeReviewFinding);

  test('orders critical first and low last, stable within a tier', () => {
    const sorted = sortFindingsByPriority([
      finding('a', 'low'),
      finding('b', 'high'),
      finding('c', 'critical'),
      finding('d', 'high'),
      finding('e', 'medium'),
    ]);
    expect(sorted.map((item) => item.fingerprint)).toEqual(['c', 'b', 'd', 'e', 'a']);
  });

  test('does not mutate the input', () => {
    const input = [finding('a', 'low'), finding('b', 'critical')];
    sortFindingsByPriority(input);
    expect(input.map((item) => item.fingerprint)).toEqual(['a', 'b']);
  });
});

describe('formatReviewDate', () => {
  const now = new Date('2026-07-25T12:00:00Z');

  test('uses relative time under 48 hours', () => {
    expect(formatReviewDate('2026-07-25T11:59:40Z', now)).toBe('just now');
    expect(formatReviewDate('2026-07-25T11:30:00Z', now)).toBe('30m ago');
    expect(formatReviewDate('2026-07-24T12:00:00Z', now)).toBe('24h ago');
  });

  test('uses a short date beyond 48 hours', () => {
    expect(formatReviewDate('2026-07-22T08:24:02Z', now)).toBe('22 Jul');
  });

  test('includes the year when it differs from now', () => {
    expect(formatReviewDate('2025-12-01T08:00:00Z', now)).toBe('1 Dec 2025');
  });

  test('returns the input unchanged when it is not a date', () => {
    expect(formatReviewDate('not-a-date', now)).toBe('not-a-date');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npm test --prefix dashboard/client
```

Expected: the `format.test.ts` suite fails to resolve `./format`. The three suites converted in Task 2 still pass.

- [ ] **Step 3: Write the implementation**

Create `dashboard/client/src/views/knowledge/format.ts`:

```ts
import type {
  KnowledgeFindingPriority,
  KnowledgeFindingPriorityCounts,
  KnowledgeReviewFinding,
} from '../../../../shared/types';

// Words the generator emits lower-case that must not be title-cased into "Vip".
const ACRONYMS = new Set([
  'adr', 'ai', 'api', 'bc', 'ci', 'cli', 'css', 'db', 'id', 'kb', 'pr',
  'qa', 'sdk', 'ui', 'url', 'ux', 'vip', 'vps', 'yaml',
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const PRIORITY_ORDER: KnowledgeFindingPriority[] = ['critical', 'high', 'medium', 'low'];

export const OTHER_PATH_GROUP = 'Other';

export interface ScopePathGroup {
  root: string;
  paths: string[];
}

export function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase())
      ? word.toUpperCase()
      : word.replace(/^./, (char) => char.toUpperCase())))
    .join(' ');
}

export function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function reviewSlug(reviewId: string): string {
  return reviewId.replace(/^KLR-[0-9]{8}T[0-9]{6}Z-/, '');
}

export function reviewTitle(reviewId: string, product: string): string {
  return humanizeLabel(reviewSlug(reviewId) || product);
}

// The generator has no controlled vocabulary for scope.product, so two thirds of
// rows repeat the title verbatim. Show the product only when it adds something.
export function shouldShowProduct(product: string, title: string): boolean {
  const normalizedProduct = normalizeLabel(product);
  const normalizedTitle = normalizeLabel(title);
  if (!normalizedProduct) return false;
  if (!normalizedTitle) return true;
  return !normalizedTitle.includes(normalizedProduct) && !normalizedProduct.includes(normalizedTitle);
}

// scope.paths is not guaranteed to hold paths — the corpus also carries commit
// SHAs, PR references and prose. Anything unrooted keeps its verbatim text in a
// trailing catch-all rather than being dropped or mangled into a fake group.
export function groupPathsByRoot(paths: string[]): ScopePathGroup[] {
  const groups = new Map<string, string[]>();

  for (const entry of paths) {
    const segments = entry.split('/');
    const root = segments[0];
    const rooted = segments.length > 1 && root.trim() !== '' && !root.endsWith(':');
    const key = rooted ? root : OTHER_PATH_GROUP;
    const value = rooted ? segments.slice(1).join('/') : entry;
    const bucket = groups.get(key);
    if (bucket) bucket.push(value);
    else groups.set(key, [value]);
  }

  return [...groups.entries()]
    .map(([root, grouped]) => ({ root, paths: grouped }))
    .sort((a, b) => {
      if (a.root === OTHER_PATH_GROUP) return 1;
      if (b.root === OTHER_PATH_GROUP) return -1;
      return b.paths.length - a.paths.length;
    });
}

export function reviewRepos(paths: string[]): string[] {
  return groupPathsByRoot(paths)
    .filter((group) => group.root !== OTHER_PATH_GROUP)
    .map((group) => group.root);
}

export function maxPriority(counts: KnowledgeFindingPriorityCounts | undefined): KnowledgeFindingPriority | null {
  if (!counts) return null;
  return PRIORITY_ORDER.find((priority) => (counts[priority] ?? 0) > 0) ?? null;
}

export function sortFindingsByPriority(findings: KnowledgeReviewFinding[]): KnowledgeReviewFinding[] {
  return [...findings].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  );
}

// Renders in the viewer's local timezone, deliberately: every other timestamp
// in this dashboard uses toLocaleString/toLocaleDateString, including the
// "Generated" line that sits beside this one in the detail header. That makes
// the absolute branch host-dependent, so the suite pins TZ=UTC to stay
// deterministic — see the client's test script.
export function formatReviewDate(iso: string, now: Date = new Date()): string {
  const timestamp = new Date(iso);
  if (!Number.isFinite(timestamp.getTime())) return iso;

  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - timestamp.getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h ago`;

  const day = timestamp.getDate();
  const month = MONTHS[timestamp.getMonth()];
  return timestamp.getFullYear() === now.getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${timestamp.getFullYear()}`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npm test --prefix dashboard/client
```

Expected: all four suites pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/views/knowledge/format.ts dashboard/client/src/views/knowledge/format.test.ts
git commit -m "feat(dashboard): pure formatting and grouping logic for knowledge reviews

Acronym-aware labels, product de-duplication, repo-rooted path grouping and
priority ordering, isolated from React and tested against the real corpus.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Split the view — no behaviour change

A pure move. The rendered page must be pixel-identical when this task ends; that is what makes the following four tasks reviewable as design changes rather than a mixed diff.

**Files:**
- Create: `dashboard/client/src/views/knowledge/KnowledgeReviewsView.tsx`
- Create: `dashboard/client/src/views/knowledge/ReviewListItem.tsx`
- Create: `dashboard/client/src/views/knowledge/ReviewDetail.tsx`
- Create: `dashboard/client/src/views/knowledge/ScopePaths.tsx`
- Create: `dashboard/client/src/views/knowledge/FindingRecord.tsx`
- Create: `dashboard/client/src/views/knowledge/ViewState.tsx`
- Delete: `dashboard/client/src/views/KnowledgeReviewsView.tsx`
- Modify: `dashboard/client/src/App.tsx:15`

**Interfaces:**
- Consumes: `format.ts` from Task 3.
- Produces:
  - `KnowledgeReviewsView(): JSX.Element` — default page export, named.
  - `ReviewListItem({ review, selected, onSelect }: { review: KnowledgeReviewSummary; selected: boolean; onSelect: (id: string) => void })`
  - `ReviewDetail({ review }: { review: KnowledgeReviewDetail })`
  - `ScopePaths({ paths }: { paths: string[] })`
  - `FindingRecord({ finding }: { finding: KnowledgeReviewFinding })` and `ChangeRecord({ change }: { change: KnowledgeReviewChange })`
  - `ViewState({ icon, title, detail, error }: { icon: React.ReactNode; title: string; detail?: string; error?: boolean })`
  - `ExpandableText({ text }: { text: string })` from `FindingRecord.tsx`

- [ ] **Step 1: Move each component into its own file**

Copy the existing bodies out of `src/views/KnowledgeReviewsView.tsx` verbatim, changing only imports:

- `ViewState.tsx` ← `ViewState` (lines 321-329) and `EmptyLine` (317-319).
- `ScopePaths.tsx` ← the `knowledge-paths-block` JSX from `ReviewDetail` (lines 221-230), lifted into a component taking `paths: string[]`. Keep it rendering the existing pill markup for now.
- `FindingRecord.tsx` ← the `<article className="knowledge-record">` bodies for findings (241-256) and changes (268-283) as `FindingRecord` and `ChangeRecord`, plus `ExpandableText` (293-306) and `Fact` (308-315).
- `ReviewDetail.tsx` ← `ReviewDetail` (200-291), importing the three above.
- `ReviewListItem.tsx` ← `ReviewListItem` (176-198).
- `KnowledgeReviewsView.tsx` ← the page component (7-174).

Delete `reviewTitle`, `humanizeLabel`, `shortPath` and `formatRelativeTime` from the old file and import from `./format` instead. `shortPath` has no replacement — inline its two-line body into `ScopePaths.tsx` and `FindingRecord.tsx` for now; Task 7 and Task 8 remove both call sites.

Call sites change shape slightly because `reviewTitle` now takes two arguments:

```ts
// was: reviewTitle(review)
reviewTitle(review.reviewId, review.scope.product)
// was: formatRelativeTime(review.generatedAt)
formatReviewDate(review.generatedAt)
```

`formatReviewDate` renders `22 Jul` where `formatRelativeTime` rendered `7/22/2026` for anything past two weeks. That is the only intended visible difference in this task.

- [ ] **Step 2: Delete the old file and repoint the import**

```bash
git rm dashboard/client/src/views/KnowledgeReviewsView.tsx
```

`dashboard/client/src/App.tsx` line 15:

```ts
import { KnowledgeReviewsView } from './views/knowledge/KnowledgeReviewsView';
```

- [ ] **Step 3: Verify the build and the tests**

```bash
npm run build --prefix dashboard/client && npm test --prefix dashboard/client
```

Expected: `tsc` clean, Vite build succeeds, all tests pass.

- [ ] **Step 4: Verify in the browser**

Using the browser tools, not Bash:

1. Navigate to `http://localhost:3100/?tab=knowledge` at a 1440x900 viewport.
2. `read_console_messages` — expect no errors.
3. Screenshot the default selection, and confirm the layout matches the pre-split page apart from the date format noted in Step 1.
4. Filter for `avatar-list-vip`, select the result, confirm the detail renders its 8 findings and 13 scope paths.

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/src/views/knowledge dashboard/client/src/App.tsx
git commit -m "refactor(dashboard): split the knowledge reviews view into components

Moves the 361-line view into views/knowledge/ with one responsibility per file
and the pure helpers behind format.ts. No behaviour change beyond the shared
date format.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: List row

Closes E2 (67% of rows print the product twice), E3 (product is not a category) and E7 (priority invisible).

**Files:**
- Modify: `dashboard/client/src/views/knowledge/ReviewListItem.tsx`
- Modify: `dashboard/client/src/styles/globals.css:715-804`

**Interfaces:**
- Consumes: `maxPriority`, `reviewRepos`, `reviewTitle`, `shouldShowProduct`, `humanizeLabel`, `formatReviewDate` from `./format`; `priorityCounts` from Task 1.
- Produces: no new exported symbols; `ReviewListItem`'s props are unchanged.

- [ ] **Step 1: Rewrite the component body**

```tsx
export function ReviewListItem({ review, selected, onSelect }: {
  review: KnowledgeReviewSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const title = reviewTitle(review.reviewId, review.scope.product);
  const priority = maxPriority(review.priorityCounts);
  const repos = reviewRepos(review.scope.paths);
  const criticalCount = review.priorityCounts?.critical ?? 0;
  const highCount = review.priorityCounts?.high ?? 0;

  return (
    <button
      type="button"
      className={`knowledge-review-item ${selected ? 'active' : ''} priority-edge-${priority ?? 'none'}`}
      onClick={() => onSelect(review.reviewId)}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="knowledge-review-item-top">
        <strong className="knowledge-review-item-title">{title}</strong>
        <time dateTime={review.generatedAt}>{formatReviewDate(review.generatedAt)}</time>
      </div>

      {shouldShowProduct(review.scope.product, title) && (
        <span className="knowledge-review-product">{humanizeLabel(review.scope.product)}</span>
      )}

      {repos.length > 0 && (
        <div className="knowledge-review-repos">
          {repos.slice(0, 2).join(' · ')}
          {repos.length > 2 && <span className="knowledge-review-repos-more"> +{repos.length - 2}</span>}
        </div>
      )}

      <div className="knowledge-review-item-footer">
        {criticalCount > 0 && <span className="knowledge-review-alarm priority-critical">{criticalCount} critical</span>}
        {highCount > 0 && <span className="knowledge-review-alarm priority-high">{highCount} high</span>}
        <span>{review.findingsCount} findings</span>
        <span>{review.changesCount} changes</span>
        {review.writeMode === 'approved_scope_auto_write' && <span className="knowledge-mode-chip mode-auto">auto-write</span>}
      </div>
    </button>
  );
}
```

Two deliberate choices. The `proposal` chip is gone — it was on 43 of 52 rows, so it marked the default and carried no signal; only `auto-write` is now labelled. And the title is the humanised slug verbatim, with no token surgery to shorten it: hiding the duplicate product already removes the redundancy, and trimming words out of a title risks dropping the part that distinguishes two sibling reviews.

- [ ] **Step 2: Replace the row CSS**

In `globals.css`, replace the rules from `.knowledge-review-item` through `.knowledge-review-product` (lines 715-804):

```css
.knowledge-review-item {
  display: grid;
  gap: 5px;
  width: 100%;
  padding: 12px 14px 12px 16px;
  border: 0;
  border-bottom: 1px solid var(--border-color);
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.knowledge-review-item:last-child {
  border-bottom: 0;
}

.knowledge-review-item:hover,
.knowledge-review-item:focus-visible {
  background: var(--card-bg);
  outline: none;
}

.knowledge-review-item:focus-visible,
.knowledge-review-item.active {
  box-shadow: inset 3px 0 var(--accent-color);
}

.knowledge-review-item.active {
  background: var(--card-bg-elevated);
}

/* Priority rides the left border; selection rides the inset shadow, so the two
   never compete for the same channel. */
.knowledge-review-item.priority-edge-critical,
.knowledge-review-item.priority-edge-high {
  border-left-color: var(--status-error);
}

.knowledge-review-item.priority-edge-medium {
  border-left-color: var(--status-warning);
}

.knowledge-review-item.priority-edge-low {
  border-left-color: var(--border-color);
}

.knowledge-review-item-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.knowledge-review-item-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.knowledge-review-item-top time {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
}

.knowledge-review-repos {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.knowledge-review-repos-more {
  color: var(--text-muted);
}

.knowledge-review-item-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--text-secondary);
  font-size: 11px;
}

.knowledge-review-alarm {
  font-weight: 600;
}

.knowledge-review-alarm.priority-critical,
.knowledge-review-alarm.priority-high {
  color: var(--status-error);
}

.knowledge-mode-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
}

.knowledge-mode-chip.mode-auto {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 45%, transparent);
  background: color-mix(in srgb, var(--accent-color) 10%, transparent);
}

.knowledge-review-product {
  color: var(--accent-cyan);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
```

This replacement deletes `.knowledge-count-chip` and `.knowledge-mode-chip.mode-proposal` along with the range, which is correct — Step 1 dropped both call sites. It also deletes the old shared `.knowledge-review-item-top, .knowledge-review-item-footer` flex rule, replaced above by separate rules for each.

- [ ] **Step 3: Verify in the browser**

1. Reload `http://localhost:3100/?tab=knowledge`.
2. Confirm no row prints the same words in both the product line and the title — the `games-labs-backoffice-pass-game-support` row is the reference case.
3. Confirm the `ai-office-dashboard-knowledge-tab` row **does** still show `AI Office Agency`, since its product carries independent information.
4. Confirm rows with high or critical findings show a red left edge and a coloured count, and that selecting one keeps the blue selection bar readable against it.
5. `read_console_messages` — no errors.
6. Screenshot the list column.

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/src/views/knowledge/ReviewListItem.tsx dashboard/client/src/styles/globals.css
git commit -m "feat(dashboard): rebuild the knowledge review list row around title, repos and priority

Drops the product kicker on the two thirds of rows where it repeated the title,
replaces it with the repos the review touched, and surfaces max finding priority
on the left edge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Detail header and meta line

Closes E1 (110-character measure), E6 (`reviewMode` duplicates `writeMode`) and part of E8 (no anchor across 4.8 screens).

**Files:**
- Modify: `dashboard/client/src/views/knowledge/ReviewDetail.tsx`
- Modify: `dashboard/client/src/styles/globals.css:806-909`

**Interfaces:**
- Consumes: `reviewTitle`, `humanizeLabel` from `./format`.
- Produces: `Fact` is deleted — no other file may import it after this task.

- [ ] **Step 1: Replace the summary card**

In `ReviewDetail.tsx`, replace the `knowledge-summary-card` section:

```tsx
<section className="card knowledge-summary-card">
  <div className="knowledge-detail-title-row">
    <div className="knowledge-detail-heading">
      <h2>{reviewTitle(review.reviewId, review.scope.product)}</h2>
      <code className="knowledge-review-id">{review.reviewId}</code>
    </div>
    <span className={`status-badge ${review.writeMode === 'approved_scope_auto_write' ? 'status-running' : 'status-queued'}`}>
      {review.writeMode === 'approved_scope_auto_write' ? 'auto-write approved' : 'proposal only'}
    </span>
  </div>

  <p className="knowledge-detail-meta">
    <span>{new Date(review.generatedAt).toLocaleString()}</span>
    <span>{review.notesReviewedCount} notes reviewed</span>
    <span>{review.appliedChangesCount} applied</span>
  </p>

  <p className="knowledge-summary-text">{review.summary}</p>

  {review.scope.paths.length > 0 && <ScopePaths paths={review.scope.paths} />}
</section>
```

Three things go away. The product kicker above the `<h2>` — the same duplication Task 5 removed, and the title already carries it. The `knowledge-fact-grid` with its four `Fact` tiles — `Review mode` is 1:1 redundant with the badge already on this row (E6), and the remaining three values are short enough to sit on one line. And the `Fact` component itself, now unused.

- [ ] **Step 2: Replace the detail CSS**

Replace `.knowledge-detail-title-row` through `.knowledge-paths-block` (lines 817-890) with:

```css
.knowledge-detail-title-row,
.knowledge-record-heading,
.knowledge-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.knowledge-detail-heading {
  min-width: 0;
}

.knowledge-detail-title-row h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.02em;
}

.knowledge-review-id {
  display: inline-block;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.knowledge-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin: 12px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.knowledge-detail-meta > span + span::before {
  content: '·';
  margin-right: 10px;
  color: var(--text-muted);
}

/* E1: prose was rendering ~110 characters per line. Cap the measure without
   narrowing the card. */
.knowledge-summary-text {
  max-width: 72ch;
  margin: 14px 0 0;
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.65;
}

/* Kept — ScopePaths still renders this wrapper and its label. */
.knowledge-paths-block {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
```

The replaced range also contains `.knowledge-fact-grid`, `.knowledge-fact`, `.knowledge-fact strong` and the shared `.knowledge-fact span, .knowledge-section-heading > span, .knowledge-paths-label` rule. Dropping the first three is the point of this task. The fourth is shared, so re-add the two selectors that survive:

```css
.knowledge-section-heading > span,
.knowledge-paths-label {
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

Then make the header sticky within the detail scroller, so the review stays identified across E8's long scroll. Add after `.knowledge-summary-card`'s rules:

```css
.knowledge-summary-card {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card-bg);
}
```

- [ ] **Step 3: Verify in the browser**

1. Reload and select the `avatar-list-vip` review.
2. Run in the page console via `javascript_tool`:

```js
const s = document.querySelector('.knowledge-summary-text');
JSON.stringify({ width: s.getBoundingClientRect().width, font: getComputedStyle(s).fontSize })
```

Expected: width around 660-700px at 15px, versus the 998px at 16px measured before this change.

3. Confirm no `Review mode` tile remains anywhere on the page.
4. Scroll the detail column and confirm the title block stays pinned and stays legible over the content scrolling beneath it.
5. `read_console_messages` — no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/src/views/knowledge/ReviewDetail.tsx dashboard/client/src/styles/globals.css
git commit -m "feat(dashboard): cap the knowledge review measure and collapse the fact grid

Caps long-form text at 72ch, replaces the four-tile grid with one meta line, and
drops the Review mode tile -- pre_write/post_write is 1:1 with the write mode
badge already on the row. Header sticks while the detail scrolls.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Grouped scope paths

Closes E4 (median 6, max 18 paths as identical pills) and E5 (entries that are not paths).

**Files:**
- Modify: `dashboard/client/src/views/knowledge/ScopePaths.tsx`
- Modify: `dashboard/client/src/styles/globals.css:892-909`

**Interfaces:**
- Consumes: `groupPathsByRoot` from `./format`.
- Produces: `ScopePaths({ paths }: { paths: string[] })` — unchanged signature.

- [ ] **Step 1: Rewrite the component**

```tsx
import { useState } from 'react';
import { groupPathsByRoot } from './format';

const COLLAPSED_GROUP_LIMIT = 3;

export function ScopePaths({ paths }: { paths: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupPathsByRoot(paths);
  const collapsible = groups.length > COLLAPSED_GROUP_LIMIT;
  const visible = expanded || !collapsible ? groups : groups.slice(0, COLLAPSED_GROUP_LIMIT);

  return (
    <div className="knowledge-paths-block">
      <span className="knowledge-paths-label">Scope paths</span>
      {visible.map((group) => (
        <div key={group.root} className="knowledge-path-group">
          <span className="knowledge-path-root">
            {group.root} <span className="knowledge-path-count">{group.paths.length}</span>
          </span>
          <span className="knowledge-path-list">{group.paths.join(' · ')}</span>
        </div>
      ))}
      {collapsible && (
        <button type="button" className="knowledge-expand-button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : `Show all ${paths.length} paths`}
        </button>
      )}
    </div>
  );
}
```

`shortPath` is no longer imported here — the shared prefix is now the group heading, so the remainder is shown in full rather than truncated with a leading ellipsis.

- [ ] **Step 2: Replace the path CSS**

Replace `.knowledge-paths` and the `.knowledge-paths code, .knowledge-note-path` rule (lines 892-909) with:

```css
.knowledge-path-group {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
}

.knowledge-path-root {
  color: var(--accent-cyan);
  font-size: 11px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.knowledge-path-count {
  color: var(--text-muted);
  font-weight: 400;
}

.knowledge-path-list {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.knowledge-note-path {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
```

`.knowledge-note-path` loses its pill treatment here; Task 8 changes its markup to match.

- [ ] **Step 3: Verify in the browser**

1. Select the `avatar-list-vip` review (13 paths across several roots).
2. Confirm the paths render as labelled groups with the repo name once per group, and that `Show all 13 paths` appears and toggles.
3. Find a review whose scope carries a non-path entry and confirm it appears verbatim under `Other` at the bottom. Locate one with:

```bash
curl -s http://localhost:4311/api/knowledge-reviews | python3 -c "
import json,sys
for r in json.load(sys.stdin)['reviews']:
    odd = [p for p in r['scope']['paths'] if '/' not in p or p.split('/')[0].endswith(':')]
    if odd: print(r['reviewId'], odd[:2])
" | head -5
```

4. `read_console_messages` — no errors. Screenshot the scope block.

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/src/views/knowledge/ScopePaths.tsx dashboard/client/src/styles/globals.css
git commit -m "feat(dashboard): group knowledge review scope paths by repo

Lifts the shared prefix into a group heading instead of repeating it inside
thirteen identical pills, collapses past three groups, and keeps entries that
are not paths verbatim in a trailing group rather than mangling them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Finding and change records

Closes E7's ordering half (the one finding that matters can currently sit last), E9 (the clamp fires on 59% of answers) and the vertical cost of the 4-column `<dl>`.

**Files:**
- Modify: `dashboard/client/src/views/knowledge/FindingRecord.tsx`
- Modify: `dashboard/client/src/views/knowledge/ReviewDetail.tsx`
- Modify: `dashboard/client/src/styles/globals.css:911-1012`

**Interfaces:**
- Consumes: `sortFindingsByPriority`, `humanizeLabel` from `./format`.
- Produces: `FindingRecord` and `ChangeRecord` keep their signatures; `ExpandableText` gains no props.

- [ ] **Step 1: Sort findings at the call site**

In `ReviewDetail.tsx`, replace `review.findings.map(…)` with:

```tsx
sortFindingsByPriority(review.findings).map((finding) => (
  <FindingRecord key={finding.fingerprint} finding={finding} />
))
```

and move the count next to the heading in both section headers:

```tsx
<div className="knowledge-section-heading">
  <h3>Findings <span>{review.findings.length}</span></h3>
</div>
```

- [ ] **Step 2: Rewrite the record bodies**

```tsx
export function FindingRecord({ finding }: { finding: KnowledgeReviewFinding }) {
  return (
    <article className={`knowledge-record priority-edge-${finding.priority}`}>
      <strong className="knowledge-record-title">{finding.question}</strong>
      <div className="knowledge-record-meta">
        <span className={`knowledge-priority priority-${finding.priority}`}>{finding.priority}</span>
        <span>{humanizeLabel(finding.status)}</span>
        <span>evidence {humanizeLabel(finding.evidenceState).toLowerCase()}</span>
        <span>{humanizeLabel(finding.verificationScope).toLowerCase()} scope</span>
        <span>{humanizeLabel(finding.recommendedAction).toLowerCase()}</span>
      </div>
      {finding.answer && <ExpandableText text={finding.answer} />}
      <code className="knowledge-note-path" title={finding.notePath}>{finding.notePath}</code>
    </article>
  );
}

export function ChangeRecord({ change }: { change: KnowledgeReviewChange }) {
  return (
    <article className={`knowledge-record ${change.disposition === 'applied' ? 'change-applied' : ''}`}>
      <strong className="knowledge-record-title">{change.summary}</strong>
      <div className="knowledge-record-meta">
        <span className={`status-badge ${change.disposition === 'applied' ? 'status-completed' : 'status-queued'}`}>
          {change.disposition}
        </span>
        <span>{humanizeLabel(change.targetClass)}</span>
        <span>{humanizeLabel(change.action).toLowerCase()}</span>
      </div>
      <code className="knowledge-note-path" title={change.notePath}>{change.notePath}</code>
    </article>
  );
}
```

The note path is now shown in full rather than through `shortPath` — it sits on its own line in muted monospace, so the leading ellipsis was hiding the repo for no space saving. Delete the inlined `shortPath` helper from this file.

- [ ] **Step 3: Raise the clamp**

In `ExpandableText`, change the threshold and keep the rest:

```tsx
const needsClamp = text.length > 420;
```

Median answer length is 359 characters, so a 280-character threshold made "Show more" the norm rather than the exception. 420 leaves the median answer fully visible.

- [ ] **Step 4: Replace the record CSS**

Replace `.knowledge-record` through `.knowledge-expandable p.is-clamped` (lines 924-1012) with:

```css
.knowledge-record {
  display: grid;
  gap: 8px;
  padding: 14px 0 14px 14px;
  border-top: 1px solid var(--border-color);
  border-left: 2px solid transparent;
}

.knowledge-record:first-of-type {
  margin-top: 8px;
}

.knowledge-record.priority-edge-critical,
.knowledge-record.priority-edge-high {
  border-left-color: var(--status-error);
}

.knowledge-record.priority-edge-medium {
  border-left-color: var(--status-warning);
}

.knowledge-record.priority-edge-low {
  border-left-color: var(--border-color);
}

.knowledge-record.change-applied {
  border-left-color: var(--status-success);
}

.knowledge-record-title {
  max-width: 62ch;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.knowledge-record-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--text-secondary);
  font-size: 11px;
}

.knowledge-priority {
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.knowledge-priority.priority-critical,
.knowledge-priority.priority-high {
  color: var(--status-error);
}

.knowledge-priority.priority-medium {
  color: var(--status-warning);
}

.knowledge-priority.priority-low {
  color: var(--text-muted);
}

.knowledge-expandable {
  display: grid;
  gap: 6px;
}

.knowledge-expandable p {
  max-width: 72ch;
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.65;
}

.knowledge-expandable p.is-clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
}

.knowledge-section-heading h3 span {
  margin-left: 6px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
}
```

The priority pill loses its border and background: at 72 of 114 findings, `high` is the common case, and a filled red badge on most records reads as noise rather than emphasis. Colour plus the left edge carries it.

- [ ] **Step 5: Verify in the browser**

1. Select the `avatar-list-vip` review.
2. Confirm the first finding is the most severe one present and that severity descends down the list.
3. Measure the reduction against the E8 baseline:

```js
const d = document.querySelector('.knowledge-review-detail');
JSON.stringify({ scrollHeight: d.scrollHeight, clientHeight: d.clientHeight })
```

Expected: materially below the 3,314px measured before this work. Record the number.

4. Confirm `Show more` no longer appears on short answers, and still appears and works on long ones.
5. `read_console_messages` — no errors. Screenshot a findings section.

- [ ] **Step 6: Commit**

```bash
git add dashboard/client/src/views/knowledge/FindingRecord.tsx dashboard/client/src/views/knowledge/ReviewDetail.tsx dashboard/client/src/styles/globals.css
git commit -m "feat(dashboard): order knowledge findings by priority and compact the record

Sorts critical first, replaces the four-column definition list with one meta
line, raises the answer clamp past the median answer length, and shows note
paths in full.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: States, responsive rules, and dead CSS

Closes E12 (a 420px empty panel), E13 (`Vip`), and the page-shell items. Removes every rule the previous four tasks orphaned.

**Files:**
- Modify: `dashboard/client/src/views/knowledge/KnowledgeReviewsView.tsx`
- Modify: `dashboard/client/src/styles/globals.css:532-1094`

**Interfaces:**
- Consumes: everything from Tasks 3-8.
- Produces: nothing new.

- [ ] **Step 1: Compact the page heading**

In `KnowledgeReviewsView.tsx`, drop the `knowledge-page-kicker` paragraph — the active nav tab already reads `Knowledge` — and put the description on the heading line:

```tsx
<div className="knowledge-page-heading">
  <div>
    <h1>Knowledge Reviews</h1>
    <p>Validated Librarian audits — read-only. Human review still required before apply.</p>
  </div>
  <div className="knowledge-page-meta">
    <div className="knowledge-stat-pill">
      <strong>{data?.total ?? 0}</strong>
      <span>valid</span>
    </div>
    {(data?.invalidCount ?? 0) > 0 && (
      <div className="knowledge-stat-pill knowledge-stat-pill-warn">
        <FileWarning size={13} />
        <strong>{data?.invalidCount}</strong>
        <span>invalid</span>
      </div>
    )}
    <button type="button" className="knowledge-refresh-button" onClick={loadReviews} disabled={loading}>
      <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
    </button>
  </div>
</div>
```

and widen the description so it stops wrapping at 52 characters:

```css
.knowledge-page-heading > div > p:last-child {
  max-width: 78ch;
  margin: 4px 0 0;
  color: var(--text-secondary);
  line-height: 1.45;
}
```

- [ ] **Step 2: Let the list panel follow its content**

Replace the fixed-height pair (lines 648-652):

```css
.knowledge-review-list,
.knowledge-review-detail {
  max-height: calc(100vh - 170px);
}

.knowledge-review-list {
  align-self: start;
}

.knowledge-review-detail {
  min-height: 0;
}
```

`min-height: 420px` is gone, so filtering to one result no longer holds an empty panel open (E12). The `calc` shrinks from 210 to 170 because Step 1 removed the kicker line.

- [ ] **Step 3: Add loading skeletons**

Replace the full-page spinner branch with rows that match the final geometry, so resolving does not change the layout height:

```tsx
if (loading && !data) {
  return (
    <div className="knowledge-page">
      <div className="knowledge-page-heading"><div><h1>Knowledge Reviews</h1></div></div>
      <div className="knowledge-layout">
        <aside className="knowledge-review-list" aria-busy="true" aria-label="Loading knowledge reviews">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="knowledge-skeleton-row" />)}
        </aside>
        <main className="knowledge-review-detail"><div className="card knowledge-skeleton-detail" /></main>
      </div>
    </div>
  );
}
```

```css
.knowledge-skeleton-row {
  height: 74px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(90deg, transparent, var(--card-bg), transparent);
  animation: knowledge-skeleton 1.4s ease-in-out infinite;
}

.knowledge-skeleton-detail {
  min-height: 320px;
  animation: knowledge-skeleton 1.4s ease-in-out infinite;
}

@keyframes knowledge-skeleton {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.8; }
}

@media (prefers-reduced-motion: reduce) {
  .knowledge-skeleton-row,
  .knowledge-skeleton-detail {
    animation: none;
  }
}
```

- [ ] **Step 4: Rebuild the responsive rules**

Replace the three knowledge media queries (lines 1053-1094) with:

```css
@media (max-width: 920px) {
  .knowledge-layout {
    grid-template-columns: 1fr;
  }

  .knowledge-review-list,
  .knowledge-review-detail {
    max-height: none;
  }

  .knowledge-review-list {
    max-height: 360px;
  }

  .knowledge-summary-card {
    position: static;
  }
}

@media (max-width: 620px) {
  .knowledge-page-heading,
  .knowledge-detail-title-row {
    flex-direction: column;
  }

  .knowledge-page-meta {
    justify-content: flex-start;
  }

  .knowledge-path-group {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
```

The 1100px query is gone: it existed only to re-grid `.knowledge-record-facts`, which Task 8 deleted. The `.knowledge-fact-grid` rules go with it. Sticky is disabled in the single-column layout, where the header would otherwise cover content.

- [ ] **Step 5: Delete the remaining orphaned rules**

Tasks 5, 6 and 7 already removed most orphans as a side effect of replacing their ranges. What survives to here is `.knowledge-page-kicker` (orphaned by Step 1 of this task) and `.knowledge-count-chip` if it was reintroduced anywhere.

Then sweep for any `.knowledge-*` selector in `globals.css` with no call site. This prints every class the stylesheet defines that no component references:

```bash
comm -23 <(grep -o 'knowledge-[a-z-]*' dashboard/client/src/styles/globals.css | sort -u) <(grep -rho 'knowledge-[a-z-]*' dashboard/client/src --include='*.tsx' | sort -u)
```

Quote the `--include` glob — unquoted, zsh expands it in the working directory and the second `grep` silently matches nothing, which makes every class look orphaned. Verified to print nothing against the tree as it stands before Task 1, so an empty result is a meaningful pass.

Expected: empty. Delete the rule for anything it lists, then re-run until it is empty. Note that `priority-*`, `status-*` and `card` are shared with other views and are out of scope for this sweep.

- [ ] **Step 6: Full verification**

```bash
npm test --prefix dashboard/server && npm test --prefix dashboard/client && npm run build --prefix dashboard/client
```

Expected: all green.

Then in the browser, at 1440x900 and again at 1280x800 and 900x800:

1. Default view: heading is one compact block, no `KNOWLEDGE BASE` kicker.
2. Filter to `avatar-list-vip`: the left panel wraps its single row with no empty space below it.
3. Detail: summary measure ≤ 72ch, findings ordered by severity, scope paths grouped, no `Review mode` tile.
4. At 900px wide the layout is single-column and the header is not sticky.
5. `read_console_messages` and `read_network_requests` — clean.
6. Capture before/after screenshots of the list column and the dense detail.

- [ ] **Step 7: Commit**

```bash
git add dashboard/client/src/views/knowledge/KnowledgeReviewsView.tsx dashboard/client/src/styles/globals.css
git commit -m "feat(dashboard): compact the knowledge page shell and drop orphaned rules

Single-line heading, content-height list panel, skeleton loading, and responsive
rules rebuilt around the components that now exist.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Traceability

| Evidence | Closed by |
|---|---|
| E1 prose at ~110 chars/line | Task 6 Step 2, Task 8 Step 4 |
| E2 product duplicated on 35/52 rows | Task 3 `shouldShowProduct`, Task 5 Step 1 |
| E3 product is not a category | Task 5 Step 1 (repos replace it) |
| E4 up to 18 paths as identical pills | Task 7 |
| E5 non-path entries in `scope.paths` | Task 3 `groupPathsByRoot`, Task 7 Step 3 |
| E6 `reviewMode` duplicates `writeMode` | Task 6 Step 1 |
| E7 priority invisible / unordered | Task 1, Task 5 Step 1, Task 8 Step 1 |
| E8 3,314px scroll with no anchor | Task 6 Step 2 (sticky), Task 8 Step 4 (density) |
| E9 clamp fires on 59% of answers | Task 8 Step 3 |
| E10 summaries to 2,690 chars | Task 6 Step 2 |
| E11 0-8 findings per review | Task 1 Step 1 (zero case tested), Task 8 Step 1 |
| E12 420px empty panel | Task 9 Step 2 |
| E13 `Vip` | Task 3 `humanizeLabel` |
| E14 projection discards findings | Task 1 |
