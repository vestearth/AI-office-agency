import { describe, expect, it } from 'vitest';
import type { ReviewSummary } from '../../../shared/types';
import { isShellCommand, waitGroups } from './ReviewView';
import { summarizeZones, zoneTone, ZONE_BY_ID } from './commandZones';

const action = (taskId: string, over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  taskId, title: taskId, phase: null, verdict: null, inReviewQueue: false, verdictNeedsAttention: false,
  needsReview: false, requiresAction: true, actionKind: 'workflow_exception', actionReason: null, recommendedAction: null,
  decisionPending: false, statusUpdatedAt: null, lastReviewedAt: null, confidence: null,
  issueCounts: { error: 0, warning: 0, suggestion: 0 }, riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null,
  debugRounds: 0, debugEntry: null, waitsOn: [], isReleaseTrain: false, ...over,
});

describe('waitGroups', () => {
  it('drops a train waiting on its own run, keeps a train waiting on another train', () => {
    const groups = waitGroups([
      action('TASK-EAR-402', { isReleaseTrain: true, waitsOn: [{ kind: 'prod_run' }] }),
      action('TASK-EAR-406', { isReleaseTrain: true, waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }, { kind: 'operator_approval' }] }),
      action('TASK-EAR-368', { waitsOn: [{ kind: 'prod_run' }] }),
      action('TASK-EAR-391', { waitsOn: [{ kind: 'prod_run', ref: 'TASK-EAR-402' }] }),
    ]);
    expect(groups.map((g) => [g.kind, g.ref, g.tasks.map((t) => t.taskId)])).toEqual([
      ['prod_run', 'TASK-EAR-402', ['TASK-EAR-406', 'TASK-EAR-391']],
      ['prod_run', null, ['TASK-EAR-368']],
      ['operator_approval', null, ['TASK-EAR-406']],
    ]);
  });
});

describe('isShellCommand', () => {
  it('recognises the grant command, not prose', () => {
    expect(isShellCommand('ruby scripts/record-authorization.rb TASK-EAR-406 grant --action deploy_production')).toBe(true);
    expect(isShellCommand('./run-agent.sh status TASK-EAR-406')).toBe(true);
    expect(isShellCommand('Review the evidence and record a decision.')).toBe(false);
    expect(isShellCommand('Resolve the recorded blocker before dispatching another role.')).toBe(false);
  });
});

describe('Dev Bay tone', () => {
  it('assigned-only runs are queued (green), not "agent on it" (cyan)', () => {
    const dev = ZONE_BY_ID.get('dev')!;
    const assigned = summarizeZones([{ taskId: 'TASK-EAR-406', phase: 'assigned', status: 'running', needsReview: false, currentAgent: 'dev' }]).get('dev')!;
    expect(assigned.active).toBe(false);
    const working = summarizeZones([{ taskId: 'TASK-X-1', phase: 'assigned', status: 'running', needsReview: false, currentAgent: 'dev' }]);
    expect(zoneTone(dev, assigned)).not.toBe(zoneTone(dev, { ...working.get('dev')!, active: true }));
  });
});
