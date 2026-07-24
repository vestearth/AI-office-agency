import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Inbox, Loader2 } from 'lucide-react';
import '../intake-review/board.css';
import { reviewApi } from '../intake-review/reviewApi';
import { COLUMNS, groupIntoColumns } from '../intake-review/columns';
import { IntakeDrawer } from '../intake-review/IntakeDrawer';
import type { ReviewIntakeSummary } from '../../../shared/types';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';

export function IntakeView() {
  const [intakes, setIntakes] = useState<ReviewIntakeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    reviewApi.listIntakes()
      .then((response) => {
        setIntakes(response.intakes);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);
  useDashboardRefresh(load);

  const grouped = groupIntoColumns(intakes);

  if (loading && intakes.length === 0) {
    return (
      <div className="card intake-view-state">
        <Loader2 className="animate-spin" />
        <strong>Loading intakes</strong>
      </div>
    );
  }

  if (error && intakes.length === 0) {
    return (
      <div className="card intake-view-state state-panel-error">
        <AlertCircle />
        <strong>Intake board unavailable</strong>
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="intake-page">
      <div className="intake-page-heading">
        <div>
          <p className="intake-page-kicker">Owner review</p>
          <h1>Intake</h1>
          <p>Submitted intakes moving through triage and promotion — read-only board.</p>
        </div>
      </div>

      {error && intakes.length > 0 && (
        <div className="intake-inline-error" role="alert">
          <AlertCircle size={14} /> Refresh failed; showing the last loaded intakes. {error}
        </div>
      )}

      {intakes.length === 0 ? (
        <div className="card intake-view-state">
          <Inbox />
          <strong>No intakes yet</strong>
          <span>Submitted intakes will appear here.</span>
        </div>
      ) : (
        <div className="intake-board">
          {COLUMNS.map((col) => (
            <div key={col.id} className="intake-col">
              <div className="intake-col-heading">
                <span>{col.label}</span>
                <span className="intake-col-count">{grouped[col.id].length}</span>
              </div>
              <div className="intake-col-scroll">
                {grouped[col.id].length === 0 ? (
                  <div className="intake-col-empty">No intakes</div>
                ) : (
                  grouped[col.id].map((intake) => (
                    <IntakeCard
                      key={intake.id}
                      intake={intake}
                      selected={intake.id === selectedId}
                      onSelect={setSelectedId}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <IntakeDrawer id={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
    </div>
  );
}

function IntakeCard({
  intake,
  selected,
  onSelect,
}: {
  intake: ReviewIntakeSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`intake-card ${selected ? 'active' : ''}`}
      onClick={() => onSelect(intake.id)}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="intake-card-top">
        <span className={`intake-severity-dot ${severityClass(intake.severity)}`} aria-hidden="true" />
        <strong className="intake-card-title">{intake.title}</strong>
      </div>
      <div className="intake-card-footer">
        <time>{formatRelativeTime(intake.createdAt)}</time>
        {intake.claim && (
          <span className="intake-claim-badge">claimed by {intake.claim.owner}</span>
        )}
      </div>
    </button>
  );
}

function severityClass(severity: string | null): string {
  if (severity === 'high' || severity === 'blocker') return 'severity-high';
  return 'severity-muted';
}

function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 14) return `${elapsedDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
