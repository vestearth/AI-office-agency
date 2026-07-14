import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { config } from '../config';
import { TASK_ID_PATTERN } from '../pathSecurity';
import type {
  RunSummary,
  RunDetail,
  RunStatus,
  RunPhase,
  AgentName,
  AgentKind,
  TimelineActor,
  TaskWorkstream,
  RunArtifact,
  AgentTimelineEvent,
  NextActionPreview,
  TaskActionRole,
} from '@shared/types';
import { buildModelRoutingPreview } from './modelRouting';

// Operator model (ADR-0003): a history[].agent value may be a role (the workflow
// contract), an operator (conductor/subagent — who ran it), or an actor
// (orchestrator/user/done). Classify it instead of collapsing non-roles to
// 'unknown', so the timeline can show who actually ran each transition.
const TIMELINE_ROLES = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam', 'done'];
const TIMELINE_ACTORS = ['orchestrator', 'user'];
const TIMELINE_OPERATORS = ['claude', 'codex', 'cursor', 'gemini'];

export function classifyActor(raw?: string): { name: TimelineActor; kind: AgentKind } {
  const a = (raw || '').toLowerCase();
  if (TIMELINE_ROLES.includes(a)) return { name: a as TimelineActor, kind: a === 'done' ? 'actor' : 'role' };
  if (TIMELINE_ACTORS.includes(a)) return { name: a as TimelineActor, kind: 'actor' };
  if (TIMELINE_OPERATORS.includes(a)) return { name: a as TimelineActor, kind: 'operator' };
  return { name: 'unknown', kind: 'unknown' };
}

// currentConductor (ADR-0003): the operator that drove the most recent history
// transition, i.e. who is conducting. Derived only — never a status.yaml field —
// and undefined when the run's history never recorded an operator.
export function latestConductor(history: unknown): TimelineActor | undefined {
  if (!Array.isArray(history)) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = classifyActor(history[i]?.agent);
    if (c.kind === 'operator') return c.name;
  }
  return undefined;
}

const RUN_STATUS_PRIORITY: Record<RunStatus, number> = {
  running: 0,
  blocked: 1,
  waiting_review: 2,
  failed: 3,
  queued: 4,
  unknown: 5,
  completed: 6,
  cancelled: 7,
};

// Exact phase → dashboard status. Mirrors the status.schema.yaml phase enum, so
// the dashboard renders the contracted phase instead of guessing via substrings.
const PHASE_TO_STATUS: Record<RunPhase, RunStatus> = {
  pending: 'queued',
  blocked: 'blocked',
  assigned: 'running',
  assigned_parallel: 'running',
  review: 'waiting_review',
  in_review: 'waiting_review',
  debugging: 'running',
  debugging_complete: 'running',
  devops_needed: 'running',
  devops_complete: 'running',
  escalated: 'blocked',
  free_roam_complete: 'running',
  validation_failed: 'failed',
  done: 'completed',
  aborted: 'cancelled',
};

const TASK_ACTION_ROLES: TaskActionRole[] = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam', 'done'];

function taskActionRole(value: unknown): TaskActionRole | undefined {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return TASK_ACTION_ROLES.includes(normalized as TaskActionRole) ? normalized as TaskActionRole : undefined;
}

function actionReason(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const action = value as Record<string, unknown>;
  for (const key of ['reason', 'description']) {
    const candidate = action[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Builds the Command Center's next-action card strictly from run artifacts.
 * A complete status.yaml next_action wins. Otherwise only exact phase/current_agent
 * mappings are used; absent or off-contract values stay unavailable.
 */
export function buildNextActionPreview(statusData: Record<string, any>): NextActionPreview {
  const artifactRole = taskActionRole(statusData.next_action?.agent);
  const artifactReason = actionReason(statusData.next_action);
  if (artifactRole && artifactReason) {
    return { previewOnly: true, source: 'status-next-action', targetRole: artifactRole, reason: artifactReason };
  }

  const phase = typeof statusData.phase === 'string' ? statusData.phase : undefined;
  const currentRole = taskActionRole(statusData.current_agent);
  const mappedRoles: Partial<Record<RunPhase, TaskActionRole>> = {
    pending: 'pm',
    review: 'reviewer',
    in_review: 'reviewer',
    debugging: 'debugger',
    debugging_complete: 'debugger',
    devops_needed: 'devops',
    devops_complete: 'devops',
    escalated: 'free-roam',
    free_roam_complete: 'free-roam',
    done: 'done',
  };
  const phaseRole = phase && (mappedRoles as Record<string, TaskActionRole | undefined>)[phase];
  if (phaseRole) {
    return {
      previewOnly: true,
      source: 'phase-current-agent',
      targetRole: phaseRole,
      reason: phase === 'done'
        ? 'status.yaml phase = done; no further role launch is recommended.'
        : `status.yaml phase = ${phase}; ${phaseRole} is the contracted workflow role for this phase.`,
    };
  }

  if (phase === 'assigned' || phase === 'assigned_parallel' || phase === 'validation_failed') {
    if (currentRole && currentRole !== 'done') {
      return {
        previewOnly: true,
        source: 'phase-current-agent',
        targetRole: currentRole,
        reason: `status.yaml phase = ${phase} and current_agent = ${currentRole}; preview targets that recorded role.`,
      };
    }
    return {
      previewOnly: true,
      source: 'unavailable',
      reason: `status.yaml phase = ${phase}, but it has no recognized current_agent to target.`,
    };
  }

  if (phase === 'blocked') {
    return { previewOnly: true, source: 'unavailable', reason: 'status.yaml phase = blocked; resolve its recorded blocker before launching another role.' };
  }
  if (phase === 'aborted') {
    return { previewOnly: true, source: 'unavailable', reason: 'status.yaml phase = aborted; no role launch is recommended.' };
  }
  return { previewOnly: true, source: 'unavailable', reason: 'No complete status.yaml next_action or recognized phase/current_agent is available.' };
}

/**
 * Maps a status.yaml phase/state to a dashboard RunStatus by exact enum match.
 * Unknown/off-contract values become 'unknown' — never fuzzy-matched.
 */
export function mapPhaseToRunStatus(value: string | undefined): RunStatus {
  if (!value) return 'unknown';
  return (PHASE_TO_STATUS as Record<string, RunStatus>)[value] ?? 'unknown';
}

function taskIdNumber(taskId: string): number | null {
  const match = taskId.match(/^TASK(?:-[A-Z][A-Z0-9]*)?-(\d+)$/); // TASK-NNN, TASK-PKG-NNN, or namespaced TASK-<PREFIX>-NNN
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Coerces parsed YAML into a plain object. A half-written status.yaml can parse
 * to a scalar, array, or null, which would break property access downstream.
 */
export function asObject(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

const WORKSTREAMS = new Set<TaskWorkstream>(['frontend', 'backend', 'devops', 'framework', 'docs', 'general']);

function normalizeWorkstream(value: unknown): TaskWorkstream {
  return typeof value === 'string' && WORKSTREAMS.has(value as TaskWorkstream)
    ? (value as TaskWorkstream)
    : 'general';
}

export function sortRunsByPriority(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a: RunSummary, b: RunSummary) => {
    const priorityDiff = RUN_STATUS_PRIORITY[a.status] - RUN_STATUS_PRIORITY[b.status];
    if (priorityDiff !== 0) return priorityDiff;

    const numA = taskIdNumber(a.id);
    const numB = taskIdNumber(b.id);
    if (numA !== null && numB !== null && numA !== numB) {
      return numB - numA;
    }

    if (a.updatedAt !== b.updatedAt) {
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    }

    return b.id.localeCompare(a.id);
  });
}

/**
 * Normalizes failure reasons for consistent grouping.
 * Logic: collapse whitespace, remove trailing punctuation, lowercase.
 */
export function normalizeFailureReason(reason?: string): string {
  if (!reason) return 'unknown';
  return reason
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')             // Collapse multiple spaces
    .replace(/[.,!?;:]+$/, '')        // Remove trailing punctuation
    .trim() || 'unknown';
}

export class RunScanner {
  private cache: RunSummary[] | null = null;
  private cacheTimestamp: number = 0;
  private pendingRequest: Promise<RunSummary[]> | null = null;
  /**
   * Short-lived coalescing window to prevent redundant filesystem scans
   * when multiple frontend panels (Summary, Trends, etc.) request analytics simultaneously.
   */
  private readonly SCAN_COALESCE_MS = 1000;

  /**
   * Drops the cached snapshot so the next listRuns() re-scans the filesystem.
   * Wired to the watcher's update event so SSE-driven refreshes see fresh data.
   */
  invalidate(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
  }

  async listRuns(forceRefresh = false): Promise<RunSummary[]> {
    const now = Date.now();
    
    // 1. Check if we have a fresh result from a very recent scan
    if (!forceRefresh && this.cache && (now - this.cacheTimestamp < this.SCAN_COALESCE_MS)) {
      return this.cache;
    }

    // 2. Return existing in-flight promise to coalesce concurrent requests
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    // 3. Create new scan promise
    this.pendingRequest = (async () => {
      try {
        const entries = await fs.readdir(config.runsDir, { withFileTypes: true });
        const taskDirs = entries
          .filter(entry => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
          .map(entry => entry.name);

        const summaries = await Promise.all(
          taskDirs.map(async taskId => {
            try {
              return await this.getRunSummary(taskId);
            } catch (err) {
              console.error(`Error scanning task ${taskId}:`, err);
              return this.getFallbackSummary(taskId);
            }
          })
        );

        const result = sortRunsByPriority(summaries);
        this.cache = result;
        this.cacheTimestamp = Date.now();
        return result;
      } catch (err) {
        console.error('Error listing runs:', err);
        return [];
      } finally {
        this.pendingRequest = null;
      }
    })();

    return this.pendingRequest;
  }

  async getRunDetail(taskId: string): Promise<RunDetail | null> {
    const runPath = path.join(config.runsDir, taskId);
    try {
      const summary = await this.getRunSummary(taskId);
      const detail: RunDetail = {
        ...summary,
        artifacts: [],
        timeline: []
      };

      let taskMarkdown: string | undefined;
      let statusData: Record<string, any> = {};

      // Read task.md
      try {
        taskMarkdown = await fs.readFile(path.join(runPath, 'task.md'), 'utf8');
        detail.taskMarkdown = taskMarkdown;
      } catch (e) { /* ignore */ }

      // Read status.yaml for more details
      const statusPath = path.join(runPath, 'status.yaml');
      try {
        const statusContent = await fs.readFile(statusPath, 'utf8');
        statusData = asObject(yaml.load(statusContent));
        detail.statusRaw = statusData;
        detail.nextActionPreview = buildNextActionPreview(statusData);

        if (Array.isArray(statusData.history)) {
          detail.timeline = statusData.history.map((h: any, index: number) => {
            const actor = classifyActor(h.agent);
            return {
              id: `${taskId}-h-${index}`,
              agent: actor.name,
              agentKind: actor.kind,
              action: h.phase || 'action',
              message: h.reason || h.message,
              timestamp: h.at || h.timestamp || summary.updatedAt // S10/N1: real per-transition time
            };
          });
        }
      } catch (e) { /* ignore */ }

      // A missing or unreadable status artifact remains visible as an explicit
      // unavailable preview instead of a guessed workflow action.
      detail.nextActionPreview ??= buildNextActionPreview(statusData);

      let pmOutput: unknown;
      try {
        pmOutput = yaml.load(await fs.readFile(path.join(runPath, 'pm-output.yaml'), 'utf8'));
      } catch (e) { /* old or manually-created runs may not have PM output */ }

      detail.modelRoutingPreview = buildModelRoutingPreview({
        taskId,
        pmOutput,
        currentAgent: detail.currentAgent,
        workstream: detail.workstream,
        taskMarkdown,
      });

      // List artifacts. A transient readdir failure must not nuke the whole
      // detail — keep the summary/timeline we already have.
      try {
        const files = await fs.readdir(runPath);
        detail.artifacts = files.map(file => {
          const ext = path.extname(file).toLowerCase();
          let type: RunArtifact['type'] = 'other';
          if (ext === '.md') type = 'markdown';
          else if (ext === '.patch') type = 'patch';
          else if (ext === '.log') type = 'log';
          else if (ext === '.json') type = 'json';
          else if (ext === '.yaml' || ext === '.yml') type = 'yaml';

          return {
            name: file,
            path: path.join('runs', taskId, file),
            type
          };
        });

        // Try to find output markdown
        const outputFiles = detail.artifacts.filter((a: RunArtifact) => a.name.endsWith('-output.md'));
        if (outputFiles.length > 0) {
          detail.outputMarkdown = await fs.readFile(path.join(runPath, outputFiles[0].name), 'utf8');
        }
      } catch (e) { /* ignore — artifacts are best-effort */ }

      // Reviewer issues (full text) — the "why" behind a changes_requested verdict.
      try {
        const rv = asObject(yaml.load(await fs.readFile(path.join(runPath, 'reviewer-output.yaml'), 'utf8')));
        const issues: { file: string; severity: string; description: string }[] = [];
        if (Array.isArray(rv.artifacts)) {
          for (const a of rv.artifacts) {
            const list = a && Array.isArray(a.issues) ? a.issues : [];
            for (const iss of list) {
              if (iss && typeof iss.description === 'string') {
                issues.push({ file: typeof a.path === 'string' ? a.path : '', severity: String(iss.severity || 'info'), description: iss.description });
              }
            }
          }
        }
        if (issues.length) detail.reviewIssues = issues;
      } catch (e) { /* no reviewer-output */ }

      return detail;
    } catch (err) {
      console.error(`Error getting run detail for ${taskId}:`, err);
      return null;
    }
  }

  private async getRunSummary(taskId: string): Promise<RunSummary> {
    const runPath = path.join(config.runsDir, taskId);
    const statusPath = path.join(runPath, 'status.yaml');
    
    let statusData: Record<string, any> = {};
    try {
      const content = await fs.readFile(statusPath, 'utf8');
      // asObject guards against a half-written file parsing to a scalar/array/null.
      statusData = asObject(yaml.load(content));
    } catch (e) {
      // Missing or malformed status.yaml: still show the task with what we have.
    }

    let pmData: Record<string, any> = {};
    try {
      const content = await fs.readFile(path.join(runPath, 'pm-output.yaml'), 'utf8');
      pmData = asObject(yaml.load(content));
    } catch (e) {
      // PM output is optional for old or manually created runs.
    }
    const taskData = asObject(pmData.task);

    // A transient stat failure (dir being written/renamed) must not sink the
    // whole summary — fall back to status.yaml's own timestamp.
    let mtimeIso: string | undefined;
    try {
      mtimeIso = (await fs.stat(runPath)).mtime.toISOString();
    } catch (e) {
      /* ignore */
    }

    const status = this.mapStatus(statusData.state || statusData.phase);
    const updatedAt = statusData.updated_at || mtimeIso || new Date().toISOString();
    const startedAt = statusData.created_at;

    // Precedence: Explicit status.yaml completed_at -> terminal status updatedAt -> null
    const completedAt = statusData.completed_at || 
      (['completed', 'failed', 'cancelled'].includes(status) ? updatedAt : undefined);

    // Precedence: error_reason -> history[last].reason -> history[last].message -> "unknown"
    let rawReason = "unknown";
    if (statusData.error_reason) {
      rawReason = statusData.error_reason;
    } else if (statusData.history && statusData.history.length > 0) {
      const lastHistory = statusData.history[statusData.history.length - 1];
      rawReason = lastHistory.reason || lastHistory.message || "unknown";
    }
    const normalizedReason = normalizeFailureReason(rawReason);

    // Derived: who is conducting (latest operator in history). No status.yaml field.
    const currentConductor = latestConductor(statusData.history);

    // Only calculated if startedAt and completedAt (or now for running) are valid.
    // Metric: now - startedAt for tasks where status === 'running'.
    // If startedAt is missing, duration is unknown (DO NOT guess from updatedAt).
    let durationSeconds: number | undefined;
    if (startedAt) {
      const start = new Date(startedAt).getTime();
      const end = completedAt ? new Date(completedAt).getTime() : (status === 'running' ? Date.now() : NaN);
      if (!isNaN(start) && !isNaN(end)) {
        durationSeconds = Math.max(0, Math.floor((end - start) / 1000));
      }
    }

    return {
      id: taskId,
      title: statusData.task_label || taskId,
      status,
      currentAgent: this.mapAgentName(statusData.current_agent),
      currentConductor,
      currentStep: statusData.phase,
      workstream: normalizeWorkstream(taskData.workstream),
      updatedAt,
      startedAt,
      completedAt,
      durationSeconds,
      runPath: path.join('runs', taskId),
      errorReason: statusData.error_reason,
      normalizedReason
    };
  }

  private getFallbackSummary(taskId: string): RunSummary {
    return {
      id: taskId,
      title: taskId,
      status: 'unknown',
      workstream: 'general',
      runPath: path.join('runs', taskId)
    };
  }

  private mapStatus(s: string | undefined): RunStatus {
    return mapPhaseToRunStatus(s);
  }

  private mapAgentName(a: string): AgentName {
    if (!a) return 'unknown';
    a = a.toLowerCase();
    const agents: AgentName[] = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam'];
    if (agents.includes(a as AgentName)) return a as AgentName;
    return 'unknown';
  }
}

export const globalScanner = new RunScanner();
