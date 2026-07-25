import { useState } from 'react';
import { groupPathsByRoot } from './format';

const COLLAPSED_GROUP_LIMIT = 3;

export function ScopePaths({ paths }: { paths: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (paths.length === 0) return null;
  const groups = groupPathsByRoot(paths);
  const collapsible = paths.length > 6;
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
