import { describe, expect, it } from 'vitest';
import type { ReleaseLadderTask } from '../../../shared/types';
import { rungProgress } from './releaseProgress';

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
