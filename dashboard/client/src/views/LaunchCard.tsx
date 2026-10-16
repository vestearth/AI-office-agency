import { Play } from 'lucide-react';
import type { TaskLaunchResponse } from '../../../shared/types';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { handoffLine } from './startTask';

// Monitor › run detail › Launch: the newest Run on this task, running or finished, with
// what the server did after it (office scripts, agent-commit check, its commit), and the
// newest Open hand-off (D15: the task shows it was opened). Hidden when there is neither
// (or the viewer is not on localhost, where /api/launch answers 403). It re-reads every
// 15 s, so a step started from the Start dialog shows up without a reload, and every 3 s
// while the step is being verified.
export function LaunchCard({ taskId }: { taskId: string }) {
  const { data, launch, busy, stop } = useOfficeLaunch<TaskLaunchResponse>(`/api/launch/task/${encodeURIComponent(taskId)}`, {
    idlePollMs: 15_000, keepPolling: (d) => d.result?.state === 'verifying',
  });
  const handoff = data?.lastHandoff;
  if (!launch && !handoff) return null;
  const result = launch && !isActive(launch) ? data?.result : undefined;
  return (
    <div className="card monitor-section-card launch-card">
      <div className="panel-heading"><Play size={14} /> <span>Launch</span>{launch?.role && <span className="flow-scope">{launch.role}</span>}</div>
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {result && <StepResult result={result} />}
      {handoff && <p className="handoff-help" title={handoff.worktree}>{handoffLine(handoff)}</p>}
    </div>
  );
}
