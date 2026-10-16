import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileWarning } from 'lucide-react';
import type { KnowledgeVaultChanges } from '../../../../shared/types';
import { apiFetchJson } from '../../api';
import { useToast } from '../../components/Toast';
import { formatReviewDate } from './format';

// Knowledge › Vault changes: uncommitted knowledge-base notes, each with the audit edits
// that explain it. "No audit" marks an edit nothing records (a re-check killed mid-run
// left three on 2026-10-16). Read-only: nothing here reverts or commits.
export function VaultChangesPanel({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<KnowledgeVaultChanges | null>(null);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  useEffect(() => {
    apiFetchJson<KnowledgeVaultChanges>('/api/knowledge-reviews/vault-changes').then(setData).catch(() => setData(null));
  }, [refreshKey]);
  if (!data || data.notes.length === 0) return null;
  const reviewedOnly = data.notes.filter((n) => n.applied.length === 0 && n.reviewedBy.length > 0).length;
  const quote = (p: string) => `"${p.replace(/"/g, '\\"')}"`;
  const copyDiff = async (notePath: string) => {
    const command = `git -C knowledge-base diff -- ${quote(notePath)}`;
    try { await navigator.clipboard.writeText(command); toast.show('Diff command copied'); }
    catch { toast.show(command, 'error'); }
  };
  return (
    <section className={`knowledge-vault ${data.unrecorded ? 'has-unrecorded' : ''}`} aria-label="Uncommitted vault changes">
      <button type="button" className="knowledge-vault-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span><strong>{data.notes.length}</strong> vault note{data.notes.length === 1 ? '' : 's'} changed since the last commit{data.lastCommitAt ? ` (${formatReviewDate(data.lastCommitAt)})` : ''}</span>
        {data.unrecorded > 0 && <span className="knowledge-vault-warn"><FileWarning size={13} /> {data.unrecorded} not recorded by any audit</span>}
        {reviewedOnly > 0 && <span className="knowledge-open-muted">{reviewedOnly} reviewed with no change recorded</span>}
        <span className="knowledge-open-muted">review before committing knowledge-base</span>
      </button>
      {open && (
        <ul className="knowledge-vault-list">
          {data.notes.map((n) => (
            <li key={n.path} className={n.applied.length || n.reviewedBy.length ? '' : 'unrecorded'}>
              <div className="knowledge-vault-note">
                <code>{n.status}</code>
                <span title={n.path}>{n.path.replace(/^Knowledge Base\//, '')}</span>
                {n.applied.length === 0 && n.reviewedBy.length === 0 && <span className="knowledge-vault-badge">no audit</span>}
                {n.applied.length === 0 && n.reviewedBy.length > 0 && (
                  <span className="knowledge-vault-reviewed" title="An audit lists this note in notes_reviewed but records no change for it (for example a weekly report entry written by its own run)">
                    reviewed by {n.reviewedBy.map((f) => f.slice(0, 16)).join(', ')}, no change recorded
                  </span>
                )}
                <button type="button" className="knowledge-vault-copy" title={`git -C knowledge-base diff -- ${quote(n.path)}`} onClick={() => copyDiff(n.path)}>copy diff</button>
              </div>
              {n.applied.length > 0 && (
                <ul>
                  {n.applied.map((a, i) => <li key={`${a.reviewFile}-${i}`}><span className="knowledge-open-muted">{a.reviewFile.slice(0, 16)}</span> {a.summary || a.fingerprint}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
