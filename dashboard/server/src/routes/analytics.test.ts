import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FlowInsightsService } from '../services/flowInsights';
import { parseAnalyticsWindowDays } from './analytics';

test('FlowInsightsService reads history only for runs updated inside the window', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-'));
  const write = async (id: string, body: string) => {
    await fs.mkdir(path.join(runsDir, id));
    await fs.writeFile(path.join(runsDir, id, 'status.yaml'), body);
  };
  await write('TASK-001', "history:\n- phase: assigned -> in_review\n  agent: dev\n  at: '2026-10-13T00:00:00Z'\n");
  // Updated long ago: its history must not be read even though the entry claims an in-window date.
  await write('TASK-002', "history:\n- phase: assigned -> in_review\n  agent: reviewer\n  at: '2026-10-13T00:00:00Z'\n");

  const runs = [
    { id: 'TASK-001', title: 'a', status: 'waiting_review', updatedAt: '2026-10-13T00:00:00Z', runPath: 'runs/TASK-001' },
    { id: 'TASK-002', title: 'b', status: 'completed', updatedAt: '2026-08-01T00:00:00Z', runPath: 'runs/TASK-002' },
  ];
  const service = new FlowInsightsService(
    { listRuns: async () => runs } as any,
    { getReviewSummaries: async () => [] } as any,
    runsDir,
    () => new Date('2026-10-14T12:00:00Z'),
  );

  const flow = await service.get(7);
  assert.equal(flow.windowDays, 7);
  assert.equal(flow.stuck.open, 1);
  assert.deepEqual(flow.movers.roles.map((m) => [m.actor, m.transitions]), [['dev', 1]]);
  await fs.rm(runsDir, { recursive: true, force: true });
});

test('parseAnalyticsWindowDays only allows 7, 14, or 30 day windows', () => {
  assert.equal(parseAnalyticsWindowDays(undefined), 7);
  assert.equal(parseAnalyticsWindowDays('7'), 7);
  assert.equal(parseAnalyticsWindowDays('14'), 14);
  assert.equal(parseAnalyticsWindowDays('30'), 30);
  assert.equal(parseAnalyticsWindowDays('9999'), 7);
  assert.equal(parseAnalyticsWindowDays('0'), 7);
  assert.equal(parseAnalyticsWindowDays('abc'), 7);
});
