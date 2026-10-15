import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../../../shared/types';
import { filterRuns, normalizeSearch, searchElsewhere } from './monitorList';
import { metadataTag } from './monitorDetail';

const run = (id: string, title: string, status: RunSummary['status']): RunSummary => ({ id, title, status, runPath: `runs/${id}` });
const runs = [
  run('TASK-VS-025', 'Shared closed-day admin aggregates (status counts + bank flows)', 'waiting_review'),
  run('TASK-VS-022', 'Admin bank-flows summary times out at 15s', 'completed'),
  run('TASK-VS-024', 'Bank-flow transfers total from cached summary', 'completed'),
];

describe('Monitor search', () => {
  it('treats hyphens, underscores and spaces alike', () => {
    expect(normalizeSearch(' Bank-flow_Transfers ')).toBe('bank flow transfers');
    expect(filterRuns(runs, { scope: 'all', prefix: null, search: 'bank flow' }).map((r) => r.id)).toEqual(['TASK-VS-025', 'TASK-VS-022', 'TASK-VS-024']);
    expect(filterRuns(runs, { scope: 'all', prefix: null, search: 'bank-flow' }).length).toBe(3);
  });

  it('says how many matches the scope hides', () => {
    expect(filterRuns(runs, { scope: 'active', prefix: null, search: 'bank-flow' }).map((r) => r.id)).toEqual(['TASK-VS-025']);
    expect(searchElsewhere(runs, { scope: 'active', prefix: null, search: 'bank-flow' })).toEqual({ scope: 'finished', count: 2 });
    expect(searchElsewhere(runs, { scope: 'finished', prefix: null, search: 'aggregates' })).toEqual({ scope: 'active', count: 1 });
    expect(searchElsewhere(runs, { scope: 'all', prefix: null, search: 'bank' })).toBeNull();
    expect(searchElsewhere(runs, { scope: 'active', prefix: null, search: '' })).toBeNull();
    expect(searchElsewhere(runs, { scope: 'active', prefix: null, search: 'nothing like this' })).toBeNull();
  });
});

describe('metadataTag', () => {
  it('tags gate, waits_on, carries and non-transition rows; hand-offs stay plain', () => {
    expect(metadataTag('gate deploy_production: absent -> pending')).toBe('gate');
    expect(metadataTag("'gate x: pending -> pass'")).toBe('gate');
    expect(metadataTag('waits_on: +prod_run (TASK-EAR-402)')).toBe('waits');
    expect(metadataTag('carries: +TASK-EAR-396')).toBe('train');
    expect(metadataTag('action')).toBe('note');
    expect(metadataTag('in_review -> debugging')).toBeNull();
    expect(metadataTag('created -> assigned')).toBeNull();
  });
});
