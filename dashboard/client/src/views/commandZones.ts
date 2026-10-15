import { isAssignedOnly } from '../../../shared/statusLabels';
import type { AgentName, RunPhase, RunStatus } from '../../../shared/types';

// Phase zones on the Command Center office map (public/office-bg.webp).
// `left`/`top` place the pin and `room` the glow ellipse, all in percent of the
// image itself — the map stage keeps the image's aspect ratio, so they stay put.

export const ZONE_COLORS = { cyan: '#22d3ee', green: '#22c55e', amber: '#f59e0b', red: '#ef4444', gray: '#5b6776' };
const C = ZONE_COLORS;

export const OFFICE_ASPECT = 1672 / 941;

// work: an agent owns the zone. stuck: work waiting on something outside the
// flow (its `alert` color shows whenever it holds tasks). terminal: finished.
export type ZoneKind = 'work' | 'stuck' | 'terminal';

export interface Zone {
  id: string;
  label: string;
  phases: RunPhase[];
  agent: AgentName | null;
  kind: ZoneKind;
  alert?: string;
  left: number;
  top: number;
  room: { x: number; y: number; w: number; h: number };
}

export const ZONES: Zone[] = [
  { id: 'inbox', label: 'Inbox', phases: ['pending'], agent: 'pm', kind: 'work', left: 12, top: 30, room: { x: 14, y: 40, w: 24, h: 34 } },
  { id: 'review', label: 'Review', phases: ['review', 'in_review'], agent: 'reviewer', kind: 'work', left: 35, top: 17, room: { x: 36, y: 29, w: 22, h: 32 } },
  { id: 'escalation', label: 'Escalation', phases: ['escalated', 'free_roam_complete'], agent: 'free-roam', kind: 'work', left: 50, top: 6, room: { x: 51, y: 13, w: 16, h: 24 } },
  { id: 'devops', label: 'DevOps', phases: ['devops_needed', 'devops_complete'], agent: 'devops', kind: 'work', left: 68, top: 8, room: { x: 66, y: 20, w: 18, h: 30 } },
  { id: 'dev', label: 'Dev Bay', phases: ['assigned', 'assigned_parallel'], agent: 'dev', kind: 'work', left: 20, top: 50, room: { x: 26, y: 62, w: 28, h: 36 } },
  { id: 'done', label: 'Done', phases: ['done'], agent: null, kind: 'terminal', left: 52, top: 26, room: { x: 52, y: 44, w: 24, h: 36 } },
  { id: 'debug', label: 'Debug Lab', phases: ['debugging', 'debugging_complete'], agent: 'debugger', kind: 'work', left: 86, top: 31, room: { x: 86, y: 48, w: 28, h: 46 } },
  { id: 'blocked', label: 'Blocked', phases: ['blocked'], agent: null, kind: 'stuck', alert: C.amber, left: 37, top: 79, room: { x: 37, y: 74, w: 14, h: 18 } },
  { id: 'rejected', label: 'Val.Failed', phases: ['validation_failed'], agent: null, kind: 'stuck', alert: C.red, left: 71, top: 64, room: { x: 71, y: 62, w: 14, h: 18 } },
  { id: 'aborted', label: 'Aborted', phases: ['aborted'], agent: null, kind: 'terminal', left: 54, top: 64, room: { x: 54, y: 80, w: 24, h: 30 } },
];

export const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));
export const PHASE_TO_ZONE = new Map<string, string>();
for (const z of ZONES) for (const p of z.phases) PHASE_TO_ZONE.set(p, z.id);

export interface ZoneTask {
  taskId: string;
  phase: RunPhase | null;
  status: RunStatus;
  needsReview: boolean;
  currentAgent?: AgentName;
  updatedAt?: string;
}

export interface ZoneStat<T extends ZoneTask = ZoneTask> {
  count: number;
  attention: boolean;
  active: boolean;
  /** Earliest updatedAt in the zone: how long the stalest task has sat untouched. */
  oldest?: string;
  tasks: T[];
}

export function summarizeZones<T extends ZoneTask>(tasks: T[]): Map<string, ZoneStat<T>> {
  const m = new Map<string, ZoneStat<T>>();
  for (const t of tasks) {
    const id = (t.phase && PHASE_TO_ZONE.get(t.phase)) || null;
    if (!id) continue;
    const zone = ZONE_BY_ID.get(id)!;
    const cur = m.get(id) || { count: 0, attention: false, active: false, tasks: [] };
    cur.count++;
    cur.tasks.push(t);
    if (t.needsReview || t.status === 'failed') cur.attention = true;
    // An assigned run nobody started is queued, not "agent on it" (it reads "Assigned").
    if (zone.agent && t.currentAgent === zone.agent && !isAssignedOnly(t.status, t.phase)) cur.active = true;
    if (t.updatedAt && (!cur.oldest || t.updatedAt < cur.oldest)) cur.oldest = t.updatedAt;
    m.set(id, cur);
  }
  return m;
}

export function zoneTone(zone: Zone, st: Pick<ZoneStat, 'count' | 'attention' | 'active'>): string {
  if (!st.count || zone.kind === 'terminal') return C.gray;
  if (zone.kind === 'stuck') return zone.alert || C.amber;
  if (st.attention) return C.amber;
  if (st.active) return C.cyan;
  return C.green;
}

/** Whether the zone's dot should pulse: something there is waiting on a human. */
export function zoneNeedsEye(zone: Zone, st: Pick<ZoneStat, 'count' | 'attention'>): boolean {
  if (!st.count || zone.kind === 'terminal') return false;
  return zone.kind === 'stuck' || st.attention;
}

/** Hover preview rows: open zones lead with what needs a human, then the stalest;
 *  terminal zones show the most recently finished. */
export function zonePreview<T extends ZoneTask>(zone: Zone, tasks: T[], limit = 3): T[] {
  const urgent = (t: T) => (t.needsReview || t.status === 'failed' ? 0 : 1);
  const at = (t: T) => t.updatedAt || '';
  const sorted = [...tasks].sort(zone.kind === 'terminal'
    ? (a, b) => at(b).localeCompare(at(a))
    : (a, b) => urgent(a) - urgent(b) || at(a).localeCompare(at(b)));
  return sorted.slice(0, limit);
}
