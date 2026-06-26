import React, { useEffect, useState } from 'react';
import { AlertCircle, FileText, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import type { AnalyticsResponse } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';

export function ReportsView() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = () => {
    setLoading(true);
    setError(null);
    apiFetchJson<AnalyticsResponse>('/api/analytics')
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReport();
  }, []);

  useDashboardRefresh(fetchReport);

  if (loading && !data) {
    return (
      <div>
        <h1 style={{ marginBottom: '24px' }}>Reports</h1>
        <div className="card" style={{ minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 className="animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 style={{ marginBottom: '24px' }}>Reports</h1>
        <div className="card" style={{ border: '1px solid var(--status-error)' }}>
          <div className="card-title" style={{ color: 'var(--status-error)' }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            Error loading report snapshot
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const topFailure = data.topFailureReasons[0];
  const totalTrendRuns = data.trends.reduce((sum, point) => sum + point.total, 0);
  const peakTrendDay = data.trends.length
    ? data.trends.reduce((peak, point) => (point.total > peak.total ? point : peak), data.trends[0])
    : null;

  return (
    <div>
      <h1 style={{ marginBottom: '24px' }}>Reports</h1>
      <div className="card" style={{ marginBottom: '24px' }}>
        <div className="card-title">
          <FileText size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
          Analytics Snapshot
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '18px' }}>
          Generated {new Date(data.generatedAt).toLocaleString()} from the last {data.windowDays} days.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '16px' }}>
          <MetricCard label="Total Runs" value={data.summary.totalRuns} />
          <MetricCard label="Success Rate" value={`${(data.summary.successRate * 100).toFixed(1)}%`} />
          <MetricCard label="Health Score" value={data.summary.healthScore.score} tone={data.summary.healthScore.status} />
          <MetricCard label="Failure Reasons" value={data.topFailureReasons.length} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '24px' }}>
        <div className="card">
          <div className="card-title">
            <TrendingUp size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            Throughput Summary
          </div>
          <div style={{ display: 'grid', gap: '14px', fontSize: '14px' }}>
            <ReportLine label="Runs observed in trend window" value={String(totalTrendRuns)} />
            <ReportLine label="Peak day" value={peakTrendDay ? `${peakTrendDay.date} (${peakTrendDay.total} runs)` : '—'} />
            <ReportLine label="Completed vs failed" value={`${data.summary.completedRuns} / ${data.summary.failedRuns}`} />
            <ReportLine label="Blocked runs" value={String(data.summary.blockedRuns)} />
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <TrendingDown size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            Risk Summary
          </div>
          <div style={{ display: 'grid', gap: '14px', fontSize: '14px' }}>
            <ReportLine
              label="Top failure reason"
              value={topFailure ? `${topFailure.reason} (${topFailure.count})` : 'No failure clusters recorded'}
            />
            <ReportLine label="Failure rate" value={`${(data.summary.failureRate * 100).toFixed(1)}%`} />
            <ReportLine label="Blocked rate" value={`${(data.summary.blockedRate * 100).toFixed(1)}%`} />
            <ReportLine
              label="Most recent failure signal"
              value={topFailure?.latestSeenAt ? new Date(topFailure.latestSeenAt).toLocaleString() : 'None'}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'warning' | 'error' | 'neutral';
}) {
  const color =
    tone === 'ok'
      ? 'var(--status-success)'
      : tone === 'warning'
        ? 'var(--status-warning)'
        : tone === 'error'
          ? 'var(--status-error)'
          : 'var(--text-primary)';

  return (
    <div style={{ padding: '16px', borderRadius: '10px', backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: '26px', fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function ReportLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <strong style={{ textAlign: 'right' }}>{value}</strong>
    </div>
  );
}
