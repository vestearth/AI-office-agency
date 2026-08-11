import React, { useCallback, useEffect, useState } from 'react';

// Mirrors the server's tester projection (TesterIntake in
// server/src/intake/testerProjection.ts) EXACTLY — no `state`, `tester_id`,
// triage, or TASK id fields exist there, so none are declared or rendered
// here. `displayStatus` is rendered verbatim; this component holds no
// state→label mapping of its own.
interface TesterIntake {
  id: string;
  title: string;
  productHint: string | null;
  body: string;
  severity: string | null;
  reproSteps: string | null;
  expected: string | null;
  actual: string | null;
  environment: string | null;
  createdAt: number;
  displayStatus: string;
}

interface MyIntakesApi {
  listIntakes: () => Promise<TesterIntake[]>;
}

interface MyIntakesProps {
  api: MyIntakesApi;
  refreshToken: number;
}

export function MyIntakes({ api, refreshToken }: MyIntakesProps) {
  const [intakes, setIntakes] = useState<TesterIntake[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.listIntakes()
      .then((list) => {
        setIntakes(list);
        setSelectedId((current) => (current && list.some((i) => i.id === current) ? current : list[0]?.id ?? null));
      })
      .catch(() => setError('Could not load your intakes.'))
      .finally(() => setLoading(false));
  }, [api]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, refreshToken]);

  const selected = intakes.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="intake-card intake-my-intakes">
      <div className="intake-section-heading intake-history-heading">
        <div>
          <span className="intake-section-kicker">History</span>
          <h2 className="intake-form-title">My intakes</h2>
          <p>Track previous reports and review exactly what you submitted.</p>
        </div>
        {!loading && !error && (
          <span className="intake-count" aria-label={`${intakes.length} submitted intakes`}>
            {intakes.length}
          </span>
        )}
      </div>
      {loading && <div className="view-state">Loading…</div>}
      {error && <div className="dialog-error" role="alert">{error}</div>}
      {!loading && !error && intakes.length === 0 && (
        <div className="intake-empty">You haven't submitted anything yet.</div>
      )}
      {!loading && !error && intakes.length > 0 && (
        <div className="intake-my-intakes-layout">
          <ul className="intake-intake-list">
            {intakes.map((intake) => (
              <li key={intake.id}>
                <button
                  type="button"
                  className={`intake-intake-item${intake.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(intake.id)}
                >
                  <div className="intake-intake-item-title">{intake.title}</div>
                  <div className="intake-intake-item-meta">
                    <span>{intake.productHint || 'Other / not sure'}</span>
                    <time>{formatDate(intake.createdAt)}</time>
                  </div>
                  <span className="intake-status-chip">{intake.displayStatus}</span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="intake-intake-detail">
              <div className="intake-intake-detail-header">
                <h3>{selected.title}</h3>
                <span className="intake-status-chip">{selected.displayStatus}</span>
              </div>
              <dl className="intake-detail-facts">
                <div><dt>Product</dt><dd>{selected.productHint || 'Other / not sure'}</dd></div>
                {selected.severity && <div><dt>Severity</dt><dd>{selected.severity}</dd></div>}
                <div><dt>Submitted</dt><dd>{formatDate(selected.createdAt)}</dd></div>
              </dl>
              <div className="intake-detail-section">
                <h4>Description</h4>
                <p>{selected.body}</p>
              </div>
              {selected.reproSteps && (
                <div className="intake-detail-section">
                  <h4>Steps to reproduce</h4>
                  <p>{selected.reproSteps}</p>
                </div>
              )}
              {selected.expected && (
                <div className="intake-detail-section">
                  <h4>Expected</h4>
                  <p>{selected.expected}</p>
                </div>
              )}
              {selected.actual && (
                <div className="intake-detail-section">
                  <h4>Actual</h4>
                  <p>{selected.actual}</p>
                </div>
              )}
              {selected.environment && (
                <div className="intake-detail-section">
                  <h4>Environment</h4>
                  <p>{selected.environment}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
