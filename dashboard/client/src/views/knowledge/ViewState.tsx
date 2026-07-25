import { CheckCircle2 } from 'lucide-react';

export function ViewState({ icon, title, detail, error = false }: { icon: React.ReactNode; title: string; detail?: string; error?: boolean }) {
  return (
    <div className={`card knowledge-view-state ${error ? 'state-panel-error' : ''}`}>
      {icon}
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

export function EmptyLine({ label }: { label: string }) {
  return <div className="knowledge-empty-line"><CheckCircle2 size={14} /> {label}</div>;
}
