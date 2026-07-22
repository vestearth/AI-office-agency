import React, { useState, useEffect, useRef } from 'react';
import './styles/globals.css';
import type { 
  RunSummary, 
  RunDetail, 
  HealthStatus,
  DashboardSseEvent
} from '../../shared/types';
import type { DashboardSection } from './views/types';
import { MonitorView } from './views/MonitorView';
import { AnalyticsView } from './views/AnalyticsView';
import { ReportsView } from './views/ReportsView';
import { ReviewView } from './views/ReviewView';
import { CommandView } from './views/CommandView';
import { KnowledgeReviewsView } from './views/KnowledgeReviewsView';
import { apiFetch, apiEventSourceUrl } from './api';
import { ToastProvider } from './components/Toast';
import { NAV_EVENT, readUrlState, writeUrlState, type NavDetail } from './navigation';
import { Activity, Search, Clock, Loader2 } from 'lucide-react';

const App: React.FC = () => {
  // Hydrate tab + selected run from the URL once so deep links / refresh restore state.
  const initialUrl = readUrlState();
  const [activeSection, setActiveSection] = useState<DashboardSection>(initialUrl.tab ?? 'command');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialUrl.run);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedLogFile, setSelectedLogFile] = useState('');
  const [logContent, setLogContent] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  const selectedLogFileRef = useRef<string>('');
  const abortControllerRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef<boolean>(false);

  useEffect(() => {
    fetchInitialData();
    const cleanupSSE = setupSSE();
    return () => {
      cleanupSSE();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Keep the URL (?tab=…&run=…) in sync with state — replaceState so tab/run
  // changes don't flood the back stack. Shareable + survives refresh.
  useEffect(() => {
    writeUrlState(activeSection, selectedRunId);
  }, [activeSection, selectedRunId]);

  // Cross-view navigation bus: any view can deep-link into a tab + run.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<NavDetail>).detail;
      if (!detail) return;
      setActiveSection(detail.tab);
      setSelectedRunId(detail.run);
    };
    window.addEventListener(NAV_EVENT, onNav);
    return () => window.removeEventListener(NAV_EVENT, onNav);
  }, []);

  useEffect(() => {
    if (selectedRunId) {
      // Abort any previous in-flight fetches when selectedRunId changes
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      selectedLogFileRef.current = '';
      setSelectedLogFile('');
      setLogContent(null);
      setLogError(null);
      fetchRunDetail(selectedRunId);
    }
    selectedRunIdRef.current = selectedRunId;
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [selectedRunId]);

  useEffect(() => {
    selectedLogFileRef.current = selectedLogFile;
  }, [selectedLogFile]);

  const fetchInitialData = async (signal?: AbortSignal) => {
    try {
      const [healthRes, runsRes] = await Promise.all([
        apiFetch('/api/health', { signal }),
        apiFetch('/api/runs', { signal }),
      ]);
      const healthData = await healthRes.json();
      const runsData = await runsRes.json();
      setHealth(healthData);
      setRuns(runsData);

      if (
        selectedRunIdRef.current &&
        !runsData.some((run: RunSummary) => run.id === selectedRunIdRef.current)
      ) {
        setRunDetail(null);
        setRunDetailError('Selected run not found.');
        selectedLogFileRef.current = '';
        setSelectedLogFile('');
        setLogContent(null);
        setLogError(null);
      }
      setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Error fetching initial data:', err);
      setLoading(false);
    }
  };

  const fetchRunDetail = async (id: string, signal?: AbortSignal) => {
    setRunDetailLoading(true);
    setRunDetailError(null);
    try {
      const res = await apiFetch(`/api/runs/${id}`, { signal });
      if (!res.ok) {
        setRunDetail(null);
        setRunDetailError(res.status === 404 ? 'Selected run not found.' : 'Failed to load run details.');
        return;
      }
      const data = await res.json();
      setRunDetail(data);
      if (selectedLogFileRef.current) {
        const hasSelectedLog = data.artifacts.some(
          (artifact: { type: string; name: string }) =>
            artifact.type === 'log' && artifact.name === selectedLogFileRef.current
        );
        if (!hasSelectedLog) {
          selectedLogFileRef.current = '';
          setSelectedLogFile('');
          setLogContent(null);
          setLogError('Log not found.');
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Error fetching run detail:', err);
      setRunDetail(null);
      setRunDetailError('Failed to load run details.');
    } finally {
      setRunDetailLoading(false);
    }
  };

  const fetchLogContent = async (taskId: string, fileName: string, signal?: AbortSignal) => {
    if (!fileName) {
      setLogContent(null);
      setLogError(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/logs/${taskId}/${fileName}`, { signal });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setLogContent(null);
        setLogError(data?.error || 'Log not found');
        return;
      }
      const data = await res.json();
      setLogContent(data.content);
      setLogError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('Error fetching log content:', err);
      setLogContent(null);
      setLogError('Failed to load log content.');
    }
  };

  const setupSSE = () => {
    const eventSource = new EventSource(apiEventSourceUrl('/api/events'));
    const onRunsChanged = async (event: MessageEvent<string>) => {
      const update = JSON.parse(event.data) as DashboardSseEvent;
      console.log('Update received:', update);

      // Deduplicate: skip if a refresh is already in flight
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;

      // Abort any previous in-flight fetches before starting a new refresh cycle
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const { signal } = controller;

      try {
        // Coordinated refresh
        await fetchInitialData(signal);

        if (selectedRunIdRef.current) {
          await fetchRunDetail(selectedRunIdRef.current, signal);
          if (selectedLogFileRef.current) {
            await fetchLogContent(selectedRunIdRef.current, selectedLogFileRef.current, signal);
          }
        }
      } finally {
        refreshInFlightRef.current = false;
      }

      // Trigger Analytics refresh via a global event or similar
      // For now, we can rely on the fact that AnalyticsView will likely re-mount
      // or we can add a refresh counter if needed.
      window.dispatchEvent(new CustomEvent('dashboard:refresh', { detail: update }));
    };
    eventSource.addEventListener('runs.changed', onRunsChanged);
    return () => eventSource.close();
  };

  const filteredRuns = runs.filter(r => 
    r.id.toLowerCase().includes(search.toLowerCase()) || 
    r.title.toLowerCase().includes(search.toLowerCase())
  );

  const sections: Array<{ id: DashboardSection; label: string }> = [
    { id: 'command', label: 'Command' },
    { id: 'monitor', label: 'Monitor' },
    { id: 'review', label: 'Action' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'reports', label: 'Reports' },
    { id: 'knowledge', label: 'Knowledge' },
  ];
  const sidebarSummaryLabel = loading
    ? 'Loading runs...'
    : `${filteredRuns.length} of ${runs.length} runs visible`;

  const healthAccent =
    !health
      ? 'var(--status-error)'
      : health.status === 'error'
        ? 'var(--status-error)'
        : health.status === 'warning'
          ? '#f59e0b'
          : 'var(--status-success)';
  const healthLabel =
    !health
      ? 'Offline'
      : health.status === 'error'
        ? 'Error'
        : health.status === 'warning'
          ? 'Warning'
          : 'Connected';

  const formatUptime = (seconds?: number) => {
    if (seconds === undefined) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  return (
    <ToastProvider>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <header className="app-header">
        <Activity className="app-header-icon" color="var(--accent-color)" size={20} />
        <span className="app-title">AI Dev Dashboard</span>
        <nav className="app-nav">
          {sections.map((section) => (
            <button key={section.id} type="button"
              onClick={() => setActiveSection(section.id)}
              aria-current={activeSection === section.id ? 'page' : undefined}
              className={`section-tab ${activeSection === section.id ? 'active' : ''}`}>
              {section.label}
            </button>
          ))}
        </nav>
        <div className="app-health">
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: healthAccent }} />
          <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Backend {healthLabel}</strong>
          {health && <span className="app-health-summary">· {health.totalRuns ?? 0} runs · up {formatUptime(health.uptime)}</span>}
        </div>
      </header>

      <div className="app-container" style={{ flex: 1, minHeight: 0, height: 'auto' }}>
        {activeSection === 'monitor' && (
        <div className="sidebar">
          <div className="sidebar-header">
          <div className="search-input-shell">
            <Search size={16} className="search-input-icon" />
            <input
              className="search-input"
              type="text"
              placeholder="Search tasks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="sidebar-subhead">
            <span className="sidebar-subhead-label">Task Runs</span>
            <span className="sidebar-subhead-value">{sidebarSummaryLabel}</span>
          </div>
          </div>
        <div className="run-list">
          {loading ? (
            <div className="sidebar-list-state"><Loader2 className="animate-spin" /></div>
          ) : filteredRuns.length === 0 ? (
            <div className="sidebar-list-state muted-meta">No runs found</div>
          ) : (
            filteredRuns.map(run => (
              <button
                type="button"
                key={run.id}
                aria-current={selectedRunId === run.id ? 'true' : undefined}
                className={`run-item ${selectedRunId === run.id ? 'active' : ''}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <div className="run-item-header">
                  <span className="run-item-id">{run.id}</span>
                  <div className="run-item-badges">
                    <span className="status-badge status-unknown">{run.workstream || 'general'}</span>
                    <span className={`status-badge status-${run.status}`}>{run.status}</span>
                  </div>
                </div>
                <div className="run-item-title">
                  {run.title}
                </div>
                <div className="run-item-updated">
                  <span className="run-item-updated-label">Updated</span>
                  <Clock size={10} />
                  {new Date(run.updatedAt || '').toLocaleString()}
                </div>
              </button>
            ))
          )}
        </div>
        </div>
        )}

      <div className={`main-content ${activeSection === 'command' ? 'main-content-flush' : ''}`}>
        {activeSection === 'command' && (
          <CommandView selectedTaskId={selectedRunId} />
        )}

        {activeSection === 'monitor' && (
          <MonitorView
            loading={loading}
            health={health}
            healthAccent={healthAccent}
            selectedRunId={selectedRunId}
            runDetail={runDetail}
            runDetailLoading={runDetailLoading}
            runDetailError={runDetailError}
            selectedLogFile={selectedLogFile}
            logContent={logContent}
            logError={logError}
            onSelectLogFile={(fileName) => {
              setSelectedLogFile(fileName);
              if (selectedRunId) fetchLogContent(selectedRunId, fileName);
            }}
          />
        )}

        {activeSection === 'analytics' && (
          <AnalyticsView />
        )}

        {activeSection === 'review' && (
          <ReviewView />
        )}

        {activeSection === 'reports' && (
          <ReportsView />
        )}

        {activeSection === 'knowledge' && (
          <KnowledgeReviewsView />
        )}
      </div>
      </div>
    </div>
    </ToastProvider>
  );
};

export default App;
