import { describe, expect, it } from 'vitest';
import type { ReleaseLadderTask, ReleaseRungCell } from '../../../shared/types';
import { proofGroups, proofLabel } from './ladderProof';

const cell = (status: ReleaseRungCell['status']): ReleaseRungCell => ({ status, ran: null, grant: null });
const t = (id: string, over: Partial<ReleaseLadderTask> = {}): ReleaseLadderTask => ({
  id, title: id, status: 'completed', highest: 'staging_acceptance', extra: [], waitingOnProd: true, noProdGates: false, unreadable: null,
  carries: [], carriedBy: [], pendingTrains: [],
  rungs: { implementation_verification: cell('pass'), deploy_staging: cell('pass'), staging_acceptance: cell('pass'), deploy_production: cell('pending'), production_acceptance: cell('pending') },
  ...over,
});

describe('proofGroups', () => {
  it('groups by the trains still due, single trains first; trains themselves and non-waiting tasks are left out', () => {
    const groups = proofGroups([
      t('TASK-EAR-392', { pendingTrains: ['TASK-EAR-402'] }),
      t('TASK-EAR-393', { pendingTrains: ['TASK-EAR-402'] }),
      t('TASK-EAR-396', { pendingTrains: ['TASK-EAR-406'] }),
      t('TASK-EAR-389', { pendingTrains: ['TASK-EAR-406', 'TASK-EAR-402'] }),
      t('TASK-VS-025'),
      t('TASK-EAR-402', { carries: ['TASK-EAR-392'] }),
      t('TASK-EAR-1', { waitingOnProd: false }),
    ]);
    expect(groups.map((g) => [g.key, g.tasks.map((x) => x.id)])).toEqual([
      ['TASK-EAR-402', ['TASK-EAR-392', 'TASK-EAR-393']],
      ['TASK-EAR-406', ['TASK-EAR-396']],
      ['TASK-EAR-402 + TASK-EAR-406', ['TASK-EAR-389']],
      ['own', ['TASK-VS-025']],
    ]);
    expect(groups.map(proofLabel)).toEqual([
      'TASK-EAR-402 would prove 2 tasks',
      'TASK-EAR-406 would prove 1 task',
      '1 task needs every one of TASK-EAR-402 and TASK-EAR-406',
      '1 task waits on their own production gate',
    ]);
  });
});
