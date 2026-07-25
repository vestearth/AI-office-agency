export function ScopePaths({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div className="knowledge-paths-block">
      <span className="knowledge-paths-label">Scope paths</span>
      <div className="knowledge-paths">
        {paths.map((scopePath) => (
          <code key={scopePath} title={scopePath}>{shortPath(scopePath)}</code>
        ))}
      </div>
    </div>
  );
}

function shortPath(value: string): string {
  const parts = value.split('/');
  if (parts.length <= 3) return value;
  return `…/${parts.slice(-3).join('/')}`;
}
