import { PHASE_TO_ZONE, ZONE_BY_ID } from '../commandZones';
import { boardReason } from './officeAborted';
import { byWait, timeOf } from './officeBlocked';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';

/** Seats of the help desk: one at the desk, two on the bench, two standing spots for hand-offs. */
export const DESK_SEATS = 1;
export const BENCH_SEATS = 2;
export const STAND_SPOTS = 2;

/**
 * Room-local layout of the help desk, +z is the open front. The robot sits on the far side of the
 * desk and faces Earth's empty chair on the near side. The bench is front left and the standing spots
 * are on the left, because the camera looks from the right and the right wall hides anything near it. Numbers are meters from the room centre.
 */
export const ESCALATION = {
  desk: { x: 0, z: -0.35, scale: 1.3, top: 0.44 },
  rug: { x: 0, z: -0.3, w: 2.9, d: 2.0, h: 0.02 },
  /** Where the desk robot sits (feet), and the chairs under it. */
  seat: { x: 0, z: -0.89 },
  farChair: { x: 0, z: -0.85 },
  earthChair: { x: 0, z: 0.15 },
  screen: { x: -0.28, z: -0.5, rotY: 0, scale: 1.1 },
  lamp: { x: 0.4, z: -0.52, scale: 1.1 },
  phone: { x: -0.3, z: -0.06, w: 0.11, h: 0.045, d: 0.15 },
  button: { x: 0.38, z: -0.1, r: 0.05, h: 0.035 },
  /** Where a robot stands to press the call button. */
  press: { x: 0.48, z: 0.28 },
  bench: [
    { x: -1.4, z: 1.3 },
    { x: -0.7, z: 1.3 },
  ],
  benchFrame: { x: -1.05, z: 1.3, stretch: [3.4, 1.7, 2.5] as const },
  /** The robot sits this far behind its bench spot, the way a desk robot does. */
  seatOffsetZ: 0.04,
  stand: [
    { x: -1.45, z: -0.2 },
    { x: -1.45, z: -0.9 },
  ],
  /**
   * Walking lanes. The desk robot goes round the right of the desk, turning at `turnZ`, level with the
   * call button. Standing robots cross at `leftZ` between Earth's chair and the bench, then go up the
   * left side at `leftX`. A bench robot steps forward to `frontZ`.
   */
  lane: { x: 0.85, turnZ: 0.28, frontZ: 1.62, leftX: -1.25, leftZ: 0.8 },
  board: { x: -2.04, y: 0.62, z: -0.3, w: 0.06, h: 0.56, d: 1.1 },
  cabinet: { x: -1.1, z: -1.48 },
  bookcase: { x: 1.0, z: -1.5 },
  floorLamp: { x: -1.88, z: -1.45 },
  plant: { x: 1.85, z: -1.45 },
  beacon: { x: 0, y: 0.88, z: -1.58 },
} as const;

/** Warm white (saturation 0.1). Never a status color, so it does not read as an amber or red alarm. */
export const BEACON_COLOR = '#fff6e6';
/** Radians per second. A slow sweep; reduced motion holds it still. */
export const BEACON_SPEED = 0.9;
/** The bench robot's feet: the same 0.04 behind the cushion the waiting room uses. */
const SPOT_REACH = 0.14;

/** About a second at the call button, the existing interact clip. */
export const PRESS_SECONDS = 0.8;

export const HANDOFF_TEXT = 'free-roam done · waiting for handoff';
const DAY_MS = 86_400_000;
const ARROW = /^\s*(\S+)\s*->\s*(\S+)\s*$/;

export interface EscalationSeating {
  /** The escalated task that has waited longest. */
  desk: string | null;
  /** The next escalated tasks by wait. */
  bench: string[];
  /** Free-roam-complete tasks by wait. */
  standing: string[];
}

function ordered(tasks: readonly OfficeTask[], phase: string): OfficeTask[] {
  return tasks
    .filter((item) => item.phase === phase)
    .map((item) => ({ item, at: timeOf(item) }))
    .sort((a, b) => byWait({ at: a.at, taskId: a.item.taskId }, { at: b.at, taskId: b.item.taskId }))
    .map(({ item }) => item);
}

/**
 * Who sits where. A task past its spots has no robot but stays listed. Order depends only on
 * `statusUpdatedAt` and the task id, never on the clock, so a robot never re-seats because time passed.
 */
export function escalationSeating(tasks: readonly OfficeTask[]): EscalationSeating {
  const open = ordered(tasks, 'escalated').map((item) => item.taskId);
  const handoff = ordered(tasks, 'free_roam_complete').map((item) => item.taskId);
  return {
    desk: open[0] ?? null,
    bench: open.slice(DESK_SEATS, DESK_SEATS + BENCH_SEATS),
    standing: handoff.slice(0, STAND_SPOTS),
  };
}

/** The beacon is lit while at least one task is escalated. A room with only hand-offs keeps it off. */
export function beaconLit(tasks: readonly OfficeTask[]): boolean {
  return tasks.some((item) => item.phase === 'escalated');
}

/** Which kind of spot a world position is, or null. Used to route a robot to the right seat. */
export function escalationSpotOf(point: { x: number; z: number }): 'desk' | 'bench' | 'stand' | null {
  const layout = ROOM_LAYOUT.escalation;
  const x = point.x - layout.x;
  const z = point.z - layout.z;
  const near = (spot: { x: number; z: number }, dz = 0) => Math.hypot(x - spot.x, z - (spot.z + dz)) < SPOT_REACH;
  if (near(ESCALATION.seat)) return 'desk';
  if (ESCALATION.bench.some((spot) => near(spot, ESCALATION.seatOffsetZ))) return 'bench';
  if (ESCALATION.stand.some((spot) => near(spot))) return 'stand';
  return null;
}

export interface EscalationLine {
  taskId: string;
  title: string;
  kind: 'escalated' | 'handoff';
  /** "Dev Bay · dev-2", "from Review · escalated by earth", or null when the origin is not known. */
  from: string | null;
  /** The reason as written, cut to two readout lines. A hand-off carries its fixed text. */
  reason: string | null;
  /** "reason" for a transition into the room, "latest note" for one inside it. */
  reasonLabel: 'reason' | 'latest note' | null;
  /** Whole days since the last status change, or null when the date is missing. */
  days: number | null;
}

export interface EscalationCardModel {
  heading: 'Escalated' | 'Free-roam done';
  from: string | null;
  /** The full reason, whitespace folded. */
  reason: string | null;
  reasonLabel: 'reason' | 'latest note' | null;
  days: number | null;
}

interface Origin {
  from: string | null;
  reason: string | null;
  reasonLabel: 'reason' | 'latest note' | null;
}

function roomLabel(phase: string): string | null {
  const roomId = PHASE_TO_ZONE.get(phase);
  return roomId ? ZONE_BY_ID.get(roomId)?.label ?? null : null;
}

function clean(text: string | null | undefined): string | null {
  const folded = (text ?? '').replace(/\s+/g, ' ').trim();
  return folded === '' ? null : folded;
}

/** True when Earth's Escalate button put the task here, from structured fields only. */
function escalatedByEarth(item: OfficeTask): boolean {
  const transition = item.lastTransition;
  const decision = item.latestDecision;
  if (!transition || !decision) return false;
  if (transition.agent !== 'orchestrator' || decision.decision !== 'escalate' || item.decisionPending !== false) return false;
  const decidedAt = Date.parse(decision.decidedAt);
  const movedAt = transition.at ? Date.parse(transition.at) : NaN;
  return Number.isFinite(decidedAt) && Number.isFinite(movedAt) && decidedAt <= movedAt;
}

/**
 * Where an escalated task came from and why, read from the structured `lastTransition` only. Nothing
 * is shown unless that transition is the one into the task's current phase, so the room never shows an
 * older, unrelated reason. A move inside the room keeps its text but calls it the latest note.
 */
function originOf(item: OfficeTask): Origin {
  const transition = item.lastTransition;
  const match = transition ? ARROW.exec(transition.phase) : null;
  if (!transition || !match || match[2] !== item.phase) return { from: null, reason: null, reasonLabel: null };
  const fromPhase = match[1];
  const inside = PHASE_TO_ZONE.get(fromPhase) === 'escalation';
  if (inside) {
    const note = clean(transition.reason);
    return { from: null, reason: note, reasonLabel: note ? 'latest note' : null };
  }
  const room = roomLabel(fromPhase);
  if (escalatedByEarth(item)) {
    const actor = item.latestDecision!.actor;
    const note = clean(item.latestDecision!.note);
    return {
      from: room ? `from ${room} · escalated by ${actor}` : `escalated by ${actor}`,
      reason: note,
      reasonLabel: note ? 'reason' : null,
    };
  }
  const role = clean(transition.agent);
  const reason = clean(transition.reason);
  return {
    from: [room, role].filter(Boolean).join(' · ') || null,
    reason,
    reasonLabel: reason ? 'reason' : null,
  };
}

function daysSince(item: OfficeTask, now: number): number | null {
  const at = timeOf(item);
  return at === null ? null : Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** One line per task in the room: escalated tasks first, then hand-offs, each longest wait first. */
export function escalationLines(tasks: readonly OfficeTask[], now: number): EscalationLine[] {
  const escalated = ordered(tasks, 'escalated').map((item): EscalationLine => {
    const origin = originOf(item);
    return {
      taskId: item.taskId,
      title: item.title,
      kind: 'escalated',
      from: origin.from,
      reason: origin.reason === null ? null : boardReason(origin.reason),
      reasonLabel: origin.reasonLabel,
      days: daysSince(item, now),
    };
  });
  const handoff = ordered(tasks, 'free_roam_complete').map((item): EscalationLine => ({
    taskId: item.taskId,
    title: item.title,
    kind: 'handoff',
    from: null,
    reason: HANDOFF_TEXT,
    reasonLabel: null,
    days: daysSince(item, now),
  }));
  return [...escalated, ...handoff];
}

/** What the selection card adds for a task in this room, or null for a task elsewhere. */
export function escalationCard(item: OfficeTask, now: number): EscalationCardModel | null {
  if (item.phase === 'free_roam_complete') {
    return { heading: 'Free-roam done', from: null, reason: HANDOFF_TEXT, reasonLabel: null, days: daysSince(item, now) };
  }
  if (item.phase !== 'escalated') return null;
  const origin = originOf(item);
  return { heading: 'Escalated', from: origin.from, reason: origin.reason, reasonLabel: origin.reasonLabel, days: daysSince(item, now) };
}
