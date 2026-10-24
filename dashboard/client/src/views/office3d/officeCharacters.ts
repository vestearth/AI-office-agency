import { ZONES, summarizeZones } from '../commandZones';
import { FLOOR_TOP, deskLocalX, type DeskRowMap } from './officeLook';
import { deskZ } from './officeReception';
import { reviewStanding } from './officeReview';
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

export interface CharacterSlot {
  key: string;
  zoneId: string;
  taskId: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  operator: CharacterOperator;
  posture: 'work' | 'blocked';
  /** On their feet beside a box (the Review line) instead of seated at a desk. */
  standing?: boolean;
}

/** Feet on the room slab: the Review line has no chair under the robot. */
export const STAND_Y = FLOOR_TOP;

/** One seated character per drawn desk in work and stuck rooms, and one standing per spot in Review. Done and Aborted stay empty. */
export function characterSlots(tasks: OfficeTask[], stats?: OfficeZoneStats, rows?: DeskRowMap | null): CharacterSlot[] {
  const resolved = stats ?? summarizeZones(tasks);
  const slots: CharacterSlot[] = [];
  for (const zone of ZONES) {
    if (!CHARACTER_KINDS.has(zone.kind)) continue;
    const layout = ROOM_LAYOUT[zone.id];
    if (!layout) continue;
    if (zone.id === 'review') {
      const byId = new Map(tasks.map((item) => [item.taskId, item]));
      for (const spot of reviewStanding(tasks.filter((item) => item.phase != null && zone.phases.includes(item.phase)))) {
        const found = byId.get(spot.taskId);
        if (!found) continue;
        slots.push({
          key: spot.taskId,
          zoneId: zone.id,
          taskId: spot.taskId,
          x: layout.x + spot.x,
          y: STAND_Y,
          z: layout.z + spot.z,
          rotY: FACING_Y,
          operator: characterOperator(found.operator),
          posture: 'work',
          standing: true,
        });
      }
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
  if (reducedMotion) return [{ name: 'sit', timeScale: 0 }];
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

/** Standing clip beside a box. Reduced motion holds a still idle. */
export function standClipCues(reducedMotion: boolean): ClipCue[] {
  return [{ name: 'idle', timeScale: reducedMotion ? 0 : 1 }];
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
