import React, { useEffect, useRef, useState } from 'react';

// Small in-app editor for the supervisor display name (replaces the old
// window.prompt). Extracted from CommandView so the dialog markup is no longer
// duplicated alongside DecisionDialog — both lean on the shared .dialog-* CSS.
export interface ActorDialogProps {
  value: string;
  conflict?: { prefix: string; owner: string } | null;
  onSave: (name: string) => void;
  onCancel: () => void;
}

export const ActorDialog: React.FC<ActorDialogProps> = ({ value, conflict, onSave, onCancel }) => {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  // Esc closes; stopPropagation keeps Command's task-modal Esc handler dormant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const save = () => onSave(draft.trim());

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Set your name"
        onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-title">Your name</span>
          <span className="dialog-task">used on decisions</span>
        </div>
        <div className="dialog-body">
          <input
            ref={inputRef}
            className="form-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Earth"
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
          {conflict && (
            <div className="dialog-error">
              Prefix {conflict.prefix} is registered to {conflict.owner} in office.team.yaml.
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="form-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="form-button-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
};
