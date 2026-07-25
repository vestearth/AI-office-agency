import { useState } from 'react';
import { groupPathsByRoot, type ScopePathGroup } from './format';

const COLLAPSED_PATH_BUDGET = 10;

// Budgets whole groups by total path count rather than truncating a group's own
// list — a group's count badge must always match what's actually rendered under
// it, so a group that would push the running total over budget is excluded
// entirely rather than clipped. Always includes at least the first group in
// full, even if that group alone exceeds the budget: there's nothing sensible
// to partially hide within a single group.
function budgetGroups(groups: ScopePathGroup[], budget: number): ScopePathGroup[] {
  const result: ScopePathGroup[] = [];
  let used = 0;
  for (const group of groups) {
    if (result.length > 0 && used + group.paths.length > budget) break;
    result.push(group);
    used += group.paths.length;
    if (used >= budget) break;
  }
  return result;
}

export function ScopePaths({ paths }: { paths: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (paths.length === 0) return null;
  const groups = groupPathsByRoot(paths);
  const collapsible = paths.length > 6;
  const visible = expanded || !collapsible ? groups : budgetGroups(groups, COLLAPSED_PATH_BUDGET);

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
