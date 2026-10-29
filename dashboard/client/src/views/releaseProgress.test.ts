import { describe, expect, it } from 'vitest';
import type { GateEntry, GateView, ReleaseLadderTask } from '../../../shared/types';
import { gateRungProgress, isComplete, rungProgress } from './releaseProgress';

const cell = (status: string) => ({ status }) as ReleaseLadderTask['rungs'][keyof ReleaseLadderTask['rungs']];
const task = (highest: ReleaseLadderTask['highest'], statuses: string[]): ReleaseLadderTask => ({
  highest,
  rungs: Object.fromEntries(['implementation_verification', 'deploy_staging', 'staging_acceptance', 'deploy_production', 'production_acceptance']
    .map((r, i) => [r, cell(statuses[i] ?? 'absent')])),
}) as unknown as ReleaseLadderTask;

describe('rungProgress', () => {
  it('names the highest rung and the next pending one', () => {
    expect(rungProgress(task('deploy_production', ['pass', 'pass', 'pass', 'pass', 'pending']))).toBe('Prod deployed · next: Prod accepted');
  });
  it('skips rungs the task does not declare', () => {
    expect(rungProgress(task('staging_acceptance', ['absent', 'absent', 'pass', 'pending', 'pending']))).toBe('Staging accepted · next: Prod deployed');
  });
  it('reads fully proven and not-started tasks', () => {
    expect(rungProgress(task('production_acceptance', ['pass', 'pass', 'pass', 'pass', 'pass']))).toBe('Prod accepted');
    expect(rungProgress(task(null, ['pending']))).toBe('no rung passed · next: Verified');
  });
});

describe('isComplete', () => {
  const withStatus = (status: string, statuses: string[], extra: { name: string; status: string }[] = []) =>
    ({ ...task(null, statuses), status, extra }) as unknown as ReleaseLadderTask;
  it('counts production-accepted tasks and done tasks whose declared gates all passed', () => {
    expect(isComplete(withStatus('running', ['pass', 'pass', 'pass', 'pass', 'pass']))).toBe(true);
    // VS-032: a test-only fix declaring only implementation_verification.
    expect(isComplete(withStatus('completed', ['pass']))).toBe(true);
  });
  it('keeps open work and done tasks with a pending gate out', () => {
    expect(isComplete(withStatus('running', ['pass']))).toBe(false);
    expect(isComplete(withStatus('completed', ['pass', 'pass', 'pass', 'pending', 'pending']))).toBe(false);
    expect(isComplete(withStatus('completed', ['pass'], [{ name: 'shared_lib_publication', status: 'pending' }]))).toBe(false);
  });
});

describe('gateRungProgress', () => {
  const g = (name: string, status: string) => ({ name, status }) as GateEntry;
  const view = (gates: GateEntry[]) => ({ readable: true, problem: null, finishedPhase: null, ledgerReadable: true, summary: { total: gates.length, resolved: 0, passable: 0, byStatus: {} }, gates }) as GateView;
  it('reads the ladder from the task gates, so the detail header is not left with a stale hand-off note', () => {
    // 2026-10-17: TASK-VS-028's last note said "Not merged; deploy slip-api first" while its gates had passed deploy_production.
    expect(gateRungProgress(view([g('implementation_verification', 'pass'), g('deploy_staging', 'pass'), g('staging_acceptance', 'pass'), g('deploy_production', 'pass'), g('production_acceptance', 'pending')])))
      .toBe('Prod deployed · next: Prod accepted');
    expect(gateRungProgress(view([g('implementation_verification', 'pending'), g('deploy_staging', 'pending')]))).toBe('no rung passed · next: Verified');
    expect(gateRungProgress(view([g('implementation_verification', 'pass'), g('authenticated_staging', 'pass'), g('deploy_production', 'pending')])))
      .toBe('Staging accepted · next: Prod deployed');
  });
  it('says nothing without ladder gates or when gates are unreadable', () => {
    expect(gateRungProgress(view([g('shared_lib_publication', 'pass')]))).toBeNull();
    expect(gateRungProgress({ ...view([g('deploy_staging', 'pass')]), readable: false })).toBeNull();
  });
});
