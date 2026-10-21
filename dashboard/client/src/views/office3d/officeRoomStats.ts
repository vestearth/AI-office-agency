import type { FlowPhaseWait } from '../../../../shared/types';
import type { StreamPhase } from '../../dashboardStream';
import { formatAge } from '../formatAge';
import { ZONE_BY_ID, zoneNeedsEye, zoneTone, type Zone, type ZoneStat } from '../commandZones';
import { SCENE } from './officeLook';
import type { OfficeTask, OfficeZoneStats } from './officeSelection';

const EMPTY = { count: 0, attention: false, active: false };

export function oldestWaitDays(zone: Zone, waits: readonly FlowPhaseWait[]): number | null {
  let max: number | null = null;
  const phases = new Set<string>(zone.phases);
  for (const row of waits) {
    if (!phases.has(row.phase) || row.oldestDays == null) continue;
    max = max == null ? row.oldestDays : Math.max(max, row.oldestDays);
  }
  return max;
}

export interface RoomStatLine {
  label: string;
  value: string;
  /** Status color, or null when the line is not a room-status light. */
  tone: string | null;
}

export function roomStatLines(
  zone: Zone,
  stat: ZoneStat<OfficeTask> | undefined,
  waits: readonly FlowPhaseWait[],
  now = Date.now(),
): RoomStatLine[] {
  const current = stat ?? EMPTY;
  const tone = zoneTone(zone, current);
  const oldest = oldestWaitDays(zone, waits);
  const eye = zoneNeedsEye(zone, current);
  const aged = stat?.oldest ? formatAge(stat.oldest, now) : '—';
  const fourth = zone.agent
    ? { label: 'Work', value: current.count === 0 ? '—' : current.active ? 'Agent on it' : 'Queued', tone: current.active ? tone : null }
    : { label: 'Stale', value: aged, tone: null };
  return [
    { label: 'Tasks', value: String(current.count), tone },
    { label: 'Oldest wait', value: oldest == null ? '—' : `${oldest}d`, tone: oldest == null ? null : tone },
    { label: 'Attention', value: eye ? 'Needs a person' : 'Clear', tone: eye ? tone : null },
    fourth,
  ];
}

export function roomStatLinesFor(
  zoneId: string,
  tasks: OfficeTask[],
  stats: OfficeZoneStats | undefined,
  waits: readonly FlowPhaseWait[],
  now = Date.now(),
): RoomStatLine[] {
  const zone = ZONE_BY_ID.get(zoneId);
  if (!zone) return [];
  return roomStatLines(zone, stats?.get(zoneId), waits, now);
}

export function updatedLabel(loadedAt: string | null, now = Date.now()): string {
  if (!loadedAt) return 'Waiting for tasks';
  const age = formatAge(loadedAt, now);
  return age === '0m' ? 'Updated just now' : `Updated ${age} ago`;
}

/** An open stream is fresh even when the last fetch was a while ago. STALE is a failed fetch or a dropped stream. */
export function liveWord(phase: StreamPhase, failed: boolean): 'LIVE' | 'STALE' | 'CONNECTING' {
  if (failed) return 'STALE';
  if (phase === 'connecting') return 'CONNECTING';
  if (phase === 'closed') return 'STALE';
  return 'LIVE';
}

export function liveColor(phase: StreamPhase, failed: boolean): string {
  return phase === 'open' && !failed ? SCENE.live : SCENE.stale;
}
