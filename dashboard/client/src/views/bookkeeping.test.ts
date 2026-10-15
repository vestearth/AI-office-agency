import { describe, expect, it } from 'vitest';
import type { ReleaseLadderTask, ReleaseRungCell, ReviewSummary } from '../../../shared/types';
import { bookkeepingGaps, openTrains } from './bookkeeping';

const review = (taskId: string, over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  taskId, title: `${taskId} title`, phase: 'blocked', verdict: null, inReviewQueue: false, verdictNeedsAttention: false,
  needsReview: false, requiresAction: true, actionKind: 'workflow_exception', actionReason: null, recommendedAction: null,
  decisionPending: false, statusUpdatedAt: null, lastReviewedAt: null, confidence: null,
  issueCounts: { error: 0, warning: 0, suggestion: 0 }, riskLevel: 'none', latestDecision: null, idle: null, lastTransition: null,
  waitsOn: [], isReleaseTrain: false, ...over,
});
const cell = (status: ReleaseRungCell['status']): ReleaseRungCell => ({ status, ran: null, grant: null });
const ladder = (id: string, over: Partial<ReleaseLadderTask> = {}): ReleaseLadderTask => ({
  id, title: `${id} title`, status: 'completed', highest: 'staging_acceptance', extra: [], waitingOnProd: false, noProdGates: false, unreadable: null,
  carries: [], carriedBy: [], pendingTrains: [],
  rungs: { implementation_verification: cell('pass'), deploy_staging: cell('pass'), staging_acceptance: cell('pass'), deploy_production: cell('absent'), production_acceptance: cell('absent') },
  ...over,
});
const index = (...tasks: ReleaseLadderTask[]) => new Map(tasks.map((t) => [t.id, t]));

describe('bookkeepingGaps', () => {
  it('flags a blocked task with no waits_on, not one that records it or is not blocked', () => {
    const gaps = bookkeepingGaps([
      review('TASK-EAR-500'),
      review('TASK-EAR-501', { waitsOn: [{ kind: 'qa' }] }),
      review('TASK-EAR-502', { phase: 'in_review' }),
    ], null);
    expect(gaps.map((g) => [g.kind, g.taskId])).toEqual([['no_waits_on', 'TASK-EAR-500']]);
    expect(gaps[0]!.command).toBe('ruby scripts/update-waits-on.rb TASK-EAR-500 add <kind> [--ref TASK-…] --actor <you> --reason "<why>"');
  });

  it('flags a staging-accepted task no train carries, naming the open trains of its product', () => {
    const idx = index(
      ladder('TASK-EAR-510', { noProdGates: true }),
      ladder('TASK-EAR-402', { status: 'blocked', carries: ['TASK-EAR-1'] }),
      ladder('TASK-EAR-406', { status: 'running', carries: ['TASK-EAR-2'] }),
      ladder('TASK-EAR-363', { status: 'cancelled', carries: ['TASK-EAR-3'] }),
      ladder('TASK-VS-030', { noProdGates: true }),
      ladder('TASK-EAR-511', { noProdGates: false }),
    );
    const gaps = bookkeepingGaps([], idx);
    expect(gaps.map((g) => [g.taskId, g.trains.map((t) => t.id)])).toEqual([
      ['TASK-EAR-510', ['TASK-EAR-402', 'TASK-EAR-406']],
      ['TASK-VS-030', []],
    ]);
    expect(gaps[0]!.command).toBe('ruby scripts/update-train-carries.rb <TRAIN> add TASK-EAR-510 --actor <you> --reason "<why>"');
    expect(gaps[1]!.command).toMatch(/^\.\/run-agent\.sh open <TRAIN_ID> .*--preset train$/);
  });

  it('names the train in the command when exactly one is open', () => {
    const idx = index(ladder('TASK-EAR-510', { noProdGates: true }), ladder('TASK-EAR-402', { status: 'blocked', carries: ['TASK-EAR-1'] }));
    expect(bookkeepingGaps([], idx)[0]!.command).toBe('ruby scripts/update-train-carries.rb TASK-EAR-402 add TASK-EAR-510 --actor <you> --reason "<why>"');
    expect(openTrains(idx, 'VS')).toEqual([]);
  });
});
