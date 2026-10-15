import { describe, expect, it } from 'vitest';
import type { ReleaseLadderTask, ReleaseRungCell } from '../../../shared/types';
import { isAssignedOnly, runStatusClass, runStatusLabel } from '../../../shared/statusLabels';
import { prodLine } from './ReleaseCard';

const cell = (status: ReleaseRungCell['status'], via?: string): ReleaseRungCell => ({ status, ran: null, grant: null, ...(via ? { via } : {}) });
const task = (over: Partial<ReleaseLadderTask['rungs']>, highest: ReleaseLadderTask['highest'] = 'staging_acceptance'): ReleaseLadderTask => ({
  id: 'TASK-EAR-396', title: 't', status: 'completed', highest, extra: [], waitingOnProd: false, noProdGates: false, unreadable: null,
  carries: [], carriedBy: [],
  rungs: {
    implementation_verification: cell('pass'), deploy_staging: cell('pass'), staging_acceptance: cell('pass'),
    deploy_production: cell('absent'), production_acceptance: cell('absent'), ...over,
  },
});

describe('run status label', () => {
  it('reads "Assigned" only for a running run still in the assigned phase', () => {
    expect(runStatusLabel('running', 'assigned')).toBe('Assigned');
    expect(runStatusLabel('running', 'assigned_parallel')).toBe('Assigned');
    expect(runStatusLabel('running', 'in_development')).toBe('In progress');
    expect(runStatusLabel('blocked', 'assigned')).toBe('Blocked');
    expect(runStatusClass('running', 'assigned')).toBe('status-running status-assigned');
    expect(runStatusClass('waiting_review', 'in_review')).toBe('status-waiting_review');
    expect(isAssignedOnly('running', undefined)).toBe(false);
  });
});

describe('prodLine', () => {
  it('names the prod rung and the train it waits on', () => {
    expect(prodLine(task({ deploy_production: cell('pending', 'TASK-EAR-406'), production_acceptance: cell('pending', 'TASK-EAR-406') })))
      .toBe('Prod deployed: pending via TASK-EAR-406');
    expect(prodLine(task({ deploy_production: cell('pass', 'TASK-EAR-402'), production_acceptance: cell('pass', 'TASK-EAR-402') }, 'production_acceptance')))
      .toBe('Prod accepted: pass via TASK-EAR-402');
    expect(prodLine(task({}))).toBe('Staging accepted');
    expect(prodLine(undefined)).toBe('not on the ladder');
  });
});
