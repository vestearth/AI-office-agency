import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Terminal, Loader2, Network, ChevronDown, X } from 'lucide-react';
import type { DecisionAction, HealthStatus, ReviewSummary, RunDetail, RunFileResponse, RunSummary } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { agentGlyph, KIND_COLOR } from './agentDisplay';
import { GatesCard } from './GatesCard';
import { distinctTitle } from './runTitle';
import { formatUpdated } from './monitorList';
import { idleLabel, metadataTag, timelinePreview, timelineView } from './monitorDetail';
import { NextActionPreviewCard } from './NextActionPreviewCard';
import { ACTOR_KEY, DecisionDialog } from './DecisionDialog';
import { DesktopHandoffDialog } from './DesktopHandoffDialog';
import { MonitorHome } from './MonitorHome';
import { ReleaseCard } from './ReleaseCard';
import { LaunchCard } from './LaunchCard';
import { CommandCopy, isShellCommand } from './CommandCopy';
import { WAIT_KIND_LABEL } from '../../../shared/waitKinds';
import { runStatusClass, runStatusLabel } from '../../../shared/statusLabels';

// Monitor is the run's full detail page (status, next action + decision,
// evidence, context). Command keeps only a quick decision panel that links here.

const DECISION_ACTIONS: { action: DecisionAction; label: string }[] = [
  { action: 'approve', label: 'Approve' }, { action: 'request_changes', label: 'Changes' },
  { action: 'escalate', label: 'Escalate' }, { action: 'reject', label: 'Reject' },
];
// task.md and outputs use GitHub tables (TASK-EAR-406's carried list); plain CommonMark printed them as pipes.
const GFM = [remarkGfm];
const RISK_COLOR: Record<string, string> = {
  high: 'var(--status-error)', medium: 'var(--status-warning)', low: 'var(--status-success)', none: 'var(--text-secondary)',
};

export interface MonitorViewProps {
  loading: boolean;
  health: HealthStatus | null;
  healthAccent: string;
  selectedRunId: string | null;
  runDetail: RunDetail | null;
  /** Review read model for the selected run; null when /api/review is unavailable. */
  review: ReviewSummary | null;
  /** All runs and their review rows, for the landing view when nothing is selected. */
  runs: RunSummary[];
  reviews: Map<string, ReviewSummary>;
  onSelectRun: (id: string) => void;
  /** Called after a decision is recorded so the host reloads runs + detail. */
  onDecided: () => void;
  runDetailLoading: boolean;
  runDetailError: string | null;
  selectedLogFile: string;
  logContent: string | null;
  logError: string | null;
  onSelectLogFile: (fileName: string) => void;
}

function readActor(): string {
  try { return localStorage.getItem(ACTOR_KEY) || ''; } catch { return ''; }
}

export function MonitorView({
  loading,
  health,
  healthAccent,
  selectedRunId,
  runDetail,
  review,
  runs,
  reviews,
  onSelectRun,
  onDecided,
  runDetailLoading,
  runDetailError,
  selectedLogFile,
  logContent,
  logError,
  onSelectLogFile,
}: MonitorViewProps) {
  // Follow-tail: auto-scroll the log viewer to the bottom on refresh while the
  // user is parked near the bottom. Scrolling up pauses it; scrolling back down
  // (or the checkbox) resumes.
  const logRef = useRef<HTMLDivElement>(null);
  const [followTail, setFollowTail] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [taskExpanded, setTaskExpanded] = useState(false);
  const [fileView, setFileView] = useState<RunFileResponse | null>(null);
  const [decision, setDecision] = useState<{ action: DecisionAction; label: string } | null>(null);
  const [handoff, setHandoff] = useState(false);

  useEffect(() => {
    if (followTail && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logContent, logError, followTail, selectedLogFile]);

  // A new run starts collapsed with no file open; a refresh of the same run keeps the view.
  useEffect(() => {
    setTimelineExpanded(false);
    setTaskExpanded(false);
    setFileView(null);
    setDecision(null);
    setHandoff(false);
  }, [selectedRunId]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowTail((prev) => (prev === nearBottom ? prev : nearBottom));
  };

  const openArtifact = async (name: string, type: string) => {
    if (!runDetail) return;
    if (type === 'log') { onSelectLogFile(name); return; }
    setFileView({ name, content: 'Loading…', truncated: false });
    try {
      setFileView(await apiFetchJson<RunFileResponse>(`/api/runs/${runDetail.id}/file/${encodeURIComponent(name)}`));
    } catch {
      setFileView({ name, content: '(failed to load file)', truncated: false });
    }
  };

  const healthHeadline =
    health?.status === 'warning'
      ? 'Dashboard health warning'
      : 'Dashboard health degraded';
  const healthSummary =
    health?.status === 'warning'
      ? 'The monitor is still available, but one or more file-system dependencies need attention.'
      : 'The monitor may not reflect current run state until the underlying dashboard wiring is restored.';
  const socraticodeLabel =
    !health?.socraticode
      ? 'not checked'
      : health.socraticode.backend === 'none'
        ? `${health.socraticode.status}${health.socraticode.attemptedBackends?.length
          ? ` (probed ${health.socraticode.attemptedBackends.join(' → ')})`
          : ''}`
        : `${health.socraticode.status} via ${health.socraticode.backend}`;
  const socraticodeDetail =
    health?.socraticode?.projectPath || health?.socraticode?.message || 'No project path reported';

  const idle = idleLabel(review);
  // Review decisions mean something only while a run is in review or a decision is pending;
  // elsewhere the buttons stay folded so an opened-only task is not one click from "Approve".
  const reviewable = runDetail?.status === 'waiting_review'
    || review?.actionKind === 'awaiting_review' || review?.actionKind === 'decision_pending';
  const timeline = runDetail ? timelineView(runDetail.timeline, timelineExpanded) : null;
  const preview = runDetail ? timelinePreview(runDetail.timeline) : null;
  const logArtifacts = runDetail?.artifacts.filter((a) => a.type === 'log') ?? [];

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

      {/* Healthy is the header's "Backend Connected"; only a problem earns a banner here. */}
      {health && health.status !== 'ok' && (
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
        // Keep showing the current run during a background refresh; show loading only for a different run.
        runDetailLoading && runDetail?.id !== selectedRunId ? (
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
                <h1 className="monitor-run-title">
                  {runDetail.id}{distinctTitle(runDetail.id, runDetail.title) && `: ${distinctTitle(runDetail.id, runDetail.title)}`}
                </h1>
                <div className="monitor-run-meta">
                  <span>{agentGlyph(runDetail.currentAgent)} {runDetail.currentAgent || 'no agent'}</span>
                  {runDetail.currentConductor && (
                    <span style={{ color: KIND_COLOR.operator }}>
                      conducted by {agentGlyph(runDetail.currentConductor)} {runDetail.currentConductor}
                    </span>
                  )}
                  <span>phase <code className="phase-code">{runDetail.currentStep || 'unknown'}</code></span>
                  <span>updated {formatUpdated(runDetail.updatedAt)}</span>
                  <span className="monitor-run-path">{runDetail.runPath}</span>
                </div>
              </div>
              <div className="monitor-run-badges">
                {idle && review?.idle && (
                  <span className="idle-badge idle-badge-lg"
                    title={`No status change for ${review.idle.days} days (stale after ${review.idle.thresholdDays})`}>
                    ⚠ {idle}
                  </span>
                )}
                <span className={`status-badge ${runStatusClass(runDetail.status, runDetail.currentStep)} monitor-status-badge`}>{runStatusLabel(runDetail.status, runDetail.currentStep)}</span>
              </div>
            </div>

            <section className="card monitor-decision-panel" aria-label="Next action and decision">
              {review?.requiresAction && review.actionReason && (
                <div className="monitor-action-reason">
                  <strong>Why it needs you</strong>
                  <span>{review.actionReason}{review.recommendedAction && !isShellCommand(review.recommendedAction) ? ` ${review.recommendedAction}` : ''}</span>
                  {review.recommendedAction && isShellCommand(review.recommendedAction) && (
                    <CommandCopy command={review.recommendedAction} label={`Copy the command for ${runDetail.id}`} />
                  )}
                </div>
              )}
              {runDetail.waitsOn && runDetail.waitsOn.length > 0 && (
                <div className="monitor-waits" aria-label="Waits on">
                  <strong>Waits on</strong>
                  {runDetail.waitsOn.map((w) => (
                    <span key={`${w.kind}|${w.ref ?? ''}`} className="monitor-wait-chip">
                      {WAIT_KIND_LABEL[w.kind]}
                      {w.ref && <> via <button type="button" className="action-waits-link" onClick={() => onSelectRun(w.ref!)}>{w.ref}</button></>}
                    </span>
                  ))}
                </div>
              )}
              <div className="monitor-decision-grid">
                {runDetail.nextActionPreview && (
                  <NextActionPreviewCard preview={runDetail.nextActionPreview} onOpen={() => setHandoff(true)} />
                )}
                <div className="monitor-decision-side">
                  {review && (
                    <div className="monitor-facts" aria-label="Review summary">
                      <span className="monitor-fact">verdict: {review.verdict ?? '—'}</span>
                      <span className="monitor-fact" style={{ color: RISK_COLOR[review.riskLevel] }}>
                        risk: {review.riskLevel} (e{review.issueCounts.error}/w{review.issueCounts.warning}/s{review.issueCounts.suggestion})
                      </span>
                      <span className="monitor-fact">confidence: {review.confidence ?? '—'}</span>
                      {review.latestDecision && (
                        <span className="monitor-fact" style={{ color: 'var(--status-success)' }}>
                          decided: {review.latestDecision.decision} · {review.latestDecision.actor}
                        </span>
                      )}
                    </div>
                  )}
                  {reviewable ? (
                    <>
                      <div className="decision-actions">
                        {DECISION_ACTIONS.map(({ action, label }) => (
                          <button className="decision-button" data-action={action} type="button" key={action}
                            onClick={() => setDecision({ action, label })}>{label}</button>
                        ))}
                      </div>
                      <span className="monitor-decision-note">Recorded to decision.yaml; status changes on driver reconcile.</span>
                    </>
                  ) : (
                    <details className="monitor-decision-folded">
                      <summary>Record a review decision</summary>
                      <span className="monitor-decision-note">This run is not in review ({runDetail.currentStep ?? 'unknown phase'}). A decision is recorded to decision.yaml and applied on driver reconcile.</span>
                      <div className="decision-actions">
                        {DECISION_ACTIONS.map(({ action, label }) => (
                          <button className="decision-button" data-action={action} type="button" key={action}
                            onClick={() => setDecision({ action, label })}>{label}</button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
              {runDetail.reviewIssues && runDetail.reviewIssues.length > 0 && (
                <div className="monitor-issues">
                  <div className="panel-heading"><span>Reviewer Issues ({runDetail.reviewIssues.length})</span></div>
                  {runDetail.reviewIssues.map((iss, i) => (
                    <div key={i} className={`monitor-issue monitor-issue-${iss.severity}`}>
                      <span className="monitor-issue-severity">[{iss.severity}]</span>
                      {iss.file && <span className="monitor-issue-file"> {iss.file}</span>} — {iss.description}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <div className="monitor-detail-grid">
              <div className="monitor-primary-column">
                {fileView && (
                  <div className="card monitor-section-card">
                    <div className="panel-heading">
                      <span>File · {fileView.name}</span>
                      <button type="button" className="monitor-icon-button" aria-label="Close file" onClick={() => setFileView(null)}>
                        <X size={14} />
                      </button>
                    </div>
                    <pre className="monitor-file-body">{fileView.content}{fileView.truncated ? '\n\n… (truncated)' : ''}</pre>
                  </div>
                )}

                <div className="card monitor-section-card">
                  <div className="panel-heading">
                    <span>Timeline</span>
                    <span className="monitor-heading-note">newest first</span>
                  </div>
                  {runDetail.timeline.length === 0 ? (
                    <div className="muted-meta">No history recorded.</div>
                  ) : (
                    <div className="timeline">
                      {(timelineExpanded ? timeline!.shown.map((event) => ({ kind: 'event' as const, event })) : preview!.entries).map((entry) => {
                        if (entry.kind === 'metadata') {
                          const tags = [...new Set(entry.events.map((e) => metadataTag(e.action)).filter(Boolean))].join(', ');
                          return (
                            <button type="button" key={`meta-${entry.events[0]!.id}`} className="timeline-item timeline-meta timeline-meta-group"
                              onClick={() => setTimelineExpanded(true)} title="Show every row">
                              <div className="timeline-dot"></div>
                              {entry.events.length} metadata update{entry.events.length === 1 ? '' : 's'} <span className="timeline-tag">{tags}</span>
                            </button>
                          );
                        }
                        const event = entry.event; const tag = metadataTag(event.action); return (
                        <div key={event.id} className={`timeline-item ${tag ? 'timeline-meta' : ''}`}>
                          <div className="timeline-dot"></div>
                          <div style={{ fontWeight: 600, fontSize: '14px' }}>
                            <span>{agentGlyph(event.agent)} </span>
                            {event.agentKind === 'operator' && (
                              <span style={{ fontSize: '10px', fontWeight: 500, textTransform: 'uppercase', opacity: 0.7, marginRight: '4px' }}>ran by</span>
                            )}
                            <span style={{ color: KIND_COLOR[event.agentKind] || 'var(--text-primary)' }}>{event.agent.toUpperCase()}</span>
                            <span> - {event.action}</span>
                            {tag && <span className="timeline-tag">{tag}</span>}
                          </div>
                          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{event.message}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>{event.timestamp}</div>
                        </div>
                        ); })}
                    </div>
                  )}
                  {((timelineExpanded ? 0 : preview!.hidden) > 0 || timelineExpanded) && (
                    <button type="button" className="monitor-more-button" onClick={() => setTimelineExpanded((v) => !v)}>
                      {timelineExpanded ? 'Show latest only' : `Show all ${runDetail.timeline.length} events`}
                    </button>
                  )}
                </div>

                <div className="card monitor-section-card">
                  <div className="panel-heading"><Terminal size={14} /> <span>Task Description</span></div>
                  <div className={`monitor-markdown-body ${taskExpanded ? 'expanded' : 'collapsed'}`}>
                    <ReactMarkdown remarkPlugins={GFM}>{runDetail.taskMarkdown || 'No description available'}</ReactMarkdown>
                  </div>
                  {runDetail.taskMarkdown && (
                    <button type="button" className="monitor-more-button" aria-expanded={taskExpanded}
                      onClick={() => setTaskExpanded((v) => !v)}>
                      {taskExpanded ? 'Collapse task.md' : 'Expand task.md'}
                    </button>
                  )}
                </div>

                {runDetail.outputMarkdown && (
                  <div className="card monitor-section-card">
                    <div className="panel-heading"><span>Output Summary</span></div>
                    <div className="monitor-markdown-body expanded"><ReactMarkdown remarkPlugins={GFM}>{runDetail.outputMarkdown}</ReactMarkdown></div>
                  </div>
                )}

                {logArtifacts.length > 0 && (
                  <div className="card monitor-section-card">
                    <div className="panel-heading">
                      <Terminal size={14} /> <span>Live Logs</span>
                      <label className="log-follow-toggle">
                        <input type="checkbox" checked={followTail} onChange={(e) => setFollowTail(e.target.checked)} />
                        Follow tail
                      </label>
                    </div>
                    <div style={{ position: 'relative', width: '100%', marginBottom: 12 }}>
                      <select
                        className="log-select"
                        style={{ appearance: 'none', WebkitAppearance: 'none', paddingRight: 32, marginBottom: 0 }}
                        value={selectedLogFile}
                        onChange={(e) => onSelectLogFile(e.target.value)}
                      >
                        <option value="">Select a log file...</option>
                        {logArtifacts.map((a) => (
                          <option key={a.name} value={a.name}>{a.name}</option>
                        ))}
                      </select>
                      <ChevronDown
                        size={16}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-secondary)' }}
                      />
                    </div>
                    <div className="log-terminal" id="log-viewer" ref={logRef} onScroll={onLogScroll}>
                      {logError || (logContent != null ? (logContent || '(empty log file)') : 'Select a log file to view content')}
                    </div>
                  </div>
                )}
              </div>

              <div className="monitor-side-column">
                <LaunchCard taskId={runDetail.id} />
                <ReleaseCard runId={runDetail.id} carries={runDetail.carries} onSelectRun={onSelectRun} />
                {runDetail.gates && <GatesCard view={runDetail.gates} />}

                <div className="card monitor-section-card">
                  <div className="panel-heading">
                    <span>Artifacts</span>
                    <span className="monitor-heading-note">{runDetail.artifacts.length} · click to open</span>
                  </div>
                  <ul className="artifact-list">
                    {runDetail.artifacts.map((a) => a.type === 'directory' ? (
                      <li key={a.name}>
                        <div className="artifact-item artifact-folder" title="A folder: open it in the repo (evidence logs stay local under runs/)">
                          <div className="artifact-name">{a.name}/</div>
                          <div className="artifact-meta">Folder · {a.count ?? 0} file{a.count === 1 ? '' : 's'}</div>
                        </div>
                      </li>
                    ) : (
                      <li key={a.name}>
                        <button type="button"
                          className={`artifact-item artifact-button ${fileView?.name === a.name || (a.type === 'log' && selectedLogFile === a.name) ? 'active' : ''}`}
                          onClick={() => openArtifact(a.name, a.type)}>
                          <div className="artifact-name">{a.name}</div>
                          <div className="artifact-meta">Type: {a.type}</div>
                        </button>
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

            {decision && (
              <DecisionDialog
                taskId={runDetail.id}
                action={decision.action}
                actionLabel={decision.label}
                actor={readActor()}
                onCancel={() => setDecision(null)}
                onDone={() => { setDecision(null); onDecided(); }}
              />
            )}

            {handoff && (
              <DesktopHandoffDialog run={runDetail} officeRoot={health?.aiOfficeRoot} onClose={() => setHandoff(false)} />
            )}
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
        <MonitorHome runs={runs} reviews={reviews} onSelectRun={onSelectRun} loading={loading} />
      )}
    </div>
  );
}
