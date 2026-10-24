import { ZONES, summarizeZones } from '../commandZones';
import { FLOOR_TOP, deskLocalX, type DeskRowMap } from './officeLook';
import { deskZ } from './officeReception';
import { BLOCKED, blockedSeating } from './officeBlocked';
import { ESCALATION, escalationSeating } from './officeEscalation';
import { REVIEW_LINE_CAP, REVIEW_SPOT_CAP, reviewStanding } from './officeReview';
import { SCENE_DESK_LIMIT } from './officeSelection';
import { characterOperator, type CharacterOperator } from './officeOperator';
import {
  ROOM_LAYOUT,
  desksForZone,
  sceneDesks,
  type OfficeTask,
  type OfficeZoneStats,
} from './officeSelection';

export type { CharacterOperator } from './officeOperator';

/** Palette c. Unknown stays unlit so it does not bloom. */

export const OPERATOR_VISOR: Record<CharacterOperator, string> = {
  claude: '#ff4fd8',
  codex: '#f2f5ff',
  cursor: '#6e7bff',
  antigravity: '#b8ff4a',
  copilot: '#c3a6ff',
  unknown: '#3a414b',
};

export const VISOR_GAIN = 1.6;
export const UNKNOWN_VISOR_GAIN = 1;
export const CURSOR_EAR_TILT = 0.35;
export const BODY_COLOR = '#4a5361';
export const LIMB_COLOR = '#2f363f';
export const CHARACTER_HEIGHT = 0.9;
export const SEAT_Y = FLOOR_TOP + 0.36;
export const SLOT_Z_OFFSET = 0.5;
export const FACING_Y = Math.PI;
export const INTERACT_TIMESCALE = 1.6;
export const EMOTE_NO_TIMESCALE = 0.45;

const CHARACTER_KINDS = new Set(['work', 'stuck']);

export function visorGain(operator: CharacterOperator): number {
  return operator === 'unknown' ? UNKNOWN_VISOR_GAIN : VISOR_GAIN;
}

/** Standing places in Review: the line, two at each of the four decided places, and the side. */
export const REVIEW_SPOT_COUNT = REVIEW_LINE_CAP + 4 * REVIEW_SPOT_CAP + REVIEW_SPOT_CAP;
/** Inbox, DevOps, Dev Bay, Debug Lab and Val.Failed seat `SCENE_DESK_LIMIT` at desks. */
const DESK_ROOM_COUNT = 5;
/**
 * Robots at rest when every spot of every room is taken: desk rooms, the waiting room's chairs and
 * bench, the help desk (desk, bench, standing) and the Review line, decided places and side spots.
 */
export const SEATED_CAP = DESK_ROOM_COUNT * SCENE_DESK_LIMIT
  + BLOCKED.chairs.length + BLOCKED.bench.length
  + 1 + ESCALATION.bench.length + ESCALATION.stand.length
  + REVIEW_SPOT_COUNT;
/** A few more cover robots walking in or out while every spot is taken. */
export const ARRIVAL_SLACK = 8;
export const MAX_ACTORS = SEATED_CAP + ARRIVAL_SLACK;

export interface CharacterSlot {
  key: string;
  zoneId: string;
  taskId: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  operator: CharacterOperator;
  /** `waiting` sits still (no typing loop), `standing` stands upright beside the help desk. */
  posture: 'work' | 'blocked' | 'waiting' | 'standing';
  /** Whether the robot sits or stands at this spot. */
  stance: 'sit' | 'stand';
}

/** The waiting room seats its own robots: the Earth queue on the chairs, the others on the bench. */
function blockedSlots(tasks: OfficeTask[], layout: { x: number; z: number }): CharacterSlot[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seating = blockedSeating(tasks);
  const seats = [
    ...seating.chairs.map((taskId, index) => ({ taskId, spot: BLOCKED.chairs[index] })),
    ...seating.bench.map((taskId, index) => ({ taskId, spot: BLOCKED.bench[index] })),
  ];
  return seats.flatMap(({ taskId, spot }) => {
    const task = byId.get(taskId);
    if (!task) return [];
    return [{
      key: taskId,
      zoneId: 'blocked',
      taskId,
      x: layout.x + spot.x,
      y: SEAT_Y,
      z: layout.z + spot.z + BLOCKED.seatOffsetZ,
      rotY: FACING_Y,
      operator: characterOperator(task.operator),
      posture: 'blocked' as const,
      stance: 'sit' as const,
    }];
  });
}

/** The inspection line stands its robots beside their boxes, facing the belt (and the idle clip). */
function reviewSlots(tasks: OfficeTask[], layout: { x: number; z: number }): CharacterSlot[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const inRoom = tasks.filter((task) => task.phase === 'review' || task.phase === 'in_review');
  return reviewStanding(inRoom).flatMap((spot) => {
    const task = byId.get(spot.taskId);
    if (!task) return [];
    return [{
      key: spot.taskId,
      zoneId: 'review',
      taskId: spot.taskId,
      x: layout.x + spot.x,
      y: FLOOR_TOP,
      z: layout.z + spot.z,
      rotY: FACING_Y,
      operator: characterOperator(task.operator),
      posture: 'standing' as const,
      stance: 'stand' as const,
    }];
  });
}

/**
 * The help desk seats its own robots: the longest wait at the desk facing Earth's chair, the next two
 * on the bench, hand-offs standing beside the desk. Robots sit still because they are waiting.
 */
function escalationSlots(tasks: OfficeTask[], layout: { x: number; z: number }): CharacterSlot[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seating = escalationSeating(tasks);
  const spots = [
    ...(seating.desk ? [{ taskId: seating.desk, x: ESCALATION.seat.x, z: ESCALATION.seat.z, rotY: 0, stance: 'sit' as const }] : []),
    ...seating.bench.map((taskId, index) => ({
      taskId,
      x: ESCALATION.bench[index].x,
      z: ESCALATION.bench[index].z + ESCALATION.seatOffsetZ,
      rotY: FACING_Y,
      stance: 'sit' as const,
    })),
    ...seating.standing.map((taskId, index) => ({
      taskId,
      x: ESCALATION.stand[index].x,
      z: ESCALATION.stand[index].z,
      rotY: Math.PI / 2,
      stance: 'stand' as const,
    })),
  ];
  return spots.flatMap(({ taskId, x, z, rotY, stance }) => {
    const task = byId.get(taskId);
    if (!task) return [];
    return [{
      key: taskId,
      zoneId: 'escalation',
      taskId,
      x: layout.x + x,
      y: stance === 'sit' ? SEAT_Y : FLOOR_TOP,
      z: layout.z + z,
      rotY,
      operator: characterOperator(task.operator),
      posture: stance === 'sit' ? 'waiting' as const : 'standing' as const,
      stance,
    }];
  });
}

/** One seated character per drawn desk in work and stuck rooms. Done and Aborted stay empty. */
export function characterSlots(tasks: OfficeTask[], stats?: OfficeZoneStats, rows?: DeskRowMap | null): CharacterSlot[] {
  const resolved = stats ?? summarizeZones(tasks);
  const slots: CharacterSlot[] = [];
  for (const zone of ZONES) {
    if (!CHARACTER_KINDS.has(zone.kind)) continue;
    const layout = ROOM_LAYOUT[zone.id];
    if (!layout) continue;
    if (zone.id === 'blocked') {
      slots.push(...blockedSlots(tasks, layout));
      continue;
    }
    if (zone.id === 'escalation') {
      slots.push(...escalationSlots(tasks, layout));
      continue;
    }
    if (zone.id === 'review') {
      slots.push(...reviewSlots(tasks, layout));
      continue;
    }
    const live = sceneDesks(desksForZone(zone.id, tasks, resolved)).filter((desk) => desk.taskId && desk.task);
    const row = rows?.[zone.id];
    const placed = row
      ? row.flatMap((slot) => {
          const desk = live.find((item) => item.taskId === slot.taskId);
          if (!desk?.task || !desk.taskId) return [];
          return [{ desk, localX: slot.localX }];
        })
      : live.map((desk, index) => ({ desk, localX: deskLocalX(index, live.length) }));
    for (const { desk, localX } of placed) {
      if (!desk.task || !desk.taskId) continue;
      slots.push({
        key: desk.taskId,
        zoneId: zone.id,
        taskId: desk.taskId,
        x: layout.x + localX,
        y: SEAT_Y,
        z: layout.z + deskZ(zone.id) + SLOT_Z_OFFSET,
        rotY: FACING_Y,
        operator: characterOperator(desk.task.operator),
        posture: zone.kind === 'stuck' ? 'blocked' : 'work',
        stance: 'sit',
      });
    }
  }
  return slots;
}

export interface ClipCue {
  name: string;
  timeScale: number;
}

/** Seated clips. Reduced motion is a frozen sit: no interact loop and no emote. */
export function seatClipCues(posture: CharacterSlot['posture'], reducedMotion: boolean): ClipCue[] {
  if (posture === 'standing') return [{ name: 'idle', timeScale: reducedMotion ? 0 : 1 }];
  if (reducedMotion) return [{ name: 'sit', timeScale: 0 }];
  if (posture === 'waiting') return [{ name: 'sit', timeScale: 1 }];
  if (posture === 'blocked') {
    return [
      { name: 'sit', timeScale: 1 },
      { name: 'emote-no', timeScale: EMOTE_NO_TIMESCALE },
    ];
  }
  return [
    { name: 'sit', timeScale: 1 },
    { name: 'interact-right', timeScale: INTERACT_TIMESCALE },
  ];
}

/** Drop cues whose clip is not in the asset. A missing clip is a static pose, never a throw. */
export function resolveClipCues(cues: readonly ClipCue[], available: readonly string[]): ClipCue[] {
  const have = new Set(available);
  return cues.filter((cue) => have.has(cue.name));
}

/** Sprint falls back to walk. Neither clip means the pose stays still while the root still moves. */
export function resolveGaitClip(gait: 'walk' | 'sprint', available: readonly string[]): string | null {
  const have = new Set(available);
  if (gait === 'sprint' && have.has('sprint')) return 'sprint';
  if (have.has('walk')) return 'walk';
  return null;
}

export function resolveNamedClip(name: string, available: readonly string[]): string | null {
  return available.includes(name) ? name : null;
}
