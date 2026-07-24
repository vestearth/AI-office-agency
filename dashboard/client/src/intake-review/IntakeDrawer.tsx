import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Loader2, Paperclip, X } from 'lucide-react';
import { apiFetchJson } from '../api';
import { useToast } from '../components/Toast';
import { reviewApi } from './reviewApi';
import { gateOpen, claimRemainingMs } from './columns';
import type { ReviewIntakeDetail } from '../../../shared/types';

// Any action rejection whose message equals one of these reasons means the
// intake moved out from under the drawer (someone else claimed/promoted it,
// or the caller's own view was stale) — refresh instead of silently retrying.
const isConflictReason = (message: string): boolean =>
  message === 'revision_conflict' || message === 'already_claimed';

type Classification = 'triaged' | 'needs_scope_review' | 'ai_failed';

interface TriagePackageResult {
  ok: boolean;
  reason?: string;
  needsScopeReview?: boolean;
  contextHash?: string;
  repos?: string[];
}

export function IntakeDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const detailRequestRef = useRef(0);

  const [detail, setDetail] = useState<ReviewIntakeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [claimPending, setClaimPending] = useState(false);
  const [packagePending, setPackagePending] = useState(false);
  const [triagePending, setTriagePending] = useState(false);
  const [promotePending, setPromotePending] = useState(false);

  const [packageResult, setPackageResult] = useState<TriagePackageResult | null>(null);

  const [classification, setClassification] = useState<Classification>('triaged');
  const [summary, setSummary] = useState('');

  const [defaultPrefix, setDefaultPrefix] = useState('');
  const [prefix, setPrefix] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const fetchDetail = useCallback((intakeId: string) => {
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    reviewApi.getDetail(intakeId)
      .then((response) => {
        if (requestId !== detailRequestRef.current) return;
        setDetail(response);
        setDetailError(null);
      })
      .catch((err) => {
        if (requestId !== detailRequestRef.current) return;
        setDetailError(err.message);
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!id) {
      detailRequestRef.current += 1;
      setDetail(null);
      setDetailError(null);
      setPackageResult(null);
      setClassification('triaged');
      setSummary('');
      setOverrideReason('');
      return;
    }
    setPackageResult(null);
    setOverrideReason('');
    fetchDetail(id);
  }, [id, fetchDetail]);

  // Best-effort — the owner's effective TASK prefix prefills the promote
  // input, which the owner can still edit. No endpoint lists all prefixes,
  // so a select isn't viable here.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    apiFetchJson<{ taskPrefix: string | null }>('/api/identity')
      .then((response) => {
        if (cancelled) return;
        const value = response.taskPrefix ?? '';
        setDefaultPrefix(value);
        setPrefix((current) => current || value);
      })
      .catch(() => {
        // Identity lookup is best-effort; the owner can still type a prefix.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleConflict = useCallback((err: Error) => {
    if (isConflictReason(err.message)) {
      toast.show('Changed since you loaded — refreshing', 'error');
      onChanged();
      if (id) fetchDetail(id);
      return true;
    }
    return false;
  }, [toast, onChanged, id, fetchDetail]);

  const handleClaim = useCallback(() => {
    if (!id || !detail || claimPending) return;
    setClaimPending(true);
    reviewApi.claim(id, detail.revision)
      .then(() => {
        toast.show('Claimed');
        onChanged();
        fetchDetail(id);
      })
      .catch((err) => {
        if (!handleConflict(err)) toast.show(err.message, 'error');
      })
      .finally(() => setClaimPending(false));
  }, [id, detail, claimPending, toast, onChanged, fetchDetail, handleConflict]);

  const handleRelease = useCallback(() => {
    if (!id || claimPending) return;
    setClaimPending(true);
    reviewApi.release(id)
      .then(() => {
        toast.show('Released');
        onChanged();
        fetchDetail(id);
      })
      .catch((err) => {
        if (!handleConflict(err)) toast.show(err.message, 'error');
      })
      .finally(() => setClaimPending(false));
  }, [id, claimPending, toast, onChanged, fetchDetail, handleConflict]);

  const handleBuildPackage = useCallback(() => {
    if (!id || packagePending) return;
    setPackagePending(true);
    reviewApi.triagePackage(id)
      .then((response) => {
        const result = response as TriagePackageResult;
        if (!result.ok) {
          toast.show(result.reason || 'Failed to build triage package', 'error');
          return;
        }
        setPackageResult(result);
      })
      .catch((err) => {
        if (!handleConflict(err)) toast.show(err.message, 'error');
      })
      .finally(() => setPackagePending(false));
  }, [id, packagePending, toast, handleConflict]);

  const handleRecordTriage = useCallback(() => {
    if (!id || !detail || triagePending || !packageResult?.contextHash) return;
    setTriagePending(true);
    reviewApi.recordTriage(id, detail.revision, {
      schemaVersion: 'triage.v1',
      classification,
      summary,
      contextHash: packageResult.contextHash,
    })
      .then(() => {
        toast.show('Triage recorded');
        onChanged();
        fetchDetail(id);
      })
      .catch((err) => {
        if (!handleConflict(err)) toast.show(err.message, 'error');
      })
      .finally(() => setTriagePending(false));
  }, [id, detail, triagePending, packageResult, classification, summary, toast, onChanged, fetchDetail, handleConflict]);

  const handlePromote = useCallback(() => {
    if (!id || !detail || promotePending) return;
    if (!gateOpen(detail) && !overrideReason.trim()) return;
    setPromotePending(true);
    reviewApi.promote(id, detail.revision, prefix.trim(), overrideReason.trim() || undefined)
      .then((response) => {
        const { taskId } = response as { taskId: string };
        toast.show(`Promoted as ${taskId}`);
        onChanged();
        fetchDetail(id);
      })
      .catch((err) => {
        if (!handleConflict(err)) toast.show(err.message, 'error');
      })
      .finally(() => setPromotePending(false));
  }, [id, detail, promotePending, overrideReason, prefix, toast, onChanged, fetchDetail, handleConflict]);

  if (!id) return null;

  const remainingMs = detail ? claimRemainingMs(detail.activeClaim, Date.now()) : 0;
  const isClaimed = remainingMs > 0;
  const open = detail ? gateOpen(detail) : false;
  const canPromote = detail ? (open || overrideReason.trim().length > 0) : false;

  return (
    <aside className="intake-drawer" aria-label="Intake detail">
      <div className="intake-drawer-header">
        <span className="intake-drawer-kicker">Intake detail</span>
        <button type="button" className="intake-drawer-close" onClick={onClose} aria-label="Close detail">
          <X size={16} />
        </button>
      </div>

      {detailLoading && !detail ? (
        <div className="intake-drawer-state">
          <Loader2 className="animate-spin" />
          <strong>Loading intake</strong>
        </div>
      ) : detailError && !detail ? (
        <div className="intake-drawer-state state-panel-error">
          <AlertCircle />
          <strong>Could not load intake</strong>
          <span>{detailError}</span>
        </div>
      ) : detail ? (
        <div className="intake-drawer-body">
          {detailError && (
            <div className="intake-inline-error" role="alert">
              <AlertCircle size={14} /> Refresh failed; showing the last loaded detail. {detailError}
            </div>
          )}

          <div className="intake-drawer-title-row">
            <h2>{detail.title}</h2>
            <span className={`intake-gate-badge ${open ? 'gate-open' : 'gate-closed'}`}>
              {open ? 'Gate open' : 'Gate closed'}
            </span>
          </div>

          <div className="intake-drawer-meta">
            <span className="intake-meta-chip">{detail.severity ?? 'unspecified'}</span>
            <span className="intake-meta-chip">{detail.state}</span>
            {detail.productHint && <span className="intake-meta-chip">{detail.productHint}</span>}
            {isClaimed && detail.activeClaim && (
              <span className="intake-claim-badge">
                claimed by {detail.activeClaim.owner} · {Math.ceil(remainingMs / 60_000)}m left
              </span>
            )}
          </div>

          <section className="intake-drawer-section">
            <h3>Body</h3>
            <p className="intake-drawer-text">{detail.body}</p>
          </section>

          <FieldBlock label="Repro steps" value={detail.reproSteps} />
          <FieldBlock label="Expected" value={detail.expected} />
          <FieldBlock label="Actual" value={detail.actual} />
          <FieldBlock label="Environment" value={detail.environment} />

          <section className="intake-drawer-section">
            <h3>Attachments</h3>
            {detail.attachments.length === 0 ? (
              <span className="intake-drawer-empty">None</span>
            ) : (
              <ul className="intake-attachment-list">
                {detail.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <Paperclip size={12} /> {attachment.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="intake-drawer-section">
            <h3>Latest triage</h3>
            {detail.latestTriage ? (
              <pre className="intake-triage-pre">{JSON.stringify(detail.latestTriage, null, 2)}</pre>
            ) : (
              <span className="intake-drawer-empty">No triage recorded yet.</span>
            )}
          </section>

          <section className="intake-drawer-section intake-drawer-actions">
            <h3>Claim</h3>
            <div className="intake-action-row">
              {isClaimed ? (
                <button type="button" className="intake-action-button" onClick={handleRelease} disabled={claimPending}>
                  {claimPending ? <Loader2 size={14} className="animate-spin" /> : null} Release
                </button>
              ) : (
                <button type="button" className="intake-action-button" onClick={handleClaim} disabled={claimPending}>
                  {claimPending ? <Loader2 size={14} className="animate-spin" /> : null} Claim
                </button>
              )}
            </div>
          </section>

          <section className="intake-drawer-section intake-drawer-actions">
            <h3>Triage package</h3>
            <div className="intake-action-row">
              <button type="button" className="intake-action-button" onClick={handleBuildPackage} disabled={packagePending}>
                {packagePending ? <Loader2 size={14} className="animate-spin" /> : null} Build triage package
              </button>
            </div>
            {packageResult?.needsScopeReview && (
              <div className="intake-inline-warning" role="alert">
                <AlertCircle size={14} /> Needs scope review — package could not be built automatically.
              </div>
            )}
            {packageResult?.contextHash && (
              <div className="intake-package-summary">
                <span>contextHash: <code>{packageResult.contextHash}</code></span>
                {packageResult.repos && packageResult.repos.length > 0 && (
                  <span>repos: {packageResult.repos.join(', ')}</span>
                )}
              </div>
            )}
          </section>

          <section className="intake-drawer-section intake-drawer-actions">
            <h3>Record triage</h3>
            <label className="intake-field-label" htmlFor="intake-drawer-classification">Classification</label>
            <div className="intake-select-shell">
              <select
                id="intake-drawer-classification"
                className="intake-select"
                value={classification}
                onChange={(event) => setClassification(event.target.value as Classification)}
              >
                <option value="triaged">triaged</option>
                <option value="needs_scope_review">needs_scope_review</option>
                <option value="ai_failed">ai_failed</option>
              </select>
              <ChevronDown size={14} className="intake-select-chevron" aria-hidden="true" />
            </div>
            <label className="intake-field-label" htmlFor="intake-drawer-summary">Summary</label>
            <textarea
              id="intake-drawer-summary"
              className="intake-textarea"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={3}
            />
            {!packageResult?.contextHash && (
              <span className="intake-field-hint">Build the triage package first to get a contextHash.</span>
            )}
            <div className="intake-action-row">
              <button
                type="button"
                className="intake-action-button"
                onClick={handleRecordTriage}
                disabled={triagePending || !packageResult?.contextHash}
              >
                {triagePending ? <Loader2 size={14} className="animate-spin" /> : null} Record triage
              </button>
            </div>
          </section>

          <section className="intake-drawer-section intake-drawer-actions">
            <h3>Promote</h3>
            <label className="intake-field-label" htmlFor="intake-drawer-prefix">TASK prefix</label>
            <input
              id="intake-drawer-prefix"
              className="intake-text-input"
              type="text"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder={defaultPrefix || 'PREFIX'}
            />
            {!open && (
              <>
                <label className="intake-field-label" htmlFor="intake-drawer-override">Override reason (gate closed)</label>
                <input
                  id="intake-drawer-override"
                  className="intake-text-input"
                  type="text"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="Required to promote while the gate is closed"
                />
              </>
            )}
            <div className="intake-action-row">
              <button
                type="button"
                className="intake-action-button intake-action-primary"
                onClick={handlePromote}
                disabled={promotePending || !canPromote}
              >
                {promotePending ? <Loader2 size={14} className="animate-spin" /> : null} Promote
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function FieldBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <section className="intake-drawer-section">
      <h3>{label}</h3>
      {value ? <p className="intake-drawer-text">{value}</p> : <span className="intake-drawer-empty">None</span>}
    </section>
  );
}
