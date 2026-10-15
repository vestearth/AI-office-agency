import { describe, expect, it } from 'vitest';
import type { SignalGroup } from '../../../shared/types';
import { coverageLine, ictTime, reproduceCommand, signalBrief } from './prodSignalsBrief';

const group = (over: Partial<SignalGroup> = {}): SignalGroup => ({
  key: 'k', cluster: 'upslip-production-ecs', product: 'VerifySlip', taskPrefix: 'VS', service: 'slip-api-production',
  logGroup: '/ecs/slip-api-production', signature: 'GET /v1/admin/verifications -> 500 count verifications: timeout',
  failures: 3, logLines: 6, firstAt: '2026-10-15T03:43:00Z', lastAt: '2026-10-15T03:43:00Z', hours: 1, recurring: false,
  sample: 'reports request failed · GET /v1/admin/verifications · 500', searchPhrase: 'count verifications',
  terms: ['/v1/admin/verifications', 'count verifications'], coverage: 'unowned', mentionedBy: [], recursAfter: [], closedRecently: [], ...over,
});
const res = { awsProfile: 'vestearth', region: 'ap-southeast-1', windowHours: 24, env: 'prod' as const };

describe('prodSignalsBrief', () => {
  it('prints Bangkok time', () => {
    expect(ictTime('2026-10-15T03:43:00Z')).toBe('10-15 10:43');
  });

  it('describes each coverage state', () => {
    expect(coverageLine(group())).toMatch(/^unowned/);
    expect(coverageLine(group({ coverage: 'mentioned', mentionedBy: [{ id: 'TASK-VS-026', title: 't', status: 'running', terms: ['count verifications'] }] })))
      .toBe('mentioned by open TASK-VS-026 (count verifications)');
    expect(coverageLine(group({ coverage: 'recurs_after', recursAfter: [{ id: 'TASK-VS-021', title: 't', status: 'completed', completedAt: '2026-10-14T05:15:00Z', terms: [] }] })))
      .toBe('recurs after closed TASK-VS-021 (closed 10-14 12:15 ICT)');
    expect(coverageLine(group({ coverage: 'recurs_after', recursAfter: [{ id: 'TASK-VS-020', title: 't', status: 'completed', completedAt: '2026-10-14', terms: [] }] })))
      .toBe('recurs after closed TASK-VS-020 (closed 10-14)');
    expect(coverageLine(group({ coverage: 'closed_recently', closedRecently: [{ id: 'TASK-VS-027', title: 't', status: 'completed', completedAt: '2026-10-15', terms: [] }] })))
      .toBe('owner closed recently: TASK-VS-027 (closed 10-15); no failure after that close yet');
  });

  it('quotes the phrase for the CloudWatch filter and asks Claude to open the run', () => {
    expect(reproduceCommand(group({ searchPhrase: 'say "hi"' }), res)).toContain(`--filter-pattern '"say  hi"'`);
    const brief = signalBrief(group(), res);
    expect(brief).toContain('Failures: 3 unique (6 log lines) in the last 24h');
    expect(brief).toContain('--profile vestearth --region ap-southeast-1 --log-group-name /ecs/slip-api-production');
    expect(brief).toContain('TASK-VS run (Claude opens it)');
    const partial = signalBrief(group({ partialSince: '2026-10-15T09:00:00Z' }), res);
    expect(partial).toContain('Failures: at least 3 unique');
    expect(partial).toContain('read back to 10-15 16:00 ICT only');
  });
});
