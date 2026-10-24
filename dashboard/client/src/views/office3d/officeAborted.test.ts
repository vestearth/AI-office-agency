import { describe, expect, it } from 'vitest';
import { ZONE_BY_ID, summarizeZones } from '../commandZones';
import { ROOM_D } from './officeLook';
import { DECOR_PLACEMENTS } from './officeDecor';
import { buildOfficePoses } from './officeLayout';
import { loungeLightAllowed } from './officeLounge';
import {
  ABORTED,
  ABORTED_COLORS,
  BOARD_REASON_CHARS,
  HEAP_CAP,
  HEAP_PIECE_HEIGHT,
  abortedBoard,
  boardReason,
  heapPieceCount,
  heapSlots,
} from './officeAborted';
import { officeTasksFromApi, type OfficeTask } from './officeSelection';

const aborted = (taskId: string, at: string | null, over: Partial<OfficeTask> = {}): OfficeTask => ({
  taskId,
  title: taskId,
  phase: 'aborted',
  status: 'cancelled',
  needsReview: false,
  updatedAt: '2026-10-16',
  lastTransition: { agent: 'pm', phase: 'dev -> aborted', reason: `reason for ${taskId}`, at },
  ...over,
});

describe('heap size', () => {
  it('follows min(36, ceil(3.6 * sqrt(N)))', () => {
    expect(HEAP_CAP).toBe(36);
    expect(heapPieceCount(0)).toBe(0);
    expect(heapPieceCount(1)).toBe(4);
    expect(heapPieceCount(21)).toBe(17);
    expect(heapPieceCount(50)).toBe(26);
    expect(heapPieceCount(100)).toBe(36);
    expect(heapPieceCount(5000)).toBe(36);
    expect(heapPieceCount(-3)).toBe(0);
    expect(heapPieceCount(Number.NaN)).toBe(0);
  });

  it('lays out exactly that many pieces and only adds pieces as it grows', () => {
    const small = heapSlots(17);
    const big = heapSlots(26);
    expect(small).toHaveLength(17);
    expect(big).toHaveLength(26);
    expect(heapSlots(HEAP_CAP + 20)).toHaveLength(HEAP_CAP);
    expect(big.slice(0, 17)).toEqual(small);
  });

  it('spreads from the back-left corner toward the middle', () => {
    const full = heapSlots(HEAP_CAP);
    const first = full[0];
    expect(first.x).toBeLessThan(-1.2);
    expect(first.z).toBeLessThan(-0.9);
    const reach = (count: number) => Math.max(...heapSlots(count).map((slot) => slot.x));
    expect(reach(36)).toBeGreaterThan(reach(8));
  });

  it('mixes boxes, bags and papers once it is big enough', () => {
    const kinds = new Set(heapSlots(HEAP_CAP).map((slot) => slot.kind));
    expect(kinds).toEqual(new Set(['boxClosed', 'boxOpen', 'bags', 'papers']));
  });

  const countKinds = (pieces: number) => {
    const counts = { box: 0, bags: 0, papers: 0 };
    for (const slot of heapSlots(pieces)) {
      if (slot.kind === 'bags') counts.bags += 1;
      else if (slot.kind === 'papers') counts.papers += 1;
      else counts.box += 1;
    }
    return counts;
  };

  it('is already a mixed heap at today\'s 17 pieces (21 aborted tasks): boxes, bags and papers', () => {
    expect(heapPieceCount(21)).toBe(17);
    const counts = countKinds(17);
    expect(counts.bags).toBeGreaterThanOrEqual(3);
    expect(counts.papers).toBeGreaterThanOrEqual(3);
    expect(counts.box).toBeGreaterThanOrEqual(8);
  });

  it('stays mixed at every size from 8 pieces up, with boxes still the bulk', () => {
    for (const pieces of [8, 17, 26, 36]) {
      const counts = countKinds(pieces);
      expect(counts.bags, `bags at ${pieces}`).toBeGreaterThanOrEqual(1);
      expect(counts.papers, `papers at ${pieces}`).toBeGreaterThanOrEqual(1);
      expect(counts.box, `boxes at ${pieces}`).toBeGreaterThan(counts.bags + counts.papers);
    }
  });

  it('rests every piece on the one below it, whatever that piece is', () => {
    const slots = heapSlots(HEAP_CAP);
    slots.forEach((slot, index) => {
      const below = slots.slice(0, index).filter((other) => Math.hypot(other.x - slot.x, other.z - slot.z) < 0.1);
      const top = below.reduce((height, other) => Math.max(height, other.y + HEAP_PIECE_HEIGHT[other.kind]), 0);
      expect(slot.y).toBeCloseTo(top, 5);
    });
  });
});

describe('heap clearance', () => {
  const full = heapSlots(HEAP_CAP);
  const ROBOT_R = 0.27;
  const reachOf = (slot: (typeof full)[number]) => slot.r;

  it('keeps the largest heap inside the room, off the door lane and off the crates', () => {
    for (const slot of full) {
      expect(slot.x - reachOf(slot)).toBeGreaterThan(-2.1);
      expect(slot.z - reachOf(slot)).toBeGreaterThan(-1.7);
      for (const crate of ABORTED.crates) {
        expect(Math.hypot(slot.x - crate.x, slot.z - crate.z)).toBeGreaterThan(reachOf(slot) + 0.3);
      }
    }
  });

  it('leaves each of the three drop spots free of heap pieces at the largest size', () => {
    expect(ABORTED.dropSpots).toHaveLength(3);
    for (const spot of ABORTED.dropSpots) {
      for (const slot of full) {
        expect(Math.hypot(slot.x - spot.x, slot.z - spot.z)).toBeGreaterThan(reachOf(slot) + ROBOT_R);
      }
    }
  });

  it('keeps the route from the door to every drop spot clear of heap pieces and crates', () => {
    const door = { x: 0, z: ROOM_D / 2 };
    const lane = ABORTED.dropSpots[0].z;
    for (const spot of ABORTED.dropSpots) {
      const route = [door, { x: 0, z: lane }, spot];
      for (let leg = 1; leg < route.length; leg += 1) {
        const a = route[leg - 1];
        const b = route[leg];
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05);
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          for (const slot of full) expect(Math.hypot(slot.x - x, slot.z - z)).toBeGreaterThan(reachOf(slot) + ROBOT_R);
          for (const crate of ABORTED.crates) expect(Math.hypot(crate.x - x, crate.z - z)).toBeGreaterThan(0.35 + ROBOT_R);
        }
      }
    }
  });

  it('spaces the drop spots wider than a body so three robots do not overlap', () => {
    const xs = ABORTED.dropSpots.map((spot) => spot.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThan(0.6);
    expect(xs[2] - xs[1]).toBeGreaterThan(0.6);
  });
});

describe('board readout', () => {
  const tasks = [
    aborted('TASK-VS-030', '2026-10-16T20:02:49Z', { updatedAt: '2026-10-16' }),
    aborted('TASK-EAR-415', '2026-10-17T01:49:24Z', { updatedAt: '2026-10-16' }),
    aborted('TASK-OLD', '2026-10-01T00:00:00Z', { updatedAt: '2026-10-01' }),
    { taskId: 'TASK-DEV', title: 'x', phase: 'assigned', status: 'running', needsReview: false } as OfficeTask,
  ];

  it('counts every aborted task and names the latest one by its closing transition', () => {
    const board = abortedBoard(tasks);
    expect(board.count).toBe(3);
    expect(board.latestId).toBe('TASK-EAR-415');
    expect(board.reason).toBe('reason for TASK-EAR-415');
  });

  it('shows the reason as written, only for a transition into aborted', () => {
    const written = 'Operator decision 2026-10-17: superseded by TASK-VS-040.';
    expect(abortedBoard([aborted('A', '2026-10-17T00:00:00Z', {
      lastTransition: { agent: 'pm', phase: 'review -> aborted', reason: written, at: '2026-10-17T00:00:00Z' },
    })]).reason).toBe(written);
    const wrong = abortedBoard([aborted('B', '2026-10-17T00:00:00Z', {
      lastTransition: { agent: 'pm', phase: 'dev -> review', reason: 'an older, unrelated reason', at: '2026-10-17T00:00:00Z' },
    })]);
    expect(wrong.latestId).toBe('B');
    expect(wrong.reason).toBeNull();
    const none = abortedBoard([aborted('C', null, { lastTransition: null })]);
    expect(none.reason).toBeNull();
    const blank = abortedBoard([aborted('D', '2026-10-17T00:00:00Z', {
      lastTransition: { agent: 'pm', phase: 'dev -> aborted', reason: null, at: '2026-10-17T00:00:00Z' },
    })]);
    expect(blank.reason).toBeNull();
  });

  it('is empty without aborted tasks', () => {
    expect(abortedBoard([])).toEqual({ count: 0, latestId: null, reason: null });
  });

  it('cuts a long reason to two lines and ends with an ellipsis', () => {
    expect(BOARD_REASON_CHARS).toBe(90);
    const long = 'Operator-approved throwaway smoke test of the dashboard New task flow, kept only to prove the form submits and then discarded';
    const cut = boardReason(long);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(BOARD_REASON_CHARS + 1);
    expect(long.startsWith(cut.slice(0, -1).trimEnd())).toBe(true);
    const exact = 'x'.repeat(BOARD_REASON_CHARS);
    expect(boardReason(exact)).toBe(exact);
    expect(boardReason('short reason')).toBe('short reason');
    expect(boardReason('line one\n  line two')).toBe('line one line two');
  });
});

describe('aborted room furniture', () => {
  const stats = (count: number) => {
    const list = Array.from({ length: count }, (_, index) => aborted(`TASK-AB-${index}`, '2026-10-17T00:00:00Z'));
    return { list, stats: summarizeZones(list) };
  };

  it('draws no desks, chairs or screens, however many tasks it holds', () => {
    const { list, stats: zoneStats } = stats(21);
    const poses = buildOfficePoses(list, zoneStats, null, null);
    for (const group of [poses.desk, poses.chair, poses.screenOn, poses.screenOff, poses.lamp]) {
      expect(group.filter((pose) => pose.zoneId === 'aborted')).toHaveLength(0);
    }
    const empty = buildOfficePoses([], summarizeZones<OfficeTask>([]), null, null);
    expect(empty.desk.filter((pose) => pose.zoneId === 'aborted')).toHaveLength(0);
  });

  it('swaps the old desks, bookcase and open boxes for the crates', () => {
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'aborted').map((item) => item.file);
    expect(files).not.toContain('bookcaseClosedWide');
    expect(files).not.toContain('cardboardBoxOpen');
    expect(files.filter((file) => file === 'crate')).toHaveLength(ABORTED.crates.length);
    expect(ABORTED.crates.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every new color out of the status palette', () => {
    for (const color of Object.values(ABORTED_COLORS)) expect(loungeLightAllowed(color)).toBe(true);
  });

  it('is a terminal zone and keeps the Done room untouched', () => {
    expect(ZONE_BY_ID.get('aborted')?.kind).toBe('terminal');
    expect(DECOR_PLACEMENTS.filter((item) => item.zoneId === 'done')).toHaveLength(6);
  });
});

describe('office tasks carry the closing transition', () => {
  it('keeps lastTransition and statusUpdatedAt from the review read model', () => {
    const lastTransition = { agent: 'pm' as const, phase: 'dev -> aborted', reason: 'why', at: '2026-10-17T01:49:24Z' };
    const [task] = officeTasksFromApi(
      [{ taskId: 'T', title: 'T', phase: 'aborted', needsReview: false, lastTransition, statusUpdatedAt: '2026-10-17' }],
      [],
    );
    expect(task.lastTransition).toEqual(lastTransition);
    expect(task.statusUpdatedAt).toBe('2026-10-17');
  });
});
