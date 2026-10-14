import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileSearch, Loader2, MonitorSmartphone, PlugZap, ServerCog } from 'lucide-react';
import type { ProjectReadinessResponse, ReadinessEvidenceTask, ReadinessLaneReport, RunStatus } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { useDashboardRefresh } from '../hooks/useDashboardRefresh';

// Evidence rows reuse RunStatus as the wire enum, but they describe wiring, not
// task state: say what the evidence means instead of borrowing "blocked".
const WIRING_LABEL: Partial<Record<RunStatus, { label: string; tone: string }>> = {
  completed: { label: 'Connected', tone: 'status-completed' },
  running: { label: 'Partial', tone: 'status-running' },
  waiting_review: { label: 'Review', tone: 'status-blocked' },
  blocked: { label: 'Gap', tone: 'status-failed' },
  failed: { label: 'Gap', tone: 'status-failed' },
};

// The API lanes put the same path in id, source and matchedKeywords; show each fact once.
export function evidenceDetails(task: ReadinessEvidenceTask): { source: string | null; keywords: string[] } {
  const source = task.source && task.source !== task.id ? task.source : null;
  const keywords = task.matchedKeywords.filter((k) => k !== task.id && k !== task.source);
  return { source, keywords };
}

const LANE_ICONS: Record<ReadinessLaneReport['id'], React.ElementType> = {
  'api-backoffice': ServerCog,
  'backoffice-ui': PlugZap,
  'mobile-fe-api': MonitorSmartphone,
};

export function ReportsView() {
  const [data, setData] = useState<ProjectReadinessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = () => {
    setLoading(true);
    setError(null);
    apiFetchJson<ProjectReadinessResponse>('/api/reports/readiness')
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
        <h1 style={{ marginBottom: '24px' }}>Readiness</h1>
        <div className="card" style={{ minHeight: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 className="animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 style={{ marginBottom: '24px' }}>Readiness</h1>
        <div className="card state-panel-error">
          <div className="card-title" style={{ color: 'var(--status-error)' }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            Error loading project readiness
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      <h1 style={{ marginBottom: '24px' }}>Readiness</h1>
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '16px', marginBottom: '14px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '20px' }}>Project Readiness</h2>
            <div style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>
              Evidence-based progress from repository source wiring.
            </div>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px', whiteSpace: 'nowrap' }}>
            Generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </div>

        <div style={{ display: 'grid', gap: '16px' }}>
          {data.projects.map((project) => (
            <div key={project.id} className="card">
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '18px', marginBottom: '18px' }}>
                <div>
                  <div className="card-title" style={{ marginBottom: '6px' }}>{project.name}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
                    Readiness means UI is ready to connect, Backoffice APIs can save/read real settings, and Mobile/FE can consume synced values.
                  </div>
                </div>
                <div style={{ minWidth: '128px', textAlign: 'right' }}>
                  <div style={{ fontSize: '30px', fontWeight: 800, color: toneColor(project.status) }}>{project.progress}%</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Overall</div>
                </div>
              </div>

              <ProgressBar value={project.progress} color={toneColor(project.status)} />

              <div className="reports-evidence-row">
                <span><FileSearch size={13} /> {project.evidence.totalMatchedTasks} evidence items</span>
                <span>{project.evidence.scoring}</span>
              </div>

              <div className="reports-readiness-lanes">
                {project.lanes.map((lane) => (
                  <ReadinessLaneCard key={lane.id} lane={lane} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReadinessLaneCard({ lane }: { lane: ReadinessLaneReport }) {
  const Icon = LANE_ICONS[lane.id];
  const color = toneColor(lane.status);

  return (
    <div style={{ padding: '16px', borderRadius: '8px', backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <Icon size={16} color={color} />
          <strong style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.label}</strong>
        </div>
        <strong style={{ color }}>{lane.progress}%</strong>
      </div>

      <ProgressBar value={lane.progress} color={color} />

      <p style={{ margin: '12px 0 10px', color: 'var(--text-primary)', fontSize: '13px', lineHeight: 1.5 }}>{lane.summary}</p>
      <ReportLine label="Ready when" value={lane.readyDefinition} />
      <div className="reports-count-grid">
        <CountPill label="Ready" value={lane.evidence.completedTasks} tone="success" />
        <CountPill label="Review" value={lane.evidence.reviewTasks} tone="warning" />
        <CountPill label="Partial" value={lane.evidence.activeTasks} tone="running" />
        <CountPill label="Gaps" value={lane.evidence.blockedTasks + lane.evidence.failedTasks} tone="error" />
      </div>

      <div style={{ marginTop: '14px' }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
          Evidence
        </div>
        {lane.evidence.sampleTasks.length > 0 ? (
          <div style={{ display: 'grid', gap: '8px' }}>
            {lane.evidence.sampleTasks.map((task) => {
              const wiring = WIRING_LABEL[task.status] ?? { label: task.status, tone: 'status-unknown' };
              const { source, keywords } = evidenceDetails(task);
              return (
                <div key={task.id} style={{ borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
                    <strong style={{ fontSize: '12px', overflowWrap: 'anywhere' }}>{task.id}</strong>
                    <span className={`status-badge ${wiring.tone}`}>{wiring.label}</span>
                  </div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '12px', lineHeight: 1.35 }}>{task.title}</div>
                  {source && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--text-secondary)', fontSize: '11px', marginTop: '5px', minWidth: 0 }}>
                      <FileSearch size={11} />
                      <span style={{ overflowWrap: 'anywhere' }}>Source: {source}</span>
                    </div>
                  )}
                  {keywords.length > 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '5px', overflowWrap: 'anywhere' }}>
                      {keywords.join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '12px' }}>
            <CheckCircle2 size={13} />
            No task evidence matched this lane yet.
          </div>
        )}
      </div>
    </div>
  );
}

function CountPill({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warning' | 'running' | 'error' }) {
  const color =
    tone === 'success'
      ? 'var(--status-success)'
      : tone === 'warning'
        ? 'var(--status-warning)'
        : tone === 'running'
          ? 'var(--status-running)'
          : 'var(--status-error)';

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px', minWidth: 0 }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ color, fontSize: '16px', fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: '10px', borderRadius: '999px', backgroundColor: 'var(--bg-color)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(value, 100))}%`, height: '100%', backgroundColor: color }} />
    </div>
  );
}

function ReportLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px', minWidth: 0 }}>
      <span style={{ color: 'var(--text-secondary)', flex: '0 0 auto' }}>{label}</span>
      <strong style={{ textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</strong>
    </div>
  );
}

function toneColor(status: 'on-track' | 'attention' | 'blocked') {
  if (status === 'on-track') return 'var(--status-success)';
  if (status === 'attention') return 'var(--status-warning)';
  return 'var(--status-error)';
}
