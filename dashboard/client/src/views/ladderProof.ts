import type { ReleaseLadderTask } from '../../../shared/types';

// Insights › Readiness: which production run would prove which tasks. Two trains
// promote differently (TASK-EAR-402: ECS prod, cost-gated; TASK-EAR-406: backoffice
// merge to k3s), so "one production run" is grouped per train. Trains themselves
// are the run, not proven by it.

export interface ProofGroup {
  key: string;
  /** Trains that must all pass; empty = the task's own production gate. */
  trains: string[];
  tasks: ReleaseLadderTask[];
}

export function proofGroups(tasks: ReleaseLadderTask[]): ProofGroup[] {
  const groups = new Map<string, ProofGroup>();
  for (const t of tasks) {
    if (!t.waitingOnProd || t.carries.length > 0) continue;
    const trains = [...t.pendingTrains].sort();
    const key = trains.join(' + ') || 'own';
    const g = groups.get(key) ?? { key, trains, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  }
  const rank = (g: ProofGroup) => (g.trains.length === 1 ? 0 : g.trains.length > 1 ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.tasks.length - a.tasks.length || a.key.localeCompare(b.key));
}

export function proofLabel(g: ProofGroup): string {
  const n = `${g.tasks.length} task${g.tasks.length === 1 ? '' : 's'}`;
  if (g.trains.length === 1) return `${g.trains[0]} would prove ${n}`;
  if (g.trains.length > 1) return `${n} need${g.tasks.length === 1 ? 's' : ''} every one of ${g.trains.join(' and ')}`;
  return `${n} wait${g.tasks.length === 1 ? 's' : ''} on their own production gate`;
}
