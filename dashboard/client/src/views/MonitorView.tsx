import React from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertCircle, Terminal, Loader2, LayoutDashboard, Network, ChevronDown } from 'lucide-react';
import type { HealthStatus, RunDetail } from '../../../shared/types';
import { agentGlyph, KIND_COLOR } from './agentDisplay';

export interface MonitorViewProps {
  loading: boolean;
  health: HealthStatus | null;
  healthAccent: string;
  selectedRunId: string | null;
  runDetail: RunDetail | null;
  runDetailLoading: boolean;
  runDetailError: string | null;
  selectedLogFile: string;
  logContent: string | null;
  logError: string | null;
  onSelectLogFile: (fileName: string) => void;
}

export function MonitorView({
  loading,
  health,
  healthAccent,
  selectedRunId,
  runDetail,
  runDetailLoading,
  runDetailError,
  selectedLogFile,
  logContent,
  logError,
  onSelectLogFile,
}: MonitorViewProps) {
  const healthHeadline =
    health?.status === 'warning'
      ? 'Dashboard health warning'
      : health?.status === 'error'
        ? 'Dashboard health degraded'
        : 'Dashboard health';
  const healthSummary =
    health?.status === 'warning'
      ? 'The monitor is still available, but one or more file-system dependencies need attention.'
      : health?.status === 'error'
        ? 'The monitor may not reflect current run state until the underlying dashboard wiring is restored.'
        : 'Dashboard API, file watcher, and runtime diagnostics are reporting normally.';
  const socraticodeLabel =
    !health?.socraticode
      ? 'not checked'
      : health.socraticode.backend === 'none'
        ? health.socraticode.status
        : `${health.socraticode.status} via ${health.socraticode.backend}`;
  const socraticodeDetail =
    health?.socraticode?.projectPath || health?.socraticode?.message || 'No project path reported';

  return (
    <div>
      {!health && !loading && (
        <div className="card state-panel state-panel-error" style={{ marginBottom: '24px' }}>
          <AlertCircle size={44} className="state-panel-icon" />
          <div className="state-panel-body">
            <div className="state-panel-eyebrow">Connection Issue</div>
            <h2 className="state-panel-title">Backend server offline</h2>
            <p className="state-panel-copy">Cannot connect to the dashboard API. Please ensure the server is running on port 4310.</p>
          </div>
        </div>
      )}

      {health && (
        <div className="card health-banner" style={{ marginBottom: '24px', borderColor: healthAccent }}>
          <div className="health-banner-header">
            <div className="health-banner-title-row">
              <AlertCircle size={15} style={{ color: healthAccent }} />
              <div className="health-banner-title" style={{ color: healthAccent }}>
                {healthHeadline}
              </div>
            </div>
            <span className="health-banner-chip" style={{ color: healthAccent, borderColor: healthAccent }}>
              {health.status}
            </span>
          </div>
          <p className="health-banner-summary">
            {healthSummary}
          </p>
          <div className="health-banner-facts">
            <span>Runs directory: {health.runsDirExists ? 'available' : 'missing'}</span>
            <span>Logs directory: {health.logsDirExists ? 'available' : 'missing'}</span>
            <span>Watcher: {health.watcherActive ? 'active' : 'inactive'}</span>
          </div>
          <div className="health-banner-runtime">
            <Network size={14} />
            <span>SocratiCode: {socraticodeLabel}</span>
            <span className="health-banner-runtime-detail">{socraticodeDetail}</span>
          </div>
        </div>
      )}

      {selectedRunId ? (
        runDetailLoading ? (
          <div className="card state-panel state-panel-neutral">
            <Loader2 className="animate-spin state-panel-icon" size={40} />
            <div className="state-panel-body">
              <div className="state-panel-eyebrow">Loading Run</div>
              <h3 className="state-panel-title">Fetching the latest run details</h3>
              <p className="state-panel-copy">The monitor is syncing task details, artifacts, and log availability for the selected run.</p>
            </div>
          </div>
        ) : runDetailError ? (
          <div className="card state-panel state-panel-neutral">
            <AlertCircle size={40} className="state-panel-icon" style={{ color: 'var(--status-error)' }} />
            <div className="state-panel-body">
              <div className="state-panel-eyebrow">Run Unavailable</div>
              <h3 className="state-panel-title">{runDetailError}</h3>
              <p className="state-panel-copy">Choose another run from the sidebar to continue inspecting current task state.</p>
            </div>
          </div>
        ) : runDetail ? (
          <div>
            <div className="monitor-run-header">
              <div className="monitor-run-heading">
                <div className="monitor-run-kicker">Selected Run</div>
                <h1 className="monitor-run-title">{runDetail.id}: {runDetail.title}</h1>
                <div className="monitor-run-meta">
                  <span>Path: {runDetail.runPath}</span>
                  <span>Updated: {runDetail.updatedAt ? new Date(runDetail.updatedAt).toLocaleString() : '—'}</span>
                </div>
              </div>
              <span className={`status-badge status-${runDetail.status} monitor-status-badge`}>{runDetail.status}</span>
            </div>

            <div className="summary-cards">
              <div className="card monitor-summary-card">
                <div className="card-title">Current Agent</div>
                <div className="card-value monitor-summary-value" style={{ textTransform: 'uppercase' }}>
                  {runDetail.currentAgent || 'None'}
                  {runDetail.currentConductor && (
                    <span style={{ color: KIND_COLOR.operator, fontSize: '0.65em', marginLeft: 8, fontWeight: 600 }}>
                      · conducted by {agentGlyph(runDetail.currentConductor)} {runDetail.currentConductor}
                    </span>
                  )}
                </div>
              </div>
              <div className="card monitor-summary-card">
                <div className="card-title">Phase</div>
                <div className="card-value monitor-summary-value">{runDetail.currentStep || 'Unknown'}</div>
              </div>
              <div className="card monitor-summary-card">
                <div className="card-title">Artifacts</div>
                <div className="card-value monitor-summary-value">{runDetail.artifacts.length}</div>
              </div>
            </div>

            <div className="monitor-detail-grid">
              <div className="monitor-primary-column">
                <div className="card monitor-section-card">
                  <div className="panel-heading"><Terminal size={14} /> <span>Task Description</span></div>
                  <div className="monitor-markdown-body">
                    <ReactMarkdown>{runDetail.taskMarkdown || 'No description available'}</ReactMarkdown>
                  </div>
                </div>

                {runDetail.outputMarkdown && (
                  <div className="card monitor-section-card">
                    <div className="panel-heading"><span>Output Summary</span></div>
                    <ReactMarkdown>{runDetail.outputMarkdown}</ReactMarkdown>
                  </div>
                )}

                <div className="card monitor-section-card">
                  <div className="panel-heading"><span>Timeline</span></div>
                  <div className="timeline">
                    {runDetail.timeline.map((event) => (
                      <div key={event.id} className="timeline-item">
                        <div className="timeline-dot"></div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>
                          <span>{agentGlyph(event.agent)} </span>
                          {event.agentKind === 'operator' && (
                            <span style={{ fontSize: '10px', fontWeight: 500, textTransform: 'uppercase', opacity: 0.7, marginRight: '4px' }}>ran by</span>
                          )}
                          <span style={{ color: KIND_COLOR[event.agentKind] || 'var(--text-primary)' }}>{event.agent.toUpperCase()}</span>
                          <span> - {event.action}</span>
                        </div>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{event.message}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>{event.timestamp}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {runDetail.artifacts.some((a) => a.type === 'log') && (
                  <div className="card monitor-section-card">
                    <div className="panel-heading"><Terminal size={14} /> <span>Live Logs</span></div>
                    <div style={{ position: 'relative', width: '100%', marginBottom: 12 }}>
                      <select
                        className="log-select"
                        style={{ appearance: 'none', WebkitAppearance: 'none', paddingRight: 32, marginBottom: 0 }}
                        value={selectedLogFile}
                        onChange={(e) => onSelectLogFile(e.target.value)}
                      >
                        <option value="">Select a log file...</option>
                        {runDetail.artifacts.filter((a) => a.type === 'log').map((a) => (
                          <option key={a.name} value={a.name}>{a.name}</option>
                        ))}
                      </select>
                      <ChevronDown
                        size={16}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }}
                      />
                    </div>
                    <div className="log-terminal" id="log-viewer">
                      {logError || (logContent != null ? (logContent || '(empty log file)') : 'Select a log file to view content')}
                    </div>
                  </div>
                )}
              </div>

              <div className="monitor-side-column">
                <div className="card monitor-section-card">
                  <div className="panel-heading"><span>Artifacts</span></div>
                  <ul className="artifact-list">
                    {runDetail.artifacts.map((a) => (
                      <li key={a.name} className="artifact-item">
                        <div className="artifact-name">{a.name}</div>
                        <div className="artifact-meta">Type: {a.type}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                
                {runDetail.errorReason && (
                  <div className="card monitor-error-card">
                    <div className="card-title" style={{ color: 'var(--status-error)' }}>Error Reason</div>
                    <div className="monitor-error-copy">{runDetail.errorReason}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="card state-panel state-panel-neutral">
            <AlertCircle size={40} className="state-panel-icon" style={{ color: 'var(--status-error)' }} />
            <div className="state-panel-body">
              <div className="state-panel-eyebrow">Run Unavailable</div>
              <h3 className="state-panel-title">Selected run not found.</h3>
              <p className="state-panel-copy">Choose another run from the sidebar to continue inspecting current task state.</p>
            </div>
          </div>
        )
      ) : (
        <div className="card state-panel state-panel-neutral">
          <LayoutDashboard size={46} className="state-panel-icon state-panel-icon-muted" />
          <div className="state-panel-body">
            <div className="state-panel-eyebrow">Monitor Ready</div>
            <h3 className="state-panel-title">Select a run to inspect its current state</h3>
            <p className="state-panel-copy">Choose a task from the sidebar to view its summary, timeline, artifacts, and available logs. Real-time updates are already active via the file watcher.</p>
          </div>
        </div>
      )}
    </div>
  );
}
