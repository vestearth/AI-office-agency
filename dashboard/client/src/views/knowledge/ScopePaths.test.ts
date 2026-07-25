import { describe, test, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { budgetGroups, ScopePaths } from './ScopePaths';
import type { ScopePathGroup } from './format';

const group = (root: string, count: number): ScopePathGroup => ({
  root,
  paths: Array.from({ length: count }, (_, index) => `${root}/file${index}.ts`),
});

describe('budgetGroups', () => {
  test('includes every group when the total already fits the budget', () => {
    // Regression shape: 7-10 total paths across multiple groups, budget 10.
    // budgetGroups is a no-op here, so the caller cannot infer collapsibility
    // from the path count alone — it has to compare against this output.
    const groups = [group('a', 4), group('b', 3), group('c', 2)];
    expect(budgetGroups(groups, 10)).toEqual(groups);
  });

  test('excludes trailing groups once the running total would exceed budget', () => {
    const groups = [group('a', 4), group('b', 3), group('c', 3), group('d', 1)];
    expect(budgetGroups(groups, 10)).toEqual([group('a', 4), group('b', 3), group('c', 3)]);
  });

  test('always includes the first group in full, even alone over budget', () => {
    expect(budgetGroups([group('a', 9), group('b', 2)], 6)).toEqual([group('a', 9)]);
  });

  test('never truncates a group internally so count badges match rendered paths', () => {
    const groups = [group('a', 4), group('b', 3)];
    for (const budgeted of budgetGroups(groups, 10)) {
      const original = groups.find((candidate) => candidate.root === budgeted.root);
      expect(budgeted.paths.length).toBe(original?.paths.length);
    }
  });
});

// The collapse toggle must never render unless budgeting actually excludes a
// group. Deriving that from anything other than budgetGroups's own output —
// a path-count threshold, say — produced a dead button twice in a row.
describe('the collapsible invariant', () => {
  test('a path-count threshold decoupled from the budget is not evidence of collapsibility', () => {
    const groups = [group('a', 4), group('b', 3), group('c', 2)];
    const budgeted = budgetGroups(groups, 10);
    const collapsible = budgeted.length < groups.length;

    const totalPaths = groups.reduce((sum, entry) => sum + entry.paths.length, 0);
    expect(totalPaths).toBeGreaterThan(6); // a naive `paths.length > 6` trigger fires here
    expect(collapsible).toBe(false); // yet nothing is excluded, so no button may render
  });

  test('is true exactly when budgeting drops a group', () => {
    const fits = [group('a', 4), group('b', 3), group('c', 2)];
    expect(budgetGroups(fits, 10).length < fits.length).toBe(false);

    const overflows = [group('a', 6), group('b', 5), group('c', 2)];
    expect(budgetGroups(overflows, 10).length < overflows.length).toBe(true);
  });
});

// Rendered assertions: the checks above all hold against the regressed version
// too, because they recompute the invariant rather than observing the component.
// These render ScopePaths in its collapsed (initial) state instead, which is the
// only place the dead button was ever visible.
const renderPaths = (paths: string[]) => renderToStaticMarkup(createElement(ScopePaths, { paths }));

describe('ScopePaths collapsed rendering', () => {
  test('renders no toggle when budgeting excludes nothing', () => {
    // Mirrors KLR-...-missions-auth-warning-triage: 7 paths across 2 groups.
    const markup = renderPaths([
      'games-labs-backoffice/src/a.ts', 'games-labs-backoffice/src/b.ts',
      'games-labs-backoffice/src/c.ts', 'games-labs-backoffice/src/d.ts',
      'games-labs-backoffice/src/e.ts', 'api-gateway/main.go', 'api-gateway/auth.go',
    ]);
    expect(markup).not.toContain('knowledge-expand-button');
    expect(markup).not.toContain('Show all');
  });

  test('renders no toggle for a many-group review that still fits the budget', () => {
    // Mirrors KLR-...-vip-profile-display-contract: 8 paths across 6 groups.
    const markup = renderPaths([
      'a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts',
      'c/one.ts', 'd/one.ts', 'e/one.ts', 'f/one.ts',
    ]);
    expect(markup).not.toContain('knowledge-expand-button');
  });

  test('renders the toggle when budgeting does exclude a group', () => {
    const markup = renderPaths([
      'a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts', 'a/5.ts', 'a/6.ts',
      'b/1.ts', 'b/2.ts', 'b/3.ts', 'b/4.ts', 'b/5.ts', 'c/1.ts', 'c/2.ts',
    ]);
    expect(markup).toContain('knowledge-expand-button');
    expect(markup).toContain('Show all 13 paths');
  });
});
