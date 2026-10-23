import { ZONE_COLORS } from '../commandZones';
import { SCENE } from './officeLook';
import { ROOM_LAYOUT } from './officeSelection';

/** Same zone the Insights throughput uses. status.yaml days are office-local. */
export const OFFICE_TZ = 'Asia/Bangkok';
export const PILE_CAP = 12;
/** Warm white. Saturation stays under 0.15, so it is not a status color. */
export const LOUNGE_LIGHT = '#f3ecdf';
/**
 * Well under an attention room (level 1) and under an idle work room (0.7).
 * The near-white spot crosses the bloom threshold when the camera is close,
 * so the level stays low enough that the floor stays gray and the furniture
 * and a seated robot still read.
 */
export const LOUNGE_LIGHT_LEVEL = 0.05 as const;
/** Floor lamp. Kept under the bloom threshold so the shade does not wash the room. */
export const LOUNGE_LAMP_EMISSIVE = 0.05;
/** Latest-task box. A hint of glow, not a second spotlight. */
export const LOUNGE_BOX_EMISSIVE = 0.08;
/** How long a delivered robot stays seated before it disappears. */
export const SIT_SECONDS = 4;

/**
 * Room-local lounge layout. The sofa faces the door (+z). The TV sits on the
 * left wall facing into the room. Three seats: sofa, ottoman, lounge chair.
 */
export const LOUNGE = {
  sofa: { x: 0, y: 0, z: -1.28, rotY: 0, scale: 1.2 },
  chair: { x: 1.15, y: 0, z: -0.72, rotY: -0.7, scale: 1.1 },
  ottoman: { x: -1, y: 0, z: -0.58, rotY: 0.25, scale: 1.1 },
  table: { x: 0.05, y: 0, z: -0.28, rotY: 0, scale: 1.15 },
  tv: { x: -1.62, y: 0, z: 0.2, rotY: -Math.PI / 2, scale: 1.15 },
  lamp: { x: 1.42, y: 0, z: -1.15, rotY: 0, scale: 1.15 },
  pile: { x: 1.28, z: 1.02 },
  seats: [
    { x: 0, z: -1.05 },
    { x: -1, z: -0.42 },
    { x: 1.15, z: -0.48 },
  ],
} as const;

export const LOUNGE_SEAT_COUNT = LOUNGE.seats.length;

export interface LoungeFlow {
  throughput: { days: readonly { date: string; closed: number }[] };
}

export interface LoungeReadout {
  /** Null when the flow fetch failed. Zero is a real empty day. */
  closed: number | null;
  label: string;
  recentIds: string[];
  tableTaskId: string | null;
  pile: number;
  lit: boolean;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormats.set(timeZone, format);
  }
  return format;
}

/** "YYYY-MM-DD" in the office time zone. */
export function officeLocalDay(now: Date, timeZone = OFFICE_TZ): string {
  return dayFormat(timeZone).format(now);
}

/** Milliseconds until the next office-local midnight, at least 1. */
export function msUntilNextLocalMidnight(now: Date, timeZone = OFFICE_TZ): number {
  const day = officeLocalDay(now, timeZone);
  let lo = now.getTime();
  let hi = lo + 36 * 60 * 60 * 1000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (officeLocalDay(new Date(mid), timeZone) === day) lo = mid;
    else hi = mid;
  }
  return Math.max(1, hi - now.getTime());
}

/**
 * TV, coffee-table box, pile and light. A null flow does not guess: the TV
 * shows "–", the pile stays empty, and the room stays dark. The latest ids
 * still come from the Done list, which is ordered newest first.
 */
export function loungeReadout(
  flow: LoungeFlow | null,
  doneIdsNewestFirst: readonly string[],
  now: Date,
  timeZone = OFFICE_TZ,
): LoungeReadout {
  const recentIds = doneIdsNewestFirst.slice(0, 3);
  const tableTaskId = doneIdsNewestFirst[0] ?? null;
  if (!flow) {
    return { closed: null, label: '–', recentIds, tableTaskId, pile: 0, lit: false };
  }
  const day = officeLocalDay(now, timeZone);
  const closed = flow.throughput.days.find((entry) => entry.date === day)?.closed ?? 0;
  return {
    closed,
    label: String(closed),
    recentIds,
    tableTaskId,
    pile: Math.min(PILE_CAP, Math.max(0, closed)),
    lit: closed > 0,
  };
}

/** World position of a lounge seat. Seats are stored in Done-room local space. */
export function loungeSeatWorld(index: number): { x: number; z: number } {
  const seat = LOUNGE.seats[index];
  const layout = ROOM_LAYOUT.done;
  return { x: layout.x + (seat?.x ?? 0), z: layout.z + (seat?.z ?? 0) };
}

/** One slot per box, three to a layer, capped. Offsets are pile-local. */
export function pileSlots(count: number): { x: number; y: number; z: number; rotY: number }[] {
  const total = Math.max(0, Math.min(PILE_CAP, Math.floor(count)));
  const slots: { x: number; y: number; z: number; rotY: number }[] = [];
  for (let index = 0; index < total; index += 1) {
    const layer = Math.floor(index / 3);
    const column = index % 3;
    slots.push({
      x: (column - 1) * 0.42,
      y: layer * 0.38,
      z: (column % 2) * 0.08,
      rotY: (column - 1) * 0.18,
    });
  }
  return slots;
}

const HUE_GAP = 30;
const NEAR_WHITE_SATURATION = 0.15;

function hsv(hex: string): { h: number; s: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  const s = max === 0 ? 0 : span / max;
  if (span === 0) return { h: 0, s };
  let h = 0;
  if (max === r) h = ((g - b) / span) % 6;
  else if (max === g) h = (b - r) / span + 2;
  else h = (r - g) / span + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s };
}

function hueGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
}

/** Hue at least 30° from every zone tone and the neon purple, or saturation under 0.15. */
export function loungeLightAllowed(hex: string): boolean {
  const color = hsv(hex);
  const forbidden = [...Object.values(ZONE_COLORS), SCENE.neonSpur];
  return forbidden.every((other) => color.s < NEAR_WHITE_SATURATION || hueGap(color.h, hsv(other).h) >= HUE_GAP);
}
