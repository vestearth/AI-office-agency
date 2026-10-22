import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZONE_COLORS } from '../commandZones';
import { DESK_Z, SCENE } from './officeLook';
import {
  BODY_COLOR,
  CHARACTER_OPERATORS,
  CURSOR_EAR_TILT,
  EMOTE_NO_TIMESCALE,
  FACING_Y,
  INTERACT_TIMESCALE,
  LIMB_COLOR,
  OPERATOR_VISOR,
  SEAT_Y,
  SLOT_Z_OFFSET,
  UNKNOWN_VISOR_GAIN,
  VISOR_GAIN,
  characterOperator,
  characterSlots,
  seatClipCues,
  visorGain,
} from './officeCharacters';
import { ROOM_LAYOUT, SCENE_DESK_LIMIT, desksForZone, sceneDesks, type OfficeTask } from './officeSelection';

const task = (over: Partial<OfficeTask> & Pick<OfficeTask, 'taskId' | 'phase' | 'status'>): OfficeTask => ({
  title: over.taskId,
  needsReview: false,
  ...over,
});

const WORK_AND_STUCK = ['inbox', 'review', 'escalation', 'devops', 'dev', 'debug', 'blocked', 'rejected'];
const PHASE_BY_ZONE: Record<string, OfficeTask['phase']> = {
  inbox: 'pending',
  review: 'review',
  escalation: 'escalated',
  devops: 'devops_needed',
  dev: 'assigned',
  debug: 'debugging',
  blocked: 'blocked',
  rejected: 'validation_failed',
  done: 'done',
  aborted: 'aborted',
};

describe('character operators', () => {
  it('maps each tool and folds legacy gemini into antigravity', () => {
    expect(characterOperator('claude')).toBe('claude');
    expect(characterOperator('Codex')).toBe('codex');
    expect(characterOperator('cursor')).toBe('cursor');
    expect(characterOperator('antigravity')).toBe('antigravity');
    expect(characterOperator('gemini')).toBe('antigravity');
    expect(characterOperator('GEMINI')).toBe('antigravity');
    expect(characterOperator('copilot')).toBe('copilot');
  });

  it('treats missing and non-tool actors as unknown', () => {
    for (const raw of [undefined, null, '', 'user', 'orchestrator', 'dev', 'done']) {
      expect(characterOperator(raw)).toBe('unknown');
    }
  });
});

describe('character palette', () => {
  const taken = new Set([...Object.values(ZONE_COLORS), SCENE.neonSpur].map((color) => color.toLowerCase()));

  it('stays off the zone colors and the neon purple', () => {
    for (const [name, color] of Object.entries(OPERATOR_VISOR)) {
      expect(taken.has(color.toLowerCase()), name).toBe(false);
    }
    expect(taken.has(BODY_COLOR.toLowerCase())).toBe(false);
    expect(taken.has(LIMB_COLOR.toLowerCase())).toBe(false);
    expect(OPERATOR_VISOR.unknown).toBe('#3a414b');
    expect(visorGain('unknown')).toBe(UNKNOWN_VISOR_GAIN);
    expect(visorGain('claude')).toBe(VISOR_GAIN);
    expect(VISOR_GAIN).toBe(1.6);
    expect(CURSOR_EAR_TILT).toBeCloseTo(0.35);
    expect(CHARACTER_OPERATORS).toEqual(['claude', 'codex', 'cursor', 'antigravity', 'copilot', 'unknown']);
  });
});

describe('character slots', () => {
  it('seats work and stuck rooms only, capped at four, with none in Done or Aborted', () => {
    const tasks: OfficeTask[] = [
      task({ taskId: 'IN', phase: 'pending', status: 'queued', operator: 'claude' }),
      task({ taskId: 'DONE', phase: 'done', status: 'completed', operator: 'codex' }),
      task({ taskId: 'ABORT', phase: 'aborted', status: 'cancelled', operator: 'cursor' }),
      task({ taskId: 'BLK', phase: 'blocked', status: 'blocked', operator: 'gemini' }),
      task({ taskId: 'VAL', phase: 'validation_failed', status: 'failed', operator: 'someone' }),
      ...Array.from({ length: SCENE_DESK_LIMIT + 1 }, (_, index) => task({
        taskId: `DEV-${index}`,
        phase: 'assigned',
        status: 'running',
        updatedAt: `2026-10-1${index}T00:00:00Z`,
      })),
    ];
    const slots = characterSlots(tasks);
    expect(new Set(slots.map((slot) => slot.zoneId))).toEqual(new Set(['inbox', 'dev', 'blocked', 'rejected']));
    expect(slots.some((slot) => slot.zoneId === 'done' || slot.zoneId === 'aborted')).toBe(false);
    expect(slots.filter((slot) => slot.zoneId === 'dev')).toHaveLength(SCENE_DESK_LIMIT);
    const drawn = sceneDesks(desksForZone('dev', tasks)).map((desk) => desk.taskId);
    expect(slots.filter((slot) => slot.zoneId === 'dev').map((slot) => slot.taskId)).toEqual(drawn);
    expect(slots.find((slot) => slot.taskId === 'BLK')).toMatchObject({ operator: 'antigravity', posture: 'blocked' });
    expect(slots.find((slot) => slot.taskId === 'VAL')?.operator).toBe('unknown');
    expect(slots.find((slot) => slot.taskId === 'IN')?.posture).toBe('work');
    const inbox = slots.find((slot) => slot.taskId === 'IN');
    expect(inbox?.x).toBeCloseTo(ROOM_LAYOUT.inbox.x);
    expect(inbox?.y).toBeCloseTo(SEAT_Y);
    expect(inbox?.z).toBeCloseTo(ROOM_LAYOUT.inbox.z + DESK_Z + SLOT_Z_OFFSET);
    expect(inbox?.rotY).toBe(FACING_Y);
  });

  it('stops at 32 characters when every drawn desk is full', () => {
    const tasks: OfficeTask[] = [];
    for (const zoneId of [...WORK_AND_STUCK, 'done', 'aborted']) {
      for (let index = 0; index < SCENE_DESK_LIMIT + 1; index += 1) {
        tasks.push(task({
          taskId: `${zoneId}-${index}`,
          phase: PHASE_BY_ZONE[zoneId],
          status: zoneId === 'done' ? 'completed' : zoneId === 'aborted' ? 'cancelled' : 'running',
          operator: CHARACTER_OPERATORS[index % CHARACTER_OPERATORS.length],
        }));
      }
    }
    const slots = characterSlots(tasks);
    expect(slots).toHaveLength(WORK_AND_STUCK.length * SCENE_DESK_LIMIT);
    expect(slots.every((slot) => WORK_AND_STUCK.includes(slot.zoneId))).toBe(true);
    expect(slots.filter((slot) => slot.posture === 'blocked').every((slot) => slot.zoneId === 'blocked' || slot.zoneId === 'rejected')).toBe(true);
  });
});

describe('seat clips', () => {
  it('loops sit with the room clip, and reduced motion holds a still sit', () => {
    expect(seatClipCues('work', false)).toEqual([
      { name: 'sit', timeScale: 1 },
      { name: 'interact-right', timeScale: INTERACT_TIMESCALE },
    ]);
    expect(INTERACT_TIMESCALE).toBeCloseTo(1.6);
    expect(seatClipCues('blocked', false)).toEqual([
      { name: 'sit', timeScale: 1 },
      { name: 'emote-no', timeScale: EMOTE_NO_TIMESCALE },
    ]);
    expect(EMOTE_NO_TIMESCALE).toBeCloseTo(0.45);
    expect(seatClipCues('work', true)).toEqual([{ name: 'sit', timeScale: 0 }]);
    expect(seatClipCues('blocked', true).map((cue) => cue.name)).toEqual(['sit']);
    expect(seatClipCues('blocked', true).some((cue) => cue.name === 'emote-no' || cue.timeScale !== 0)).toBe(false);
  });
});

describe('character asset', () => {
  it('ships the Blocky rig and texture under the 150 KB cap, with the CC0 notice', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/office3d');
    const glb = fs.statSync(path.join(dir, 'character-a.glb')).size;
    const texture = fs.statSync(path.join(dir, 'Textures/texture-a.png')).size;
    expect(glb + texture).toBeLessThanOrEqual(150 * 1024);
    const blocky = fs.readFileSync(path.join(dir, 'License-blocky.txt'), 'utf8');
    const furniture = fs.readFileSync(path.join(dir, 'License.txt'), 'utf8');
    expect(blocky).toContain('Blocky Characters');
    expect(blocky).toContain('CC0');
    expect(furniture).toContain('Furniture Kit');
  });
});
