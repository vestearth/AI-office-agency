import { describe, expect, it } from 'vitest';
import type { SignalGroup } from '../../../shared/types';
import { coverageLine, deployLine, ictTime, relatedLine, reproduceCommand, signalBrief } from './prodSignalsBrief';

const group = (over: Partial<SignalGroup> = {}): SignalGroup => ({
  key: 'k', cluster: 'upslip-production-ecs', product: 'VerifySlip', taskPrefix: 'VS', service: 'slip-api-production',
  logGroup: '/ecs/slip-api-production', signature: 'GET /v1/admin/verifications -> 500 count verifications: timeout',
  failures: 3, logLines: 6, firstAt: '2026-10-15T03:43:00Z', lastAt: '2026-10-15T03:43:00Z', hours: 1, recurring: false,
  sample: 'reports request failed · GET /v1/admin/verifications · 500', searchPhrase: 'count verifications',
  terms: ['/v1/admin/verifications', 'count verifications'], coverage: 'unowned', mentionedBy: [], recursAfter: [], closedRecently: [], related: [], ...over,
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

  it('keeps an earlier closed run as detail when a later owner closed after the last failure (operator decision 2026-10-17)', () => {
    const g = group({
      coverage: 'closed_recently',
      closedRecently: [{ id: 'TASK-VS-040', title: 't', status: 'completed', completedAt: '2026-10-16T21:24:15Z', terms: [] }],
      recursAfter: [{ id: 'TASK-VS-031', title: 't', status: 'completed', completedAt: '2026-10-16T19:19:49Z', terms: [] }],
    });
    expect(coverageLine(g)).toBe('owner closed recently: TASK-VS-040 (closed 10-17 04:24 ICT); no failure after that close yet; still failing after TASK-VS-031 (closed 10-17 02:19 ICT)');
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

describe('deployLine', () => {
  it('names the deployment every failure fell in, and adds it to the brief', () => {
    const w = { service: 'slip-system-production', from: '2026-10-16T07:57:53.006Z', to: '2026-10-16T08:02:24.574Z' };
    const g = group({ coverage: 'recurs_after', failures: 3, deploys: { during: 3, windows: [w] } });
    expect(deployLine(g)).toBe('all 3 failures during 1 deployment (slip-system-production 10-16 14:57–15:02 ICT): likely connections cut by the rollout');
    expect(deployLine(group({ failures: 6, deploys: { during: 4, windows: [w] } }))).toMatch(/^4 of 6 failures during 1 deployment/);
    expect(signalBrief(g, res)).toMatch(/Timing: all 3 failures during 1 deployment/);
    expect(deployLine(group())).toBeNull();
  });
});

describe('relatedLine', () => {
  it('lists path-only runs as related, outside the coverage line (operator decision 2026-10-17)', () => {
    const g = group({
      signature: 'POST /v1/slips/verify -> 502 bank verifier unavailable', terms: ['/v1/slips/verify', 'bank verifier unavailable'],
      coverage: 'mentioned', mentionedBy: [{ id: 'TASK-VS-028', title: 't', status: 'waiting_review', terms: ['bank verifier unavailable'] }],
      related: [{ id: 'TASK-VS-039', title: 't', status: 'waiting_review', terms: ['/v1/slips/verify'] }],
    });
    expect(relatedLine(g)).toBe('related: TASK-VS-039 (matches only /v1/slips/verify)');
    expect(coverageLine(g)).toBe('mentioned by open TASK-VS-028 (bank verifier unavailable)');
    expect(signalBrief(g, res)).toContain('Related (not owners): TASK-VS-039 (matches only /v1/slips/verify)');
    expect(relatedLine(group())).toBeNull();
    expect(signalBrief(group(), res)).not.toContain('Related');
  });
});
